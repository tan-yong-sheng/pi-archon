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
import {
	queryNodeOutputs,
	findLatestRunIdForWorkflow,
	getRunDetail,
} from "./archon-api";
import {
	ArchonSSEClient,
	ArchonConversationSSE,
	mapSSEToDagEvent,
	type ArchonSSEEvent,
} from "./archon-sse";
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
	sseClient?: ArchonSSEClient;
	conversationSSE?: ArchonConversationSSE;
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
): string | null {
	if (!ctx.hasUI) {
		return null;
	}

	const localRunId = nextRunId();
	const cwd = ctx.cwd || process.cwd();
	const tracker = new DagProgressTracker();
	const queryPreview = query.length > 72 ? `${query.slice(0, 72)}…` : query;

	const entry: ActiveWorkflowRun = {
		workflowName: workflow,
		query,
		startedAt: Date.now(),
		tracker,
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
						onCancel: () => {
							void cancelRun(localRunId);
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

				// ── API poll: enrich tracker with node_output from Archon server ──
				const lastApiPolledNodes = new Set<string>();
				const apiPollTimer = setInterval(async () => {
					if (tracker.workflowDone) return;
					try {
						const rid = await findLatestRunIdForWorkflow(workflow, cwd);
						if (!rid) return;
						const nodeOutputs = await queryNodeOutputs(rid);
						for (const nodeInfo of nodeOutputs) {
							if (nodeInfo.output && !lastApiPolledNodes.has(nodeInfo.nodeId)) {
								tracker.setNodeOutput(nodeInfo.nodeId, nodeInfo.output);
								lastApiPolledNodes.add(nodeInfo.nodeId);
							}
						}
					} catch {
						// Best-effort — Archon server may not be running
					}
				}, 5000);
				entry.apiPollTimer = apiPollTimer;

				// ── SSE: dashboard event stream for node status ────────────
				// Connect to /api/stream/__dashboard__ for live workflow events.
				// SSE events feed directly into the tracker (zero latency),
				// and node_completed triggers an immediate node_output query.
				const sseClient = new ArchonSSEClient();
				sseClient.onEvent = (event: ArchonSSEEvent) => {
					// Map SSE event to DagEvent and apply to tracker
					const dagEvent = mapSSEToDagEvent(event);
					if (dagEvent) tracker.applyEvent(dagEvent);
					tui.requestRender();

					// On node_completed, immediately query the API for node_output
					if (event.type === "dag_node" && event.status === "completed") {
						findLatestRunIdForWorkflow(workflow, cwd)
							.then((rid) => {
								if (!rid) return;
								queryNodeOutputs(rid)
									.then((outputs) => {
										for (const n of outputs) {
											if (n.output && n.nodeId === event.nodeId) {
												tracker.setNodeOutput(n.nodeId, n.output);
											}
										}
										tui.requestRender();
									})
									.catch(() => {});
							})
							.catch(() => {});
					}

					// On workflow_artifact, log for later artifact query
					if (event.type === "workflow_artifact") {
						tracker.applyEvent({
							type: "workflow_artifact" as never,
							runId: event.runId,
						} as never);
					}
					// On workflow_tool_activity, also update structured tool call records
					// (fallback when conversation SSE is not connected)
					if (event.type === "workflow_tool_activity") {
						const nodeId = event.stepName;
						if (nodeId) {
							if (event.status === "started") {
								tracker.startToolCall(nodeId, event.toolName, {});
							} else if (event.status === "completed") {
								tracker.completeToolCall(
									nodeId,
									event.toolName,
									"", // Dashboard SSE doesn't provide output
									event.durationMs ?? 0,
								);
							}
						}
					}
				};

				// Connect async — don't block if server isn't running
				sseClient
					.connect()
					.then((ok) => {
						if (ok) entry.sseClient = sseClient;
					})
					.catch(() => {});
				entry.sseClient = sseClient; // store ref even if connecting

				// ── SSE: conversation stream for AI text + tool calls ─────────
				// The conversation_platform_id is needed to connect to the
				// per-conversation SSE stream. We discover it by polling the
				// run detail API after the workflow starts.
				let conversationSSEConnected = false;
				const conversationDiscoveryTimer = setInterval(async () => {
					if (conversationSSEConnected || tracker.workflowDone) {
						clearInterval(conversationDiscoveryTimer);
						return;
					}
					try {
						const rid = await findLatestRunIdForWorkflow(workflow, cwd);
						if (!rid) return;
						const detail = await getRunDetail(rid);
						if (!detail) return;

						const platformId =
							detail.run.worker_platform_id ??
							detail.run.conversation_platform_id;
						if (!platformId) return;

						// Found the conversation ID — connect to its SSE stream
						const convSSE = new ArchonConversationSSE(
							"http://127.0.0.1:3090",
							platformId,
						);

						convSSE.onText = (content) => {
							// Append streaming AI text to the currently-running node.
							// streamingText is the primary display surface in the overlay output panel;
							// logLines is for subprocess stdout/stderr only (no duplication).
							tracker.appendStreamingTextToCurrent(content);
							tui.requestRender();
						};

						convSSE.onToolCall = (name, input, toolCallId) => {
							// Start a structured tool call record on the running node
							const nodeId = tracker.currentRunningNodeId;
							if (nodeId) {
								tracker.startToolCall(nodeId, name, input, toolCallId);
								// Log system event for granular display
								tracker.appendSystemEvent(nodeId, `↳ tool: ${name} (started)`);
							}
							tui.requestRender();
						};

						convSSE.onToolResult = (name, output, duration, toolCallId) => {
							// Complete the structured tool call record on the running node
							const nodeId = tracker.currentRunningNodeId;
							if (nodeId) {
								tracker.completeToolCall(
									nodeId,
									name,
									output,
									duration,
									toolCallId,
								);
								// Log system event for granular display
								const durStr =
									duration > 1000
										? `${Math.round(duration / 100) / 10}s`
										: `${duration}ms`;
								tracker.appendSystemEvent(
									nodeId,
									`↳ tool: ${name} (${durStr})`,
								);
							}
							tui.requestRender();
						};

						convSSE.onError = (message) => {
							tracker.appendLogLine(`⚠ Error: ${message}`);
							tui.requestRender();
						};

						const connected = await convSSE.connect();
						if (connected) {
							conversationSSEConnected = true;
							entry.conversationSSE = convSSE;
							clearInterval(conversationDiscoveryTimer);
						}
					} catch {
						// Best-effort
					}
				}, 2000); // poll every 2s for conversation ID

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
					clearInterval(apiPollTimer);
					clearInterval(conversationDiscoveryTimer);
					entry.sseClient?.disconnect();
					entry.conversationSSE?.disconnect();

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

					// Build the result message — prefer API-sourced node output for clean results
					let cleaned: string;
					try {
						const rid = await findLatestRunIdForWorkflow(workflow, cwd);
						if (rid) {
							const nodeOutputs = await queryNodeOutputs(rid);
							if (nodeOutputs.length > 0) {
								// Build result from structured node outputs (no duplication)
								const status = exitCode === 0 ? "✅ success" : "❌ failed";
								const duration =
									typeof durationMs === "number"
										? fmtElapsed(Math.floor(durationMs / 1000))
										: "";
								let md = `## Archon ${workflow.toUpperCase()} — ${redactSecrets(query)}\n\n`;
								md += `- **Result:** ${status} (exit \`${String(exitCode ?? 1)}\`)\n`;
								if (duration) md += `- **Duration:** \`${duration}\`\n`;
								md += "\n### Output\n\n";
								for (const node of nodeOutputs) {
									if (node.output) {
										md += `**${node.nodeId}**${node.nodeType ? ` [${node.nodeType}]` : ""}\n`;
										md += node.output + "\n\n";
									}
								}
								cleaned = md.trim();
							} else {
								cleaned = formatArchonOutput(
									`${workflow.toUpperCase()} — ${redactSecrets(query)}`,
									runResult,
									durationMs,
								);
							}
						} else {
							cleaned = formatArchonOutput(
								`${workflow.toUpperCase()} — ${redactSecrets(query)}`,
								runResult,
								durationMs,
							);
						}
					} catch {
						cleaned = formatArchonOutput(
							`${workflow.toUpperCase()} — ${redactSecrets(query)}`,
							runResult,
							durationMs,
						);
					}

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
					entry.conversationSSE?.disconnect();

					setTimeout(() => {
						handle.hide();
						ctx.ui.setStatus?.(STATUS_KEY_RUNNING, undefined);
						ctx.ui.setWidget?.(STATUS_KEY_RUNNING, undefined);
					}, 1200);

					const errorContent = `## Archon ${workflow.toUpperCase()} — ${redactSecrets(query)}\n- **Result:** ❌ failed\n\`\`\`text\n${safeCode(err.message)}\n\`\`\`\n`;
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
 * Resolves the run's workflow name via API, then spawns
 * `archon workflow resume <runId>` with overlay/SSE.
 *
 * The resumed workflow's output is delivered via sendUserMessage
 * on completion, just like run.
 */
export function resumeWorkflowBackground(
	pi: ExtensionAPI,
	runId: string,
	workflowName: string,
	ctx: ExtensionCommandContext,
): string | null {
	const cliArgs = ["workflow", "resume", runId];
	return runBackgroundCli(
		pi,
		workflowName,
		`resume ${runId.slice(0, 12)}`,
		cliArgs,
		ctx,
	);
}

/**
 * Approve a paused workflow run in the background.
 * Resolves the run's workflow name via API, then spawns
 * `archon workflow approve <runId> [comment]` with overlay/SSE.
 *
 * After approval the workflow auto-resumes. The resumed output
 * is delivered via sendUserMessage on completion.
 */
export function approveWorkflowBackground(
	pi: ExtensionAPI,
	runId: string,
	workflowName: string,
	comment: string | undefined,
	ctx: ExtensionCommandContext,
): string | null {
	const cliArgs = comment
		? ["workflow", "approve", runId, comment]
		: ["workflow", "approve", runId];
	return runBackgroundCli(
		pi,
		workflowName,
		comment ? `approve: ${comment.slice(0, 60)}` : "approve",
		cliArgs,
		ctx,
	);
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
	if (entry.apiPollTimer) clearInterval(entry.apiPollTimer);
	entry.sseClient?.disconnect();
	entry.conversationSSE?.disconnect();

	// Post cancellation message
	entry.tracker.applyEvent({
		type: "workflow_failed",
		error: "cancelled",
	});
	activeRuns.delete(runId);
}
