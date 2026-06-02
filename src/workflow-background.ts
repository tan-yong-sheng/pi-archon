/**
 * Workflow background runner — non-blocking workflow execution with
 * live overlay popup.
 *
 * Design:
 *   /archon workflow run X  →  spawn CLI in background
 *                             →  show nonCapturing overlay (top-right)
 *                             →  return immediately (user can keep chatting)
 *                             →  on completion: dismiss overlay, post result
 *
 * Uses ctx.ui.custom() with an invisible controller component that
 * immediately creates the overlay via tui.showOverlay() and calls done().
 * The overlay stays alive independently via setInterval poll.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { TUI, Theme, OverlayHandle } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { DagProgressTracker } from "./dag-tracker";
import { WorkflowOverlay, fmtElapsed } from "./ui/workflow-overlay";
import { STATUS_KEY_RUNNING, PROGRESS_UPDATE_MS } from "./constants";
import { toPillLabel } from "./helpers";
import { redactSecrets, safeCode, tryParseDagEvent } from "./output-filter";
import {
	findLatestRunId,
	queryRunArtifacts,
	queryLoopIterations,
	findActiveRunId,
	renderArtifactsSection,
} from "./artifact-query";
import { findLatestRunIdForWorkflow } from "./archon-api";

import {
	findActiveWorkflowRunId,
	cancelArchonWorkflowRun,
} from "./workflow-ops";
import { formatArchonOutput } from "./archon-exec";
import type {
	ArchonRunResult,
	CommandWorkflowOutcome,
	WorkflowName,
} from "./types";

// ── Active run tracking (shared with /archons command) ───────

export interface ActiveWorkflowRun {
	workflowName: string;
	query: string;
	startedAt: number;
	tracker: DagProgressTracker;
	process?: ChildProcess;
	overlayHandle?: OverlayHandle;
	tui?: TUI;
	pollTimer?: ReturnType<typeof setInterval>;
	loopPollTimer?: ReturnType<typeof setInterval>;
	statusTimer?: ReturnType<typeof setInterval>;
	apiPollTimer?: ReturnType<typeof setInterval>;
	onComplete?: (outcome: CommandWorkflowOutcome) => void;

	/** UI-only lifecycle state for the current visible run entry. */
	runState?: "running" | "paused" | "approved_resuming";

	/** Whether this entry should appear in the /archons dashboard. */
	visibleInDashboard?: boolean;

	/** Archon DB UUID for this workflow run — set after the workflow pauses
	 *  at an approval gate so the approve/resume action can look it up. */
	archonRunId?: string;

	/** When resuming a paused run, points to the original local pi-archon run id. */
	parentLocalRunId?: string;
	/** When resuming a paused run, points to the original Archon run id. */
	resumeParentRunId?: string;
}

/** Global map of currently-running workflow runs, keyed by a unique run ID. */
const activeRuns = new Map<string, ActiveWorkflowRun>();
let runCounter = 0;

function nextRunId(): string {
	return `run-${Date.now()}-${++runCounter}`;
}

export function getActiveRuns(): ReadonlyMap<string, ActiveWorkflowRun> {
	return activeRuns;
}

export function getActiveRun(runId: string): ActiveWorkflowRun | undefined {
	return activeRuns.get(runId);
}

/**
 * Find an active run entry whose stored Archon DB UUID matches the given runId.
 * This handles the case where the agent passes the Archon UUID (from a pause
 * notification) rather than the local pi-archon run ID.
 */
export function findPausedRun(
	archonRunId: string,
): ActiveWorkflowRun | undefined {
	for (const entry of activeRuns.values()) {
		if (entry.archonRunId === archonRunId) {
			return entry;
		}
	}
	return undefined;
}

// ── Resolve archon CLI binary ───────────────────────────────

function resolveArchonBin(_cwd: string): { cmd: string; args: string[] } {
	// Reuse the same logic as archon-exec.ts
	const archonRoot = process.env.ARCHON_ROOT || "/opt/archon";
	if (fs.existsSync(path.join(archonRoot, "package.json"))) {
		return { cmd: "bun", args: ["run", "cli"] };
	}
	return { cmd: "archon", args: [] };
}

// ── Non-blocking runner ──────────────────────────────────────

/**
 * Shared infrastructure: launch an archon CLI command in the background with
 * a live overlay popup, SSE streaming, and automatic result delivery.
 *
 * This is the core engine used by runWorkflowBackground, resumeWorkflowBackground,
 * and approveWorkflowBackground. All three construct CLI args and call here.
 *
 * @returns A unique local run ID for tracking, or null if no UI.
 */
function runBackgroundCli(
	pi: ExtensionAPI,
	workflow: WorkflowName,
	query: string,
	cliArgs: string[],
	ctx: ExtensionCommandContext,
	options?: {
		parentLocalRunId?: string;
		visibleInDashboard?: boolean;
	},
): string | null {
	if (!ctx.hasUI) {
		return null;
	}

	const localRunId = nextRunId();
	const cwd = ctx.cwd || process.cwd();
	const tracker = new DagProgressTracker();
	const queryPreview = query.length > 72 ? `${query.slice(0, 72)}…` : query;

	const parentLocalRunId = options?.parentLocalRunId;
	const entry: ActiveWorkflowRun = {
		workflowName: workflow,
		query,
		startedAt: Date.now(),
		tracker,
		runState: parentLocalRunId ? "approved_resuming" : "running",
		visibleInDashboard: options?.visibleInDashboard ?? true,
		archonRunId: parentLocalRunId,
		resumeParentRunId: parentLocalRunId,
	};
	activeRuns.set(localRunId, entry);

	// Use ctx.ui.custom to get access to tui.showOverlay.
	// The controller component immediately creates the overlay and calls done(),
	// making it non-blocking. The overlay persists via tui.showOverlay's
	// nonCapturing mode and stays alive through setInterval-driven updates.
	ctx.ui
		.custom<string>(
			(tui: TUI, theme: Theme, _kb: unknown, done: (value: string) => void) => {
				entry.tui = tui;

				// Create the overlay component
				const overlay = new WorkflowOverlay(
					{
						workflowName: workflow,
						queryPreview,
						dagTracker: tracker,
						getRunState: () => entry.runState,
						onCancel: () => {
							void cancelRun(localRunId);
						},
						onApprove: () => {
							// User pressed 'a' on a paused workflow — approve it directly
							const archonRunId = entry.archonRunId;
							if (!archonRunId) return;
							entry.runState = "approved_resuming";
							// Dismiss the paused overlay
							handle.hide();
							// Clear the old paused entry's remaining timer + status
							if (entry.statusTimer) clearInterval(entry.statusTimer);
							ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
							ctx.ui.setWidget?.(STATUS_KEY_RUNNING, undefined);
							// Keep the paused entry visible as the same workflow row while resuming.
							entry.runState = "approved_resuming";
							// Launch approve + auto-resume in background via CLI
							// This creates a new overlay/entry for the resumed execution
							approveWorkflowBackground(
								pi,
								archonRunId,
								workflow,
								undefined,
								ctx as never,
								{
									visibleInDashboard: false,
									parentLocalRunId: localRunId,
								},
							).catch(() => {
								/* best-effort */
							});
						},
						onReject: () => {
							// User pressed 'r' on a paused workflow — reject it
							const archonRunId = entry.archonRunId;
							if (!archonRunId) return;
							// Dismiss the paused overlay
							handle.hide();
							// Clear the old paused entry's remaining timer + status
							if (entry.statusTimer) clearInterval(entry.statusTimer);
							ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
							ctx.ui.setWidget?.(STATUS_KEY_RUNNING, undefined);
							// Keep the paused entry visible as the same workflow row while rejecting.
							entry.runState = "approved_resuming";
							// Launch reject in background via CLI
							rejectWorkflowBackground(
								pi,
								archonRunId,
								workflow,
								undefined,
								ctx as never,
								{
									visibleInDashboard: false,
									parentLocalRunId: localRunId,
								},
							).catch(() => {
								/* best-effort */
							});
						},
					},
					theme,
				);

				// Show as nonCapturing overlay — width 52 for log inspector
				const handle = tui.showOverlay(overlay, {
					nonCapturing: true,
					anchor: "top-right",
					width: 52,
					margin: { top: 1, right: 2 },
				});
				entry.overlayHandle = handle;

				// ── Spawn the archon CLI subprocess ──────────────
				const { cmd, args: baseArgs } = resolveArchonBin(cwd);
				const fullArgs = [...baseArgs, ...cliArgs];

				const proc = spawn(cmd, fullArgs, {
					cwd,
					env: { ...process.env },
					stdio: ["ignore", "pipe", "pipe"],
				});
				entry.process = proc;

				// ── Stream stdout/stderr: parse DAG events + capture node logs + buffer ──
				let stdoutBuf = "";
				let stderrBuf = "";

				proc.stdout?.on("data", (chunk: Buffer) => {
					const text = chunk.toString("utf-8");
					stdoutBuf += text;
					const lines = text.split(/\n/);
					let hadDagEvent = false;
					for (const line of lines) {
						if (!line.trim()) continue;
						const event = tryParseDagEvent(line);
						if (event) {
							tracker.applyEvent(event);
							hadDagEvent = true;
						} else {
							// Non-DAG stdout line → capture as node log
							tracker.appendLogLine(line);
						}
					}
					// Trigger render so node state changes from JSON DAG events appear promptly
					if (hadDagEvent) {
						tui.requestRender();
					}
				});

				proc.stderr?.on("data", (chunk: Buffer) => {
					const text = chunk.toString("utf-8");
					stderrBuf += text;
					const lines = text.split(/\n/);
					let hadDagEvent = false;
					for (const line of lines) {
						if (!line.trim()) continue;
						const event = tryParseDagEvent(line);
						if (event) {
							tracker.applyEvent(event);
							hadDagEvent = true;
							// Also capture the raw DAG event line as a granular system event
							const nodeId =
								"stepName" in event
									? (event as { stepName: string }).stepName
									: "nodeId" in event
										? (event as { nodeId: string }).nodeId
										: undefined;
							if (nodeId && typeof nodeId === "string") {
								tracker.appendSystemEvent(nodeId, line.trim());
							}
						} else {
							// Non-DAG stderr line (node output, status text) → node log
							tracker.appendLogLine(line);
						}
					}
					// Trigger render after processing stderr DAG events so system events
					// and node state transitions appear immediately, not waiting for the
					// next pollTimer tick (which stops after workflow completes).
					if (hadDagEvent) {
						tui.requestRender();
					}
				});

				// ── Poll: request overlay re-render at regular interval ──
				const pollTimer = setInterval(() => {
					if (tracker.workflowDone) return;
					tui.requestRender();
				}, PROGRESS_UPDATE_MS);
				entry.pollTimer = pollTimer;

				// ── Status bar sync ──────────────────────────────
				const statusTimer = setInterval(() => {
					if (tracker.workflowDone) return;
					const elapsed = Math.floor((Date.now() - entry.startedAt) / 1000);
					const progress = tracker.progressSummary(elapsed);
					const statusText = `◆ archon ${workflow} ${progress}`;
					ctx.ui.setStatus?.(STATUS_KEY_RUNNING, statusText);
					// Show a live grey notice in the main terminal area
					ctx.ui.setWidget?.(STATUS_KEY_RUNNING, [
						`◇ archon ${workflow} running · ${fmtElapsed(elapsed)}`,
					]);
				}, PROGRESS_UPDATE_MS);
				entry.statusTimer = statusTimer;

				// ── Loop iteration DB poll ────────────────────────
				const lastAppliedIteration = new Map<string, number>();
				const loopPollTimer = setInterval(async () => {
					if (tracker.workflowDone) return;
					try {
						const activeRunId = await findActiveRunId(cwd);
						if (!activeRunId) return;
						const events = await queryLoopIterations(activeRunId);
						for (const event of events) {
							const lastApplied =
								lastAppliedIteration.get(event.nodeId ?? "") ?? 0;
							if ((event.iteration ?? 0) <= lastApplied) continue;
							tracker.applyEvent(event);
							lastAppliedIteration.set(
								event.nodeId ?? "",
								event.iteration ?? 0,
							);
						}
					} catch {
						// Best-effort
					}
				}, 5000);
				entry.loopPollTimer = loopPollTimer;

				// ── Handle process exit ───────────────────────────
				proc.on("close", async (exitCode) => {
					const durationMs = Date.now() - entry.startedAt;

					// Check if workflow paused at an approval gate
					const approvalNodeId = tracker.approvalPendingNodeId;

					if (approvalNodeId && exitCode === 0) {
						// ── Approval pending — workflow paused ──
						entry.runState = "paused";
						// Don't mark completed — keep overlay alive showing paused state.
						// Inform the agent so it can call approve/reject with the Archon UUID.
						clearInterval(pollTimer);
						clearInterval(loopPollTimer);
						// Keep statusTimer alive — it updates the "running" widget

						// Fetch the Archon DB UUID so approve can find this run
						let archonUuid = "";
						try {
							archonUuid =
								(await findLatestRunIdForWorkflow(workflow, cwd)) ?? "";
						} catch {
							/* best-effort */
						}
						entry.archonRunId = archonUuid;

						tui.requestRender();

						// Build pause notification with approval message
						const approvalNode = tracker.nodes.find(
							(n) => n.id === approvalNodeId,
						);
						const approvalMsg = approvalNode?.approvalMessage ?? "";

						let pauseContent = `## Archon ${workflow.toUpperCase()} — ${redactSecrets(query)}\n\n`;
						pauseContent += `⏸ **Paused at approval gate** \`${approvalNodeId}\`\n\n`;
						if (approvalMsg) {
							pauseContent += `> ${approvalMsg}\n\n`;
						}
						pauseContent += `The workflow is waiting for your decision. **Do NOT approve or cancel automatically** — ask the user whether they want to approve or reject.\n\n`;
						pauseContent += `If the user approves, use:\n`;
						pauseContent += `\`archon_workflow(action='approve', runId='${archonUuid}')\`\n\n`;
						pauseContent += `If they want to reject, use:\n`;
						pauseContent += `\`archon_workflow(action='reject', runId='${archonUuid}', reason='<why>')\`  (reason is required — ask the user why)`;

						if (typeof (pi as any).sendUserMessage === "function") {
							(pi as any).sendUserMessage(pauseContent, {
								deliverAs: "followUp",
							});
						} else {
							pi.sendMessage?.(
								{
									customType: "archon",
									content: pauseContent,
									display: true,
									details: {
										workflow,
										query,
										archonUuid,
										approvalNodeId,
										pill: toPillLabel(workflow),
									},
								},
								{ deliverAs: "steer" },
							);
						}

						ctx.ui.notify?.(
							`Archon ${workflow} paused at approval gate: ${approvalNodeId}.`,
							"info",
						);

						// Don't mark as completed — keep overlay alive
						// Don't delete from activeRuns — agent needs to approve later
						// overlay is NOT dismissed, status/widget are NOT cleared

						const pauseResult: ArchonRunResult = {
							exitCode: 0,
							stdout: stdoutBuf,
							stderr: stderrBuf,
							command: `${cmd} ${cliArgs.join(" ")}`,
						};
						entry.onComplete?.({ run: pauseResult, durationMs });

						return; // skip normal completion/failure handling
					}

					// ── Normal path: workflow completed or failed ──
					if (exitCode === 0) {
						tracker.applyEvent({ type: "workflow_completed" });
					} else {
						tracker.applyEvent({
							type: "workflow_failed",
							error: `exit code ${exitCode}`,
						});
					}

					// Final render to show completion state
					tui.requestRender();

					// Clean up timers
					clearInterval(pollTimer);
					clearInterval(statusTimer);
					clearInterval(loopPollTimer);

					// If this run is the hidden resuming subprocess, clear the parent visible row too.
					if (parentLocalRunId) {
						const parentEntry = activeRuns.get(parentLocalRunId);
						if (parentEntry) {
							parentEntry.overlayHandle?.hide();
							if (parentEntry.pollTimer) clearInterval(parentEntry.pollTimer);
							if (parentEntry.loopPollTimer)
								clearInterval(parentEntry.loopPollTimer);
							if (parentEntry.statusTimer)
								clearInterval(parentEntry.statusTimer);
							if (parentEntry.apiPollTimer)
								clearInterval(parentEntry.apiPollTimer);
							parentEntry.visibleInDashboard = false;
							ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
							ctx.ui.setWidget?.(STATUS_KEY_RUNNING, undefined);
						}
					}

					// Dismiss overlay after a brief delay so the user sees "✓ complete"
					setTimeout(() => {
						handle.hide();
						ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
						ctx.ui.setWidget?.(STATUS_KEY_RUNNING, undefined);
					}, 1200);

					// Post result as a chat message
					const runResult: ArchonRunResult = {
						exitCode: exitCode ?? 1,
						stdout: stdoutBuf,
						stderr: stderrBuf,
						command: `${cmd} ${cliArgs.join(" ")}`,
					};
					const outcome: CommandWorkflowOutcome = {
						run: runResult,
						durationMs,
					};

					// Build the result message from stdout/stderr buffers
					const cleaned = formatArchonOutput(
						`${workflow.toUpperCase()} — ${redactSecrets(query)}`,
						runResult,
						durationMs,
						query,
					);

					// Query artifacts (best-effort, awaited)
					let artifacts: Awaited<ReturnType<typeof queryRunArtifacts>> = [];
					try {
						const rid = await findLatestRunId(workflow, cwd);
						if (rid) artifacts = await queryRunArtifacts(rid);
					} catch {
						// Best-effort
					}

					// Build result with artifacts inline
					let resultContent = cleaned;
					if (artifacts.length > 0) {
						const section = renderArtifactsSection(artifacts);
						resultContent += `\n\n## Artifacts\n${section}`;
					}

					// Inject result as a user message so the agent processes it.
					// Uses followUp to queue after any in-progress assistant response.
					// If sendUserMessage isn't available (older pi), falls back to
					// sendMessage for display-only delivery.
					if (typeof (pi as any).sendUserMessage === "function") {
						(pi as any).sendUserMessage(resultContent, {
							deliverAs: "followUp",
						});
					} else {
						pi.sendMessage?.(
							{
								customType: "archon",
								content: resultContent,
								display: true,
								details: {
									workflow,
									query,
									exitCode: runResult.exitCode,
									durationMs,
									artifacts,
									pill: toPillLabel(workflow),
								},
							},
							{ deliverAs: "steer" },
						);
					}

					// Toast notification
					ctx.ui.notify?.(
						exitCode === 0
							? `Archon ${workflow} finished (${fmtElapsed(Math.floor(durationMs / 1000))}).`
							: `Archon ${workflow} failed (exit ${exitCode}).`,
						exitCode === 0 ? "info" : "warning",
					);

					// Remove from active runs
					activeRuns.delete(localRunId);

					// Notify completion callback (used by /archons)
					entry.onComplete?.(outcome);
				});

				proc.on("error", (err) => {
					const durationMs = Date.now() - entry.startedAt;
					tracker.applyEvent({
						type: "workflow_failed",
						error: err.message,
					});
					tui.requestRender();
					clearInterval(pollTimer);
					clearInterval(statusTimer);
					clearInterval(loopPollTimer);

					setTimeout(() => {
						handle.hide();
						ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
						ctx.ui.setWidget?.(STATUS_KEY_RUNNING, undefined);
					}, 1200);

					const errorContent = `## Archon ${workflow.toUpperCase()} — ${redactSecrets(query)}\n- **Result:** ❌ failed\n### Input\n\n\`\`\`text\n${safeCode(query)}\n\`\`\`\n\n\`\`\`text\n${safeCode(err.message)}\n\`\`\`\n`;
					if (typeof (pi as any).sendUserMessage === "function") {
						(pi as any).sendUserMessage(errorContent, {
							deliverAs: "followUp",
						});
					} else {
						pi.sendMessage?.(
							{
								customType: "archon",
								content: errorContent,
								display: true,
								details: {
									workflow,
									query,
									error: err.message,
									durationMs,
									pill: toPillLabel(workflow),
								},
							},
							{ deliverAs: "steer" },
						);
					}
					ctx.ui.notify?.(`Archon ${workflow} failed: ${err.message}`, "error");
					if (parentLocalRunId) {
						const parentEntry = activeRuns.get(parentLocalRunId);
						if (parentEntry) {
							parentEntry.overlayHandle?.hide();
							if (parentEntry.pollTimer) clearInterval(parentEntry.pollTimer);
							if (parentEntry.loopPollTimer)
								clearInterval(parentEntry.loopPollTimer);
							if (parentEntry.statusTimer)
								clearInterval(parentEntry.statusTimer);
							if (parentEntry.apiPollTimer)
								clearInterval(parentEntry.apiPollTimer);
							parentEntry.visibleInDashboard = false;
							ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
							ctx.ui.setWidget?.(STATUS_KEY_RUNNING, undefined);
							activeRuns.delete(parentLocalRunId);
						}
					}
					activeRuns.delete(localRunId);
				});

				// Register in active runs map
				activeRuns.set(localRunId, entry);

				// Return immediately — the overlay and subprocess live on
				done(localRunId);
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					width: 44,
					margin: { top: 1, right: 2 },
				},
			},
		)
		.catch(() => {
			// ctx.ui.custom() itself failed — unlikely but handle gracefully
			activeRuns.delete(localRunId);
			return null;
		});

	return localRunId;
}

// ── Public wrappers ───────────────────────────────────────────

/**
 * Start a workflow in the background with a live overlay popup.
 * Returns immediately — the workflow runs asynchronously.
 *
 * @returns A unique local run ID for tracking.
 */
export function runWorkflowBackground(
	pi: ExtensionAPI,
	workflow: WorkflowName,
	query: string,
	ctx: ExtensionCommandContext,
): string | null {
	const cliArgs = ["workflow", "run", workflow, query.trim(), "--no-worktree"];
	return runBackgroundCli(pi, workflow, query, cliArgs, ctx);
}

/**
 * Resume a failed or paused workflow run in the background.
 * Uses `archon workflow run <name> --resume --no-worktree` which
 * detects the most recent resumable (failed/paused) run and resumes it.
 *
 * The resumed workflow's output is delivered via sendUserMessage
 * on completion, just like run.
 */
export function resumeWorkflowBackground(
	pi: ExtensionAPI,
	_runId: string,
	workflowName: string,
	ctx: ExtensionCommandContext,
): string | null {
	const cliArgs = [
		"workflow",
		"run",
		workflowName,
		"--resume",
		"--no-worktree",
	];
	return runBackgroundCli(
		pi,
		workflowName,
		`resume ${workflowName}`,
		cliArgs,
		ctx,
		{ visibleInDashboard: true },
	);
}

/**
 * Approve a paused workflow run in the background.
 * Spawns `archon workflow approve <runId> [comment]` as a single CLI subprocess.
 * The CLI handles both the approval AND the resume within the same process,
 * keeping execution in the CLI session where DAG events and SSE stream correctly.
 *
 * Important: We use the CLI subcommand rather than the REST API because the
 * REST API's auto-resume (tryAutoResumeAfterGate) dispatches through the web
 * orchestrator which cannot route execution back to a CLI-originated conversation,
 * causing the resumed node to start but hang forever.
 */
export async function approveWorkflowBackground(
	pi: ExtensionAPI,
	runId: string,
	workflowName: string,
	comment: string | undefined,
	ctx: ExtensionCommandContext,
	options?: {
		parentLocalRunId?: string;
		visibleInDashboard?: boolean;
	},
): Promise<string | null> {
	// Build CLI args: archon workflow approve <runId> [comment]
	const cliArgs: string[] = ["workflow", "approve", runId, "--no-worktree"];
	if (comment) {
		cliArgs.push(comment);
	}
	return runBackgroundCli(
		pi,
		workflowName,
		comment ? `approve: ${comment.slice(0, 60)}` : "approve",
		cliArgs,
		ctx,
		{
			...options,
			parentLocalRunId: options?.parentLocalRunId ?? runId,
			visibleInDashboard: options?.visibleInDashboard ?? false,
		},
	);
}

/**
 * Reject a paused workflow run in the background.
 * Spawns `archon workflow reject <runId> [reason]` as a single CLI subprocess.
 * The CLI handles both the rejection AND the optional on_reject resume within
 * the same process.
 */
export async function rejectWorkflowBackground(
	pi: ExtensionAPI,
	runId: string,
	workflowName: string,
	reason: string | undefined,
	ctx: ExtensionCommandContext,
	options?: {
		parentLocalRunId?: string;
		visibleInDashboard?: boolean;
	},
): Promise<string | null> {
	// Build CLI args: archon workflow reject <runId> [reason]
	const cliArgs: string[] = ["workflow", "reject", runId, "--no-worktree"];
	if (reason) {
		cliArgs.push(reason);
	}
	return runBackgroundCli(
		pi,
		workflowName,
		reason ? `reject: ${reason.slice(0, 60)}` : "reject",
		cliArgs,
		ctx,
		{
			...options,
			parentLocalRunId: options?.parentLocalRunId ?? runId,
			visibleInDashboard: options?.visibleInDashboard ?? false,
		},
	);
}

// ── Cancel a running workflow ────────────────────────────────

export async function cancelRun(runId: string): Promise<void> {
	const entry = activeRuns.get(runId);
	if (!entry) return;

	// Send cancel to Archon
	try {
		// For paused workflows, use the stored archonRunId
		const archonRunId =
			entry.archonRunId ??
			(await findActiveWorkflowRunId(
				{} as ExtensionAPI,
				entry.process?.spawnargs?.[0] ?? process.cwd(),
				entry.workflowName,
			));
		if (archonRunId) {
			await cancelArchonWorkflowRun(
				{} as ExtensionAPI,
				archonRunId,
				process.cwd(),
			);
		}
	} catch {
		// Best-effort
	}

	// Kill the subprocess
	entry.process?.kill("SIGTERM");

	// Dismiss overlay
	entry.overlayHandle?.hide();

	// Clean up timers
	if (entry.pollTimer) clearInterval(entry.pollTimer);
	if (entry.statusTimer) clearInterval(entry.statusTimer);
	if (entry.loopPollTimer) clearInterval(entry.loopPollTimer);
	if (entry.apiPollTimer) clearInterval(entry.apiPollTimer);

	// Post cancellation message
	entry.tracker.applyEvent({
		type: "workflow_failed",
		error: "cancelled",
	});
	activeRuns.delete(runId);
}
