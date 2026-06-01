/**
 * Archon SSE Client — real-time workflow event stream.
 *
 * Two connection types:
 * 1. Dashboard SSE (`/api/stream/__dashboard__`) — multiplexed stream
 *    receiving ALL workflow events (node status, tool activity, loop
 *    iterations, artifacts, workflow lifecycle).
 *
 * 2. Conversation SSE (`/api/stream/:conversationId`) — per-conversation
 *    stream receiving real-time AI output (text streaming, tool calls
 *    with input/output, errors). This is what the Archon Web UI uses
 *    in its WorkflowLogs component to show live node output.
 *
 * Usage:
 *   // Dashboard events (node status changes):
 *   const dashboard = new ArchonSSEClient('http://127.0.0.1:3090');
 *   dashboard.onEvent = (event) => { ... };
 *   await dashboard.connect();
 *
 *   // Conversation events (streaming AI output):
 *   const conversation = new ArchonConversationSSE('http://127.0.0.1:3090', conversationId);
 *   conversation.onText = (content) => { ... };
 *   conversation.onToolCall = (name, input) => { ... };
 *   conversation.onToolResult = (name, output, duration) => { ... };
 *   await conversation.connect();
 */

// ── Dashboard SSE Types ──────────────────────────────────────

export interface SSEWorkflowStatusEvent {
	type: "workflow_status";
	runId: string;
	workflowName?: string;
	status: "running" | "completed" | "failed" | "paused" | "cancelled";
	error?: string;
	timestamp: number;
	approval?: { nodeId: string; message: string };
}

export interface SSEDagNodeEvent {
	type: "dag_node";
	runId: string;
	nodeId: string;
	name: string;
	status: "running" | "completed" | "failed" | "skipped";
	duration?: number;
	error?: string;
	reason?: string;
	timestamp: number;
}

export interface SSEToolActivityEvent {
	type: "workflow_tool_activity";
	runId: string;
	toolName: string;
	stepName: string;
	status: "started" | "completed";
	durationMs?: number;
	timestamp: number;
}

export interface SSEWorkflowStepEvent {
	type: "workflow_step";
	runId: string;
	nodeId?: string;
	step: number;
	total: number;
	name: string;
	status: "running" | "completed" | "failed";
	iteration?: number;
	duration?: number;
	timestamp: number;
}

export interface SSEWorkflowArtifactEvent {
	type: "workflow_artifact";
	runId: string;
	artifactType: string;
	label: string;
	url?: string;
	path?: string;
	timestamp: number;
}

export interface SSEHeartbeatEvent {
	type: "heartbeat";
	timestamp: number;
}

export type ArchonSSEEvent =
	| SSEWorkflowStatusEvent
	| SSEDagNodeEvent
	| SSEToolActivityEvent
	| SSEWorkflowStepEvent
	| SSEWorkflowArtifactEvent
	| SSEHeartbeatEvent;

// ── Conversation SSE Types ───────────────────────────────────

/** AI text streaming event from conversation SSE */
export interface SSETextEvent {
	type: "text";
	content: string;
	isComplete: boolean;
	workflowResult?: { workflowName: string; runId: string };
}

/** Tool call started event */
export interface SSEToolCallEvent {
	type: "tool_call";
	name: string;
	input: Record<string, unknown>;
	toolCallId?: string;
}

/** Tool result completed event */
export interface SSEToolResultEvent {
	type: "tool_result";
	name: string;
	output: string;
	duration: number;
	toolCallId?: string;
}

/** Error event */
export interface SSEErrorEvent {
	type: "error";
	message: string;
	classification?: string;
	suggestedActions?: string[];
}

/** Workflow dispatch event (parent → worker notification) */
export interface SSEWorkflowDispatchEvent {
	type: "workflow_dispatch";
	workerConversationId: string;
	workflowName: string;
}

/** Retract event (workflow routing detected) */
export interface SSERetractEvent {
	type: "retract";
}

export type ArchonConversationEvent =
	| SSETextEvent
	| SSEToolCallEvent
	| SSEToolResultEvent
	| SSEErrorEvent
	| SSEWorkflowDispatchEvent
	| SSERetractEvent
	| SSEHeartbeatEvent;

// ── Dashboard SSE Client ─────────────────────────────────────

export class ArchonSSEClient {
	private baseUrl: string;
	private eventSource: EventSource | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 10;
	private _connected = false;

	/** Called for every parsed SSE event (except heartbeats) */
	onEvent?: (event: ArchonSSEEvent) => void;

	/** Called when connection state changes */
	onConnectionChange?: (connected: boolean) => void;

	/** Filter: only events matching this runId are forwarded (null = all) */
	runIdFilter: string | null = null;

	constructor(baseUrl = "http://127.0.0.1:3090") {
		this.baseUrl = baseUrl;
	}

	get connected(): boolean {
		return this._connected;
	}

	/** Connect to the Archon dashboard SSE stream */
	async connect(): Promise<boolean> {
		if (this.eventSource) {
			return this._connected;
		}

		return new Promise((resolve) => {
			try {
				const url = `${this.baseUrl}/api/stream/__dashboard__`;
				this.eventSource = new EventSource(url);

				this.eventSource.onopen = () => {
					this._connected = true;
					this.reconnectAttempts = 0;
					this.onConnectionChange?.(true);
					resolve(true);
				};

				this.eventSource.onmessage = (msg) => {
					this.handleMessage(msg.data);
				};

				this.eventSource.onerror = () => {
					this._connected = false;
					this.onConnectionChange?.(false);
					this.eventSource?.close();
					this.eventSource = null;
					resolve(false);
					this.scheduleReconnect();
				};
			} catch {
				resolve(false);
				this.scheduleReconnect();
			}
		});
	}

	/** Disconnect from the SSE stream */
	disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
		this._connected = false;
		this.reconnectAttempts = this.maxReconnectAttempts; // prevent reconnect
		this.onConnectionChange?.(false);
	}

	/** Parse and dispatch an SSE message */
	private handleMessage(data: string): void {
		try {
			const event = JSON.parse(data) as ArchonSSEEvent;

			// Filter heartbeats
			if (event.type === "heartbeat") return;

			// Apply runId filter if set
			if (this.runIdFilter) {
				const eventRunId = (event as unknown as Record<string, unknown>)
					.runId as string | undefined;
				if (eventRunId && eventRunId !== this.runIdFilter) return;
			}

			this.onEvent?.(event);
		} catch {
			// Non-JSON message — ignore
		}
	}

	/** Schedule a reconnection attempt with exponential backoff */
	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

		const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
		this.reconnectAttempts++;

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			await this.connect();
		}, delay);
	}
}

// ── Conversation SSE Client ──────────────────────────────────

export class ArchonConversationSSE {
	private baseUrl: string;
	private conversationId: string;
	private eventSource: EventSource | null = null;
	private _connected = false;
	private textBuffer = "";
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	/** Called with accumulated text (batched at 50ms intervals, matching Web UI) */
	onText?: (
		content: string,
		workflowResult?: { workflowName: string; runId: string },
	) => void;

	/** Called when a tool starts executing */
	onToolCall?: (
		name: string,
		input: Record<string, unknown>,
		toolCallId?: string,
	) => void;

	/** Called when a tool completes with output */
	onToolResult?: (
		name: string,
		output: string,
		duration: number,
		toolCallId?: string,
	) => void;

	/** Called on errors */
	onError?: (message: string, classification?: string) => void;

	/** Called when workflow dispatch event is received */
	onWorkflowDispatch?: (
		workerConversationId: string,
		workflowName: string,
	) => void;

	/** Called when retract event is received */
	onRetract?: () => void;

	/** Called when connection state changes */
	onConnectionChange?: (connected: boolean) => void;

	constructor(baseUrl = "http://127.0.0.1:3090", conversationId: string) {
		this.baseUrl = baseUrl;
		this.conversationId = conversationId;
	}

	get connected(): boolean {
		return this._connected;
	}

	/** Flush accumulated text buffer */
	private flushText = (): void => {
		if (this.textBuffer) {
			this.onText?.(this.textBuffer, this._pendingWorkflowResult);
			this.textBuffer = "";
			this._pendingWorkflowResult = undefined;
		}
		this.flushTimer = null;
	};

	private _pendingWorkflowResult?: { workflowName: string; runId: string };

	/** Connect to the conversation SSE stream */
	async connect(): Promise<boolean> {
		if (this.eventSource) {
			return this._connected;
		}

		return new Promise((resolve) => {
			try {
				const url = `${this.baseUrl}/api/stream/${encodeURIComponent(this.conversationId)}`;
				this.eventSource = new EventSource(url);

				this.eventSource.onopen = () => {
					this._connected = true;
					this.onConnectionChange?.(true);
					resolve(true);
				};

				this.eventSource.onmessage = (msg) => {
					this.handleMessage(msg.data);
				};

				this.eventSource.onerror = () => {
					this._connected = false;
					this.onConnectionChange?.(false);
					this.flushText(); // flush any buffered text
					this.eventSource?.close();
					this.eventSource = null;
					resolve(false);
				};
			} catch {
				resolve(false);
			}
		});
	}

	/** Disconnect from the conversation SSE stream */
	disconnect(): void {
		this.flushText();
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
		this._connected = false;
		this.onConnectionChange?.(false);
	}

	/** Parse and dispatch a conversation SSE message */
	private handleMessage(data: string): void {
		try {
			const event = JSON.parse(data) as ArchonConversationEvent;

			switch (event.type) {
				case "text": {
					// Batch text at 50ms intervals, matching Archon Web UI
					if (
						"workflowResult" in event &&
						event.workflowResult &&
						typeof event.workflowResult === "object"
					) {
						this._pendingWorkflowResult = event.workflowResult as {
							workflowName: string;
							runId: string;
						};
					}
					this.textBuffer += event.content;
					if (!this.flushTimer) {
						this.flushTimer = setTimeout(this.flushText, 50);
					}
					break;
				}
				case "tool_call": {
					// Flush buffered text before tool events
					if (this.textBuffer && this.flushTimer) {
						clearTimeout(this.flushTimer);
						this.flushTimer = null;
						this.flushText();
					}
					this.onToolCall?.(event.name, event.input, event.toolCallId);
					break;
				}
				case "tool_result": {
					// Flush buffered text before tool results
					if (this.textBuffer && this.flushTimer) {
						clearTimeout(this.flushTimer);
						this.flushTimer = null;
						this.flushText();
					}
					this.onToolResult?.(
						event.name,
						event.output,
						event.duration,
						event.toolCallId,
					);
					break;
				}
				case "error": {
					this.onError?.(event.message, event.classification);
					break;
				}
				case "workflow_dispatch": {
					this.onWorkflowDispatch?.(
						event.workerConversationId,
						event.workflowName,
					);
					break;
				}
				case "retract": {
					this.onRetract?.();
					break;
				}
				case "heartbeat":
					// Ignore
					break;
			}
		} catch {
			// Non-JSON message — ignore
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────

/** Format an SSE duration (ms number) to a human-readable string matching
 *  the Archon CLI format: "45ms", "5s", "1m30s".
 */
function formatSSEDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1000) return `${ms}ms`;
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}

// ── SSE → DagEvent mapper ────────────────────────────────────
// Maps Archon SSE events back to the DagEvent types that DagProgressTracker understands.

import type { DagEvent } from "./types";

export function mapSSEToDagEvent(event: ArchonSSEEvent): DagEvent | null {
	switch (event.type) {
		case "dag_node":
			switch (event.status) {
				case "running":
					return {
						type: "node_started",
						nodeId: event.nodeId,
					};
				case "completed":
					return {
						type: "node_completed",
						nodeId: event.nodeId,
						duration: formatSSEDuration(event.duration),
						durationMs: event.duration,
					};
				case "failed":
					return {
						type: "node_failed",
						nodeId: event.nodeId,
						error: event.error ?? "Node failed",
					};
				case "skipped":
					return {
						type: "node_skipped",
						nodeId: event.nodeId,
						reason: event.reason ?? "unknown",
					};
			}
			return null;

		case "workflow_tool_activity":
			if (event.status === "started") {
				return {
					type: "tool_started",
					toolName: event.toolName,
					stepName: event.stepName,
				};
			}
			return {
				type: "tool_completed",
				toolName: event.toolName,
				stepName: event.stepName,
				durationMs: event.durationMs,
			};

		case "workflow_status":
			if (event.status === "running") {
				return {
					type: "workflow_started",
					workflowName: event.workflowName ?? "",
				};
			}
			if (event.status === "completed") {
				return { type: "workflow_completed" };
			}
			if (event.status === "failed") {
				return {
					type: "workflow_failed",
					error: event.error ?? "Workflow failed",
				};
			}
			if (event.status === "paused" && event.approval) {
				return {
					type: "approval_pending",
					nodeId: event.approval.nodeId,
					message: event.approval.message,
				};
			}
			if (event.status === "cancelled") {
				return { type: "workflow_completed" };
			}
			return null;

		case "workflow_step":
			if (event.status === "running") {
				return {
					type: "loop_iteration_started",
					iteration: event.iteration ?? event.step + 1,
					maxIterations: event.total,
					nodeId: event.nodeId,
				};
			}
			if (event.status === "completed") {
				return {
					type: "loop_iteration_completed",
					iteration: event.iteration ?? event.step + 1,
					duration: event.duration,
					nodeId: event.nodeId,
				};
			}
			if (event.status === "failed") {
				return {
					type: "loop_iteration_failed",
					iteration: event.iteration ?? event.step + 1,
					error: "Iteration failed",
					nodeId: event.nodeId,
				};
			}
			return null;

		case "workflow_artifact":
			// No DagEvent type for artifacts yet — handled separately
			return null;

		default:
			return null;
	}
}

// ── Singleton for shared SSE connection ───────────────────────

let sharedClient: ArchonSSEClient | null = null;

/**
 * Get or create a shared SSE client connected to the Archon server.
 * Returns null if the server is not reachable.
 */
export async function getSharedSSEClient(
	baseUrl = "http://127.0.0.1:3090",
): Promise<ArchonSSEClient | null> {
	if (sharedClient?.connected) return sharedClient;

	// Check if server is running
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		const res = await fetch(`${baseUrl}/api/health`, {
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return null;
	} catch {
		return null;
	}

	// Create and connect
	sharedClient = new ArchonSSEClient(baseUrl);
	const connected = await sharedClient.connect();
	if (!connected) {
		sharedClient = null;
		return null;
	}
	return sharedClient;
}

/** Disconnect the shared SSE client */
export function disconnectSharedSSE(): void {
	if (sharedClient) {
		sharedClient.disconnect();
		sharedClient = null;
	}
}
