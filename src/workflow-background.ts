/**
 * Workflow background runner — non-blocking workflow execution with
 * live overlay popup.
 *
 * Design:
 *   /archon workflow run X → spawn CLI in background
 *                          → show nonCapturing overlay (top-right)
 *                          → return immediately (user can keep chatting)
 *                          → on completion: dismiss overlay, post result
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
import { spawn, type ChildProcess } from "node:child_process";
import { DagProgressTracker } from "./dag-tracker";
import { WorkflowOverlay, fmtElapsed } from "./ui/workflow-overlay";
import { STATUS_KEY_RUNNING, PROGRESS_UPDATE_MS } from "./constants";
import { formatElapsed, toPillLabel } from "./helpers";
import { redactSecrets, safeCode, tryParseDagEvent } from "./output-filter";
import {
	findLatestRunId,
	queryRunArtifacts,
	queryLoopIterations,
	findActiveRunId,
	renderArtifactsSection,
} from "./artifact-query";
import {
	findActiveWorkflowRunId,
	cancelArchonWorkflowRun,
} from "./workflow-ops";
import { runArchonCommand, formatArchonOutput } from "./archon-exec";
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
	onComplete?: (outcome: CommandWorkflowOutcome) => void;
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

// ── Resolve archon CLI binary ───────────────────────────────

function resolveArchonBin(cwd: string): { cmd: string; args: string[] } {
	// Reuse the same logic as archon-exec.ts
	const fs = require("node:fs");
	const path = require("node:path");
	const archonRoot = process.env.ARCHON_ROOT || "/opt/archon";
	if (fs.existsSync(path.join(archonRoot, "package.json"))) {
		return {
			cmd: "bun",
			args: ["run", "cli"],
		};
	}
	return { cmd: "archon", args: [] };
}

// ── Non-blocking runner ──────────────────────────────────────

/**
 * Start a workflow in the background with a live overlay popup.
 * Returns immediately — the workflow runs asynchronously.
 *
 * @returns A unique run ID for tracking.
 */
export function runWorkflowBackground(
	pi: ExtensionAPI,
	workflow: WorkflowName,
	query: string,
	ctx: ExtensionCommandContext,
): string | null {
	if (!ctx.hasUI) {
		// No UI — fall back to synchronous execution
		return null;
	}

	const runId = nextRunId();
	const cwd = ctx.cwd || process.cwd();
	const tracker = new DagProgressTracker();
	const queryPreview = query.length > 72 ? `${query.slice(0, 72)}…` : query;

	const entry: ActiveWorkflowRun = {
		workflowName: workflow,
		query,
		startedAt: Date.now(),
		tracker,
	};

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
						onCancel: () => {
							void cancelRun(runId);
						},
					},
					theme,
				);

				// Show as non-capturing overlay in the top-right corner
				const handle = tui.showOverlay(overlay, {
					nonCapturing: true,
					anchor: "top-right",
					width: 44,
					margin: { top: 1, right: 2 },
				});

				entry.overlayHandle = handle;

				// ── Spawn the archon CLI subprocess ──────────────
				const { cmd, args: baseArgs } = resolveArchonBin(cwd);
				const cliArgs = [
					...baseArgs,
					"workflow",
					"run",
					workflow,
					query.trim(),
					"--no-worktree",
				];

				const proc = spawn(cmd, cliArgs, {
					cwd,
					env: { ...process.env },
					stdio: ["ignore", "pipe", "pipe"],
				});

				entry.process = proc;

				// ── Stream stderr into the tracker ───────────────
				proc.stderr?.on("data", (chunk: Buffer) => {
					const lines = chunk.toString("utf-8").split(/\n/);
					for (const line of lines) {
						if (!line.trim()) continue;
						const event = tryParseDagEvent(line);
						if (event) {
							tracker.applyEvent(event);
						}
					}
				});

				// Capture stdout for final result AND parse JSON DAG events
				// Archon JSON structured logs (pino) carry richer data than stderr
				// render lines: nodeType, provider, durationMs, costUsd, numTurns
				let stdoutBuf = "";
				proc.stdout?.on("data", (chunk: Buffer) => {
					const text = chunk.toString("utf-8");
					stdoutBuf += text;
					// Parse each line for JSON DAG events
					const lines = text.split(/\n/);
					for (const line of lines) {
						if (!line.trim()) continue;
						const event = tryParseDagEvent(line);
						if (event) {
							tracker.applyEvent(event);
						}
					}
				});

				let stderrBuf = "";
				proc.stderr?.on("data", (chunk: Buffer) => {
					stderrBuf += chunk.toString("utf-8");
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
					const elapsed = formatElapsed(
						Math.floor((Date.now() - entry.startedAt) / 1000),
					);
					const progress = tracker.progressSummary(
						Math.floor((Date.now() - entry.startedAt) / 1000),
					);
					ctx.ui.setStatus?.(
						STATUS_KEY_RUNNING,
						`◆ archon ${workflow} ${progress}`,
					);
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

					// Apply final workflow event
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

					// Dismiss overlay after a brief delay so the user sees "✓ complete"
					setTimeout(() => {
						handle.hide();
						ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
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

					// Build the result message
					const cleaned = formatArchonOutput(
						`${workflow.toUpperCase()} — ${redactSecrets(query)}`,
						runResult,
						durationMs,
					)
						.split("\n")
						.filter((l: string) => !/^\[(?:INF|WRN)\] /m.test(l))
						.join("\n");

					// Query artifacts (best-effort)
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

					// Post the main result message (use "steer" to deliver immediately,
					// not "nextTurn" which waits for the next user prompt)
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

					// Toast notification
					ctx.ui.notify?.(
						exitCode === 0
							? `Archon ${workflow} finished (${fmtElapsed(Math.floor(durationMs / 1000))}).`
							: `Archon ${workflow} failed (exit ${exitCode}).`,
						exitCode === 0 ? "info" : "warning",
					);

					// Remove from active runs
					activeRuns.delete(runId);

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
					}, 1200);

					pi.sendMessage?.(
						{
							customType: "archon",
							content: `## Archon ${workflow.toUpperCase()} — ${redactSecrets(query)}\n- **Result:** ❌ failed\n\`\`\`text\n${safeCode(err.message)}\n\`\`\`\n`,
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

					ctx.ui.notify?.(`Archon ${workflow} failed: ${err.message}`, "error");

					activeRuns.delete(runId);
				});

				// Register in active runs map
				activeRuns.set(runId, entry);

				// Return immediately — the overlay and subprocess live on
				done(runId);
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
			activeRuns.delete(runId);
			return null;
		});

	return runId;
}

// ── Cancel a running workflow ────────────────────────────────

export async function cancelRun(runId: string): Promise<void> {
	const entry = activeRuns.get(runId);
	if (!entry) return;

	// Send cancel to Archon
	try {
		const archonRunId = await findActiveWorkflowRunId(
			{} as ExtensionAPI,
			entry.process?.spawnargs?.[0] ?? process.cwd(),
			entry.workflowName,
		);
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

	// Post cancellation message
	entry.tracker.applyEvent({ type: "workflow_failed", error: "cancelled" });

	activeRuns.delete(runId);
}
