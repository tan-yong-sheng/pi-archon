import type {
	DagEvent,
	DagNodeInfo,
	DagNodeState,
	LoopIterationInfo,
	ToolActivity,
} from "./types";
import { tryParseDagEvent } from "./output-filter";
import { formatElapsed } from "./helpers";

/**
 * DagProgressTracker maintains an ordered list of DAG nodes discovered
 * from Archon CLI stderr and updates their state in real-time.
 *
 * Also tracks loop iteration progress for nodes that run as loops.
 * Since the Archon CLI does not emit loop iteration events to stderr,
 * iteration data must be injected via applyEvent() (typically from
 * a periodic DB query during the run).
 *
 * Usage:
 * const tracker = new DagProgressTracker();
 * tracker.onLine("[investigate] Started", false);
 * tracker.onLine("[investigate] Completed (45s)", false);
 * console.log(tracker.nodes); // → [{ id: "investigate", state: "done", duration: "45s" }]
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
		return this.#nodeOrder
			.map((id) => this.#nodes.get(id)!)
			.filter(Boolean);
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
		return this.nodes.filter(
			(n) => n.state === "done" || n.state === "skipped",
		).length;
	}

	get errorCount(): number {
		return this.nodes.filter((n) => n.state === "error").length;
	}

	get totalCount(): number {
		return this.#nodeOrder.length;
	}

	get runningNodeIds(): readonly string[] {
		return this.nodes
			.filter((n) => n.state === "running")
			.map((n) => n.id);
	}

	/** Get the active tool for a specific node */
	getActiveTool(nodeId: string): ToolActivity | undefined {
		// Find the most recent unfinished tool for this node
		for (const tool of this.#tools.values()) {
			if (
				tool.stepName === nodeId &&
				tool.durationMs === undefined
			) {
				return tool;
			}
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
				this.#tools.set(
					`${event.stepName}:${event.toolName}:${Date.now()}`,
					{
						toolName: event.toolName,
						stepName: event.stepName,
						startedAt: Date.now(),
					},
				);
				this.upsertNode(event.stepName, {
					activeTool: event.toolName,
				});
				break;

			case "tool_completed": {
				// Find and update the matching tool
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
				// Clear activeTool only if it matches the completed tool
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
					// Update the matching iteration
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

	private upsertNode(
		id: string,
		patch: Partial<DagNodeInfo> & { state?: DagNodeState },
	): void {
		const existing = this.#nodes.get(id);
		if (existing) {
			this.#nodes.set(id, { ...existing, ...patch });
		} else {
			// New node — must provide a state
			const state = patch.state ?? "queued";
			this.#nodes.set(id, { id, ...patch, state });
			this.#nodeOrder.push(id);
		}
	}
}
