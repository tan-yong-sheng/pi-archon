import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ARCHON_PILL_DEFAULT, DEFAULT_QUERY, PROGRESS_UPDATE_MS } from "./constants";
import type {
	ArchonRunResult,
	ArchonToolUpdate,
	CommandWorkflowOutcome,
	WorkflowName,
} from "./types";
import {
	emitArchonMessage,
	formatElapsed,
	normalizeError,
	normalizeString,
	toPillLabel,
} from "./helpers";
import { redactSecrets, safeCode, LogEvent, tryParseDagEvent } from "./output-filter";
import { ProgressBox } from "./ui/progress-box";
import {
	cancelArchonWorkflowRun,
	findActiveWorkflowRunId,
} from "./handlers/manage-runtime";
import {
	runArchonCommand,
	runArchonCommandStreaming,
	formatArchonOutput,
	formatArchonToolResult,
} from "./archon-exec";

// ─── Error output formatting ──────────────────────────────

export function formatCommandErrorOutput(
	workflow: WorkflowName,
	query: string,
	error: string,
): string {
	return `## Archon ${workflow.toUpperCase()} — ${redactSecrets(query)}

- **Result:** ❌ failed before completion

\`\`\`text
${safeCode(error)}
\`\`\`
`;
}

// ─── Direct workflow execution ──────────────────────────────

async function runArchonWorkflow(
	pi: ExtensionAPI,
	workflow: WorkflowName,
	query: string,
	projectCwd: string,
	signal?: AbortSignal,
): Promise<ArchonRunResult> {
	return runArchonCommand(
		pi,
		["workflow", "run", workflow, query.trim(), "--no-worktree"],
		projectCwd,
		signal,
	);
}

async function runArchonWorkflowStreaming(
	workflow: WorkflowName,
	query: string,
	projectCwd: string,
	signal: AbortSignal | undefined,
	onLine?: (line: string, isErr: boolean) => void,
): Promise<ArchonRunResult> {
	return runArchonCommandStreaming(
		["workflow", "run", workflow, query.trim(), "--no-worktree"],
		projectCwd,
		signal,
		onLine,
	);
}

// ─── Command-context runner with TUI box (dag mode) ────────

async function runWorkflowForCommand(
	pi: ExtensionAPI,
	workflow: WorkflowName,
	query: string,
	ctx: ExtensionCommandContext,
): Promise<CommandWorkflowOutcome> {
	const cwd = ctx.cwd || process.cwd();

	if (!ctx.hasUI) {
		const startedAt = Date.now();
		const run = await runArchonWorkflow(pi, workflow, query, cwd);
		return { run, durationMs: Date.now() - startedAt };
	}

	const outcome = await ctx.ui.custom<CommandWorkflowOutcome>(
		(tui, theme, _keybindings, done) => {
			const startedAt = Date.now();
			const controller = new AbortController();
			let finished = false;
			let cancelling = false;

			const finish = (value: CommandWorkflowOutcome) => {
				if (finished) return;
				finished = true;
				box.stop();
				done(value);
			};

			const box = new ProgressBox({
				mode: "dag",
				tui,
				theme,
				title: `${ARCHON_PILL_DEFAULT.toLowerCase()} ${workflow}`,
				pill: toPillLabel(workflow),
				onAbort: () => {
					if (cancelling || finished) return;
					cancelling = true;
					box.appendLine(
						`Cancelling workflow '${workflow}'...`,
						false,
					);
					void (async () => {
						try {
							const runId = await findActiveWorkflowRunId(
								pi,
								cwd,
								workflow,
							);
							if (runId)
								await cancelArchonWorkflowRun(pi, runId, cwd);
						} catch (error) {
							box.appendLine(
								`Cancel request failed: ${normalizeError(error)}`,
								true,
							);
						} finally {
							controller.abort();
							finish({
								cancelled: true,
								durationMs: Date.now() - startedAt,
							});
						}
					})();
				},
				maxLines: 8,
			});

			// Background poll: detect approval gates and resolve interactively
			const approvalPoll = setInterval(() => {
				if (finished) {
					clearInterval(approvalPoll);
					return;
				}

				const approvalNodeId =
					box.dagTracker.approvalPendingNodeId;
				if (!approvalNodeId || box.dagTracker.workflowDone) return;

				// Found an approval gate — ask the user
				const node = box.dagTracker.nodes.find(
					(n) => n.id === approvalNodeId,
				);
				const msg = node?.approvalMessage ?? "Approve this step?";

				void (async () => {
					try {
						const approved = await ctx.ui.confirm(
							`Archon: ${approvalNodeId}`,
							`${msg}\n\nApprove this workflow step?`,
						);
						if (approved) {
							box.appendLine(
								`[approval] Approved: ${approvalNodeId}`,
								false,
							);
							box.dagTracker.applyEvent({
								type: "node_completed",
								nodeId: approvalNodeId,
								duration: "approved",
							});
							box.clearApproval();
							// Send approve command to Archon
							try {
								const runId =
									await findActiveWorkflowRunId(
										pi,
										cwd,
										workflow,
									);
								if (runId) {
									await runArchonCommand(
										pi,
										[
											"workflow",
											"approve",
											runId,
										],
										cwd,
									);
								}
							} catch (approveErr) {
								box.appendLine(
									`Approval send failed: ${normalizeError(approveErr)}`,
									true,
								);
							}
						} else {
							box.appendLine(
								`[approval] Rejected: ${approvalNodeId}`,
								false,
							);
							box.dagTracker.applyEvent({
								type: "node_failed",
								nodeId: approvalNodeId,
								error: "rejected by user",
							});
							box.clearApproval();
							// Send reject command to Archon
							try {
								const runId =
									await findActiveWorkflowRunId(
										pi,
										cwd,
										workflow,
									);
								if (runId) {
									await runArchonCommand(
										pi,
										[
											"workflow",
											"reject",
											runId,
										],
										cwd,
									);
								}
							} catch (rejectErr) {
								box.appendLine(
									`Reject send failed: ${normalizeError(rejectErr)}`,
									true,
								);
							}
						}
					} catch {
						// ctx.ui.confirm may not be available or user dismissed
						box.clearApproval();
					}
				})();
			}, 2000);

			runArchonWorkflowStreaming(
				workflow,
				query,
				cwd,
				controller.signal,
				(line, isErr) => box.appendLine(line, isErr),
			)
				.then((run) => {
					if (controller.signal.aborted) return;
					if (run.exitCode !== 0)
						box.setStreamError(`exit code ${run.exitCode}`);
					// Apply final workflow event to tracker
					if (run.exitCode === 0) {
						box.dagTracker.applyEvent({
							type: "workflow_completed",
						});
					} else {
						box.dagTracker.applyEvent({
							type: "workflow_failed",
							error: `exit code ${run.exitCode}`,
						});
					}
					finish({ run, durationMs: Date.now() - startedAt });
				})
				.catch((error) => {
					if (controller.signal.aborted) return;
					box.setStreamError(normalizeError(error));
					finish({
						error: normalizeError(error),
						durationMs: Date.now() - startedAt,
					});
				})
				.finally(() => {
					clearInterval(approvalPoll);
				});

			return box;
		},
	);

	return outcome ?? { cancelled: true };
}

// ─── Tool-update-wrapped runner ──────────────────────────────

export async function runWorkflowWithToolUpdates(
	pi: ExtensionAPI,
	workflow: WorkflowName,
	query: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (update: ArchonToolUpdate) => void,
): Promise<{ run: ArchonRunResult; durationMs: number }> {
	const startedAt = Date.now();
	const preview =
		query.length > 72 ? `${query.slice(0, 72)}...` : query;

	const pushUpdate = (
		phase: "start" | "running" | "done",
		text: string,
		extra?: Record<string, unknown>,
	) => {
		onUpdate?.({
			content: [{ type: "text", text }],
			details: {
				phase,
				workflow,
				queryPreview: preview,
				elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
				...extra,
			},
		});
	};

	pushUpdate("start", `Starting Archon workflow '${workflow}'...`);

	const interval = setInterval(() => {
		pushUpdate(
			"running",
			`Archon '${workflow}' running (${formatElapsed(Math.floor((Date.now() - startedAt) / 1000))})...`,
		);
	}, PROGRESS_UPDATE_MS);

	try {
		const run = await runArchonWorkflow(pi, workflow, query, cwd, signal);
		const durationMs = Date.now() - startedAt;
		pushUpdate(
			"done",
			run.exitCode === 0
				? `Archon '${workflow}' finished in ${formatElapsed(Math.floor(durationMs / 1000))}.`
				: `Archon '${workflow}' failed (exit ${run.exitCode}) after ${formatElapsed(Math.floor(durationMs / 1000))}.`,
			{ exitCode: run.exitCode, durationMs },
		);
		return { run, durationMs };
	} finally {
		clearInterval(interval);
	}
}

// ─── CLI command handler for workflow runs ──────────

export async function handleWorkflowCommand(
	pi: ExtensionAPI,
	workflow: WorkflowName,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const query = normalizeString(args) || DEFAULT_QUERY;

	try {
		const outcome = await runWorkflowForCommand(pi, workflow, query, ctx);

		if (outcome.cancelled) {
			emitArchonMessage(
				pi,
				`## Archon ${workflow.toUpperCase()} — ${redactSecrets(query)}

- **Result:** ⚠️ cancelled by user
`,
				{
					workflow,
					query,
					cancelled: true,
					durationMs: outcome.durationMs,
					pill: toPillLabel(workflow),
				},
			);
			return;
		}

		if (!outcome.run)
			throw new Error(
				outcome.error || "Workflow did not return a result.",
			);

		// Strip archon's own log lines from emitted output
		const cleaned = formatArchonOutput(
			`${workflow.toUpperCase()} — ${redactSecrets(query)}`,
			outcome.run,
			outcome.durationMs,
		)
			.split("\n")
			.filter((l) => !/^\[(?:INF|WRN)\] /m.test(l))
			.join("\n");

		emitArchonMessage(pi, cleaned, {
			workflow,
			query,
			exitCode: outcome.run.exitCode,
			command: outcome.run.command,
			durationMs: outcome.durationMs,
			pill: toPillLabel(workflow),
		});

		ctx.ui.notify(
			outcome.run.exitCode === 0
				? `Archon ${workflow} finished.`
				: `Archon ${workflow} failed (exit ${outcome.run.exitCode}).`,
			outcome.run.exitCode === 0 ? "info" : "warning",
		);
	} catch (error) {
		const message = normalizeError(error);
		emitArchonMessage(
			pi,
			formatCommandErrorOutput(workflow, query, message),
			{
				workflow,
				query,
				error: message,
				pill: toPillLabel(workflow),
			},
		);
		ctx.ui.notify(`Archon ${workflow} failed: ${message}`, "error");
	}
}
