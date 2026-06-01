import type {
	DagEvent,
	DagNodeInfo,
	DagNodeState,
	ToolActivity,
	ToolCallRecord,
} from "./types";

import { tryParseDagEvent } from "./output-filter";
import { formatElapsed } from "./helpers";
import { MAX_NODE_LOG_LINES } from "./constants";

/**
 * DagProgressTracker maintains an ordered list of DAG nodes discovered
 * from Archon CLI output (stderr render lines + stdout JSON logs) and
 * updates their state in real-time.
 *
 * Also captures node-scoped log lines — any stdout/stderr output that
 * appears between a node's Started and Completed events is buffered
 * into the node's logLines ring buffer for inspection via the
 * WorkflowOverlay log inspector view.
 *
 * Also tracks streaming AI text and structured tool calls per node,
 * populated from the conversation SSE stream for real-time observability.
 *
 * Also tracks loop iteration progress for nodes that run as loops.
 * Since the Archon CLI does not emit loop iteration events to stderr,
 * iteration data must be injected via applyEvent() (typically from
 * a periodic DB query during the run).
 *
 * Usage:
 * const tracker = new DagProgressTracker();
 * tracker.onLine("[investigate] Started", false);
 * tracker.onLine("some output line", true);
 * tracker.onLine("[investigate] Completed (45s)", false);
 * console.log(tracker.nodes[0].logLines); // → ["some output line"]
 */
export class DagProgressTracker {
	#nodes = new Map<string, DagNodeInfo>();
	#nodeOrder: string[] = [];
	#tools = new Map<string, ToolActivity>();
	#workflowName?: string;
	#workflowDone = false;
	#workflowError?: string;
	#totalDurationMs?: number;
	#approvalNodeId?: string;

	// ─── Public read-only accessors ──────────────────────────────

	/** Nodes in discovery order */
	get nodes(): readonly DagNodeInfo[] {
		return this.#nodeOrder.map((id) => this.#nodes.get(id)!).filter(Boolean);
	}

	get workflowName(): string | undefined {
		return this.#workflowName;
	}

	get workflowDone(): boolean {
		return this.#workflowDone;
	}

	get workflowError(): string | undefined {
		return this.#workflowError;
	}

	get totalDurationMs(): number | undefined {
		return this.#totalDurationMs;
	}

	/** Node currently awaiting approval, if any */
	get approvalPendingNodeId(): string | undefined {
		return this.#approvalNodeId;
	}

	get completedCount(): number {
		return this.nodes.filter((n) => n.state === "done" || n.state === "skipped")
			.length;
	}

	get errorCount(): number {
		return this.nodes.filter((n) => n.state === "error").length;
	}

	get totalCount(): number {
		return this.#nodeOrder.length;
	}

	get runningNodeIds(): readonly string[] {
		return this.nodes.filter((n) => n.state === "running").map((n) => n.id);
	}

	/** Get the active tool for a specific node (legacy ToolActivity map) */
	getActiveTool(nodeId: string): ToolActivity | undefined {
		for (const tool of this.#tools.values()) {
			if (tool.stepName === nodeId && tool.durationMs === undefined) {
				return tool;
			}
		}
		return undefined;
	}

	/** Get the last in-flight tool call record for a node (still running, no output yet) */
	getActiveToolCall(nodeId: string): ToolCallRecord | undefined {
		const node = this.#nodes.get(nodeId);
		if (!node) return undefined;
		// Find last tool call without output
		for (let i = node.toolCalls.length - 1; i >= 0; i--) {
			if (node.toolCalls[i].output === undefined) {
				return node.toolCalls[i];
			}
		}
		return undefined;
	}

	/** Get the nodeId of the currently-running node (last one started). */
	get currentRunningNodeId(): string | undefined {
		// Find the last node in "running" state
		for (let i = this.#nodeOrder.length - 1; i >= 0; i--) {
			const node = this.#nodes.get(this.#nodeOrder[i]);
			if (node?.state === "running") return node.id;
		}
		return undefined;
	}

	// ─── Event ingestion ────────────────────────────────────────

	/** Process a raw CLI output line. Returns true if it was a DAG event. */
	onLine(line: string, _isErr: boolean): boolean {
		const event = tryParseDagEvent(line);
		if (!event) return false;
		this.applyEvent(event);
		return true;
	}

	/**
	 * Append a raw output line to the currently-running node's log buffer.
	 * Called for lines that are NOT recognized as DAG events but appear
	 * between node Started/Completed markers — these are the actual
	 * tool outputs, AI responses, and bash stdout/stderr.
	 *
	 * Noisy internal lines (JSON logs, status emojis, bracket prefixes)
	 * are filtered out so only meaningful output reaches the inspector.
	 */
	appendLogLine(line: string): void {
		// Stop capturing once the workflow is done —
		// Archon CLI re-prints AI node output after dag_workflow_finished,
		// which would duplicate lines already captured during node execution.
		if (this.#workflowDone) return;

		const trimmed = line.trim();
		if (!trimmed) return;
		if (isLogNoise(trimmed)) return;

		const nodeId = this.currentRunningNodeId;
		if (!nodeId) return;

		const node = this.#nodes.get(nodeId);
		if (!node) return;

		node.logLines.push(line);

		// Ring buffer: keep only the last MAX_NODE_LOG_LINES
		if (node.logLines.length > MAX_NODE_LOG_LINES) {
			node.logLines.splice(0, node.logLines.length - MAX_NODE_LOG_LINES);
		}
	}

	/**
	 * Append streaming AI text to a specific node.
	 * Called from conversation SSE onText — the text accumulates
	 * in node.streamingText for real-time display.
	 */
	appendStreamingText(nodeId: string, text: string): void {
		if (this.#workflowDone) return;
		const node = this.#nodes.get(nodeId);
		if (!node) return;
		node.streamingText += text;
	}

	/**
	 * Append streaming AI text to the currently-running node.
	 * Convenience wrapper used by conversation SSE onText.
	 */
	appendStreamingTextToCurrent(text: string): void {
		if (this.#workflowDone) return;
		const nodeId = this.currentRunningNodeId;
		if (!nodeId) return;
		this.appendStreamingText(nodeId, text);
	}

	/**
	 * Start a new tool call on a specific node.
	 * Called from conversation SSE onToolCall or dashboard SSE workflow_tool_activity.
	 */
	startToolCall(
		nodeId: string,
		name: string,
		input: Record<string, unknown>,
		toolCallId?: string,
	): void {
		if (this.#workflowDone) return;
		const node = this.#nodes.get(nodeId);
		if (!node) return;

		node.toolCalls.push({
			name,
			input,
			startedAt: Date.now(),
			toolCallId,
		});

		// Also update the legacy activeTool field for compatibility
		this.upsertNode(nodeId, { activeTool: name });
	}

	/**
	 * Complete a tool call on a specific node.
	 * Called from conversation SSE onToolResult or dashboard SSE workflow_tool_activity.
	 */
	completeToolCall(
		nodeId: string,
		name: string,
		output: string,
		durationMs: number,
		toolCallId?: string,
	): void {
		const node = this.#nodes.get(nodeId);
		if (!node) return;

		// Find the matching tool call — match by name + toolCallId, or by name + no output
		for (let i = node.toolCalls.length - 1; i >= 0; i--) {
			const tc = node.toolCalls[i];
			if (
				tc.name === name &&
				tc.output === undefined &&
				(toolCallId ? tc.toolCallId === toolCallId : true)
			) {
				node.toolCalls[i] = {
					...tc,
					output,
					durationMs,
				};
				break;
			}
		}

		// If this was the active tool, clear it
		if (node.activeTool === name) {
			this.upsertNode(nodeId, { activeTool: undefined });
		}
	}

	/**
	 * Toggle the expanded state of a tool call record.
	 */
	toggleToolCallExpanded(nodeId: string, index: number): void {
		const node = this.#nodes.get(nodeId);
		if (!node || index < 0 || index >= node.toolCalls.length) return;
		node.toolCalls[index] = {
			...node.toolCalls[index],
			expanded: !node.toolCalls[index].expanded,
		};
	}

	/**
	 * Toggle the iteration expansion state for a loop node.
	 */
	toggleIterationsExpanded(nodeId: string): void {
		const node = this.#nodes.get(nodeId);
		if (!node) return;
		this.upsertNode(nodeId, {
			iterationsExpanded: !node.iterationsExpanded,
		});
	}

	/**
	 * Set the full node output for a specific node (from Archon API).
	 * This is the complete output text from the node_completed event,
	 * much richer than the line-by-line logLines buffer.
	 */
	setNodeOutput(nodeId: string, output: string): void {
		const node = this.#nodes.get(nodeId);
		if (!node) return;
		node.nodeOutput = output;
	}

	/**
	 * Append a raw output line to a specific node's log buffer.
	 * Used when we know which node the output belongs to.
	 */
	appendLogLineTo(nodeId: string, line: string): void {
		if (this.#workflowDone) return;

		const trimmed = line.trim();
		if (!trimmed) return;
		if (isLogNoise(trimmed)) return;

		const node = this.#nodes.get(nodeId);
		if (!node) return;

		node.logLines.push(line);

		if (node.logLines.length > MAX_NODE_LOG_LINES) {
			node.logLines.splice(0, node.logLines.length - MAX_NODE_LOG_LINES);
		}
	}

	/** Apply a structured DagEvent to update node states */
	applyEvent(event: DagEvent): void {
		switch (event.type) {
			case "workflow_started":
				this.#workflowName = event.workflowName;
				this.#workflowDone = false;
				break;

			case "node_started":
				this.upsertNode(event.nodeId, {
					state: "running",
					startedAt: Date.now(),
					nodeType: event.nodeType,
					provider: event.provider,
				});
				this.#approvalNodeId = undefined;
				break;

			case "node_completed": {
				const startedAt = this.#nodes.get(event.nodeId)?.startedAt;
				this.upsertNode(event.nodeId, {
					state: "done",
					duration: event.duration,
					activeTool: undefined,
					startedAt,
					costUsd: event.costUsd,
					numTurns: event.numTurns,
				});
				break;
			}

			case "node_failed":
				this.upsertNode(event.nodeId, {
					state: "error",
					error: event.error,
					activeTool: undefined,
				});
				break;

			case "node_skipped":
				this.upsertNode(event.nodeId, {
					state: "skipped",
					skipReason: event.reason,
					activeTool: undefined,
				});
				break;

			case "approval_pending":
				this.upsertNode(event.nodeId, {
					state: "approval",
					approvalMessage: event.message,
					activeTool: undefined,
				});
				this.#approvalNodeId = event.nodeId;
				break;

			case "tool_started":
				this.#tools.set(`${event.stepName}:${event.toolName}:${Date.now()}`, {
					toolName: event.toolName,
					stepName: event.stepName,
					startedAt: Date.now(),
				});
				this.upsertNode(event.stepName, {
					activeTool: event.toolName,
				});
				break;

			case "tool_completed": {
				for (const [key, tool] of this.#tools) {
					if (
						tool.stepName === event.stepName &&
						tool.toolName === event.toolName &&
						tool.durationMs === undefined
					) {
						this.#tools.set(key, {
							...tool,
							durationMs: event.durationMs,
						});
						break;
					}
				}
				const node = this.#nodes.get(event.stepName);
				if (node?.activeTool === event.toolName) {
					this.upsertNode(event.stepName, {
						activeTool: undefined,
					});
				}
				break;
			}

			case "loop_iteration_started": {
				const existing = this.#nodes.get(event.nodeId);
				const iterations = existing?.iterations ?? [];
				iterations.push({
					iteration: event.iteration,
					state: "running",
				});
				this.upsertNode(event.nodeId, {
					iterations,
					currentIteration: event.iteration,
					maxIterations: event.maxIterations,
				});
				break;
			}

			case "loop_iteration_completed": {
				const existing = this.#nodes.get(event.nodeId);
				if (existing?.iterations) {
					const iterations = [...existing.iterations];
					const idx = iterations.findIndex(
						(it) => it.iteration === event.iteration,
					);
					if (idx >= 0) {
						iterations[idx] = {
							...iterations[idx],
							state: "completed",
							duration: event.duration,
						};
					}
					this.upsertNode(event.nodeId, {
						iterations,
						currentIteration: event.iteration,
						maxIterations: existing.maxIterations,
					});
				}
				break;
			}

			case "loop_iteration_failed": {
				const existing = this.#nodes.get(event.nodeId);
				if (existing?.iterations) {
					const iterations = [...existing.iterations];
					const idx = iterations.findIndex(
						(it) => it.iteration === event.iteration,
					);
					if (idx >= 0) {
						iterations[idx] = {
							...iterations[idx],
							state: "failed",
							error: event.error,
						};
					}
					this.upsertNode(event.nodeId, {
						iterations,
						currentIteration: event.iteration,
						maxIterations: existing.maxIterations,
					});
				}
				break;
			}

			case "workflow_completed":
				this.#workflowDone = true;
				this.#totalDurationMs = event.duration;
				break;

			case "workflow_failed":
				this.#workflowDone = true;
				this.#workflowError = event.error;
				break;
		}
	}

	// ─── Rendering helpers ──────────────────────────────────────

	/** Build a compact progress summary string, e.g. "2/5 · 1m30s" */
	progressSummary(elapsedSec: number): string {
		const count = `${this.completedCount}/${this.totalCount}`;
		const errBadge =
			this.errorCount > 0 ? ` · ${this.errorCount} error(s)` : "";
		return `${count}${errBadge} · ${formatElapsed(elapsedSec)}`;
	}

	/** Reset all state (for reuse across workflow runs) */
	reset(): void {
		this.#nodes.clear();
		this.#nodeOrder.length = 0;
		this.#tools.clear();
		this.#workflowName = undefined;
		this.#workflowDone = false;
		this.#workflowError = undefined;
		this.#totalDurationMs = undefined;
		this.#approvalNodeId = undefined;
	}

	// ─── Internal ───────────────────────────────────────────────

	setCurrentNodeTool(toolName: string): void {
		const nodeId = this.currentRunningNodeId;
		if (nodeId) this.upsertNode(nodeId, { activeTool: toolName });
	}

	private upsertNode(
		id: string,
		patch: Partial<DagNodeInfo> & { state?: DagNodeState },
	): void {
		const existing = this.#nodes.get(id);
		if (existing) {
			this.#nodes.set(id, { ...existing, ...patch });
		} else {
			const state = patch.state ?? "queued";
			const logLines = patch.logLines ?? [];
			const streamingText = patch.streamingText ?? "";
			const toolCalls = patch.toolCalls ?? [];
			this.#nodes.set(id, {
				id,
				...patch,
				state,
				logLines,
				streamingText,
				toolCalls,
			});
			this.#nodeOrder.push(id);
		}
	}
}

// ── Log noise filter ────────────────────────────────────────

/** Patterns for lines that should NOT be captured as node log output. */
const LOG_NOISE_PATTERNS = [
	// JSON structured log lines (pino format — handled by tryParseDagEvent)
	/^\{.*\}$/,
	// Bracket-prefixed log levels
	/^\[(?:INFO|WARN|ERR|DBG|LOG|EVT|INF|WRN)\]\s/,
	// Archon internal prefixes
	/^\[archon\]\s/,
	/^\[dotenv@\]/,
	/^\[(?:scout|planner|worker|reviewer|implementer|classifier|supervisor|task-merger|task-reviewer|task-worker)\]\s*/,
	// Workflow lifecycle status lines
	/^Running workflow:/i,
	/^Working directory:/i,
	/^Dispatching workflow:/i,
	/^🚀\s*Starting workflow:/,
	/^▶️\s*Resuming workflow/,
	/^❌\s*DAG workflow/,
	/^Workflow completed successfully\.$/,
	// Tool warning lines
	/^⚠️\s*Tool\s/,
];

/**
 * Check if a line is internal Archon noise that should not appear
 * in the node log inspector. Keeps AI responses, bash output,
 * error messages, and other meaningful text.
 */
function isLogNoise(line: string): boolean {
	return LOG_NOISE_PATTERNS.some((re) => re.test(line));
}
