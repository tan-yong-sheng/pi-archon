/**
 * /archons — Unified Archon workflow dashboard.
 *
 * Three-level drill-down inspired by Claude Code's /workflows:
 *
 * Level 1 — Run List: Active + Recent sections + dispatch input
 *   Keyboard: ↑/↓ select, Enter drill into run, Esc close,
 *             type to filter/dispatch, Tab autocomplete
 *
 * Level 2 — Run Detail: Node list grouped by state + artifacts
 *   Keyboard: ↑/↓ select, Enter drill into node, Esc back,
 *             'x' cancel active run
 *
 * Level 3 — Node Detail: Type, output/error, loop info, approval
 *   Keyboard: Esc back, 'a' approve (if approval), 'r' reject
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Component, TUI, Theme } from "@mariozechner/pi-tui";
import {
	SelectList,
	type SelectItem,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";
import {
	getActiveRuns,
	cancelRun,
	type ActiveWorkflowRun,
} from "./workflow-background";
import {
	queryRecentRuns,
	queryRunArtifacts,
	queryRunNodeSummaries,
	type WorkflowRunRecord,
	type WorkflowArtifact,
} from "./artifact-query";
import type { NodeSummaryRow } from "./types";
import { handleArchonStatusCommand } from "./workflow-ops";
import { fmtElapsed, padLine } from "./ui/workflow-overlay";
import { readProjectWorkflowNamesFromDisk } from "./workflow-discovery";
import { runWorkflowBackground } from "./workflow-background";

// ── Dashboard view levels ────────────────────────────────────
type ViewLevel = "run-list" | "run-detail" | "node-detail";

// ── Completions for /archons ─────────────────────────────────
export function buildArchonsCompletions(
	prefix: string,
): { value: string; description?: string }[] {
	const items = [
		{ value: "status", description: "Full workflow status from Archon CLI" },
		{ value: "cancel", description: "Cancel a running workflow by run ID" },
	];
	// Add workflow names as run targets
	const workflows = readProjectWorkflowNamesFromDisk();
	for (const name of workflows) {
		items.push({
			value: `run ${name}`,
			description: `Launch ${name} workflow`,
		});
	}
	if (prefix.length > 0) {
		return items.filter(
			(i) =>
				i.value.startsWith(prefix) ||
				i.description?.toLowerCase().includes(prefix.toLowerCase()),
		);
	}
	return items;
}

// ── Main handler ─────────────────────────────────────────────
export async function handleArchonsCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const trimmed = args.trim();

	// Sub-command: cancel <runId>
	if (trimmed.startsWith("cancel ")) {
		const runId = trimmed.slice(7).trim();
		if (!runId) {
			ctx.ui.notify?.("Usage: /archons cancel <runId>", "warning");
			return;
		}
		await cancelRun(runId);
		ctx.ui.notify?.(`Archon run ${runId} cancelled.`, "info");
		return;
	}

	// Sub-command: run <workflow> [query] — quick launch
	if (trimmed.startsWith("run ")) {
		const rest = trimmed.slice(4).trim();
		const parts = rest.split(/\s+/);
		const workflow = parts[0];
		const query = parts.slice(1).join(" ") || "run";
		if (!workflow) {
			ctx.ui.notify?.("Usage: /archons run <workflow> [query]", "warning");
			return;
		}
		const runId = runWorkflowBackground(pi, workflow, query, ctx);
		if (!runId) {
			ctx.ui.notify?.("Failed to start workflow (no UI available).", "warning");
		} else {
			ctx.ui.notify?.(`Workflow ${workflow} started (${runId}).`, "info");
		}
		return;
	}

	// Sub-command: status (full status from archon CLI)
	if (trimmed === "status") {
		await handleArchonStatusCommand(pi, ctx);
		return;
	}

	// Default: show the unified dashboard overlay
	if (!ctx.hasUI) {
		// No UI — text fallback
		const runs = getActiveRuns();
		let content = "## Archon Workflows\n\n";
		if (runs.size === 0) {
			content += "No active workflows.\n";
		} else {
			content += `**Active:** ${runs.size} run(s)\n`;
			for (const [runId, entry] of runs) {
				const elapsed = fmtElapsed(
					Math.floor((Date.now() - entry.startedAt) / 1000),
				);
				content += `- \`${runId}\` **${entry.workflowName}** · ${elapsed}\n`;
			}
		}
		pi.sendMessage?.(
			{ customType: "archon", content, display: true },
			{ deliverAs: "nextTurn" },
		);
		return;
	}

	// Show the interactive 3-level dashboard
	await ctx.ui.custom<string | null>(
		(
			tui: TUI,
			theme: Theme,
			_kb: unknown,
			done: (value: string | null) => void,
		) => {
			return new ArchonsDashboard(tui, theme, pi, ctx, done);
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: 56, maxHeight: "75%" },
		},
	);
}

// ── State icons & colors ─────────────────────────────────────
const STATE_ICONS: Record<string, string> = {
	queued: "○",
	running: "●",
	done: "✓",
	error: "✗",
	skipped: "⊘",
	approval: "⏸",
};

const STATE_COLORS: Record<string, string> = {
	queued: "dim",
	running: "accent",
	done: "success",
	error: "error",
	skipped: "warning",
	approval: "warning",
};

const STATUS_ICONS: Record<string, string> = {
	completed: "✓",
	failed: "✗",
	running: "●",
	cancelled: "⊘",
	pending: "○",
};

const STATUS_COLORS: Record<string, string> = {
	completed: "success",
	failed: "error",
	running: "accent",
	cancelled: "dim",
	pending: "dim",
};

// ── Dashboard component ──────────────────────────────────────
class ArchonsDashboard implements Component {
	private tui: TUI;
	private theme: Theme;
	private pi: ExtensionAPI;
	private ctx: ExtensionCommandContext;
	private done: (value: string | null) => void;

	// View state
	private level: ViewLevel = "run-list";
	private list: SelectList;
	private selectedRunId: string | null = null;
	private selectedNodeId: string | null = null;

	// Data
	private activeRuns: ReadonlyMap<string, ActiveWorkflowRun>;
	private recentRuns: WorkflowRunRecord[] = [];
	private runArtifacts: WorkflowArtifact[] = [];
	private nodeSummaries: NodeSummaryRow[] = [];
	private allWorkflows: string[] = [];

	// Polling for live updates
	private pollTimer?: ReturnType<typeof setInterval>;

	constructor(
		tui: TUI,
		theme: Theme,
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		done: (value: string | null) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.pi = pi;
		this.ctx = ctx;
		this.done = done;

		this.activeRuns = getActiveRuns();
		this.allWorkflows = readProjectWorkflowNamesFromDisk(
			ctx.cwd || process.cwd(),
		);

		// Load recent runs from DB
		this.loadRecentRuns();

		// Build initial run list
		this.list = this.buildRunList();

		// Poll for updates on active runs
		// IMPORTANT: preserve selected index across rebuilds to prevent
		// cursor from resetting to top every 1.5s
		this.pollTimer = setInterval(() => {
			const prevIndex = this.list.selectedIndex;
			if (this.level === "run-list") {
				this.activeRuns = getActiveRuns();
				this.list = this.buildRunList();
			} else if (this.level === "run-detail" && this.selectedRunId) {
				this.activeRuns = getActiveRuns();
				const entry = this.activeRuns.get(this.selectedRunId);
				if (entry) {
					this.list = this.buildRunDetailList(this.selectedRunId);
				}
			}
			// Restore cursor position after rebuild
			if (prevIndex > 0) {
				this.list.setSelectedIndex(
					Math.min(prevIndex, this.list.filteredItems.length - 1),
				);
			}
			this.tui.requestRender();
		}, 1500);
	}

	private async loadRecentRuns(): Promise<void> {
		try {
			const cwd = this.ctx.cwd || process.cwd();
			this.recentRuns = await queryRecentRuns(cwd, { limit: 15 });
			if (this.level === "run-list") {
				const prevIdx = this.list.selectedIndex;
				this.list = this.buildRunList();
				if (prevIdx > 0) {
					this.list.setSelectedIndex(
						Math.min(prevIdx, this.list.filteredItems.length - 1),
					);
				}
				this.tui.requestRender();
			}
		} catch {
			this.recentRuns = [];
		}
	}

	// ── Level 1: Run List ────────────────────────────────────
	private buildRunList(): SelectList {
		const th = this.theme;
		const items: SelectItem[] = [];

		// ── Active section ──
		const activeEntries = [...this.activeRuns.entries()];
		if (activeEntries.length > 0) {
			// Section header
			items.push({
				value: "__section_active__",
				label: th.fg("accent", th.bold(`◆ Active (${activeEntries.length})`)),
				description: "",
			});
			for (const [runId, entry] of activeEntries) {
				const elapsed = fmtElapsed(
					Math.floor((Date.now() - entry.startedAt) / 1000),
				);
				const progress = entry.tracker.progressSummary(
					Math.floor((Date.now() - entry.startedAt) / 1000),
				);
				const status = entry.tracker.workflowDone
					? entry.tracker.workflowError
						? th.fg("error", "✗ failed")
						: th.fg("success", "✓ done")
					: th.fg("accent", `● ${progress}`);
				items.push({
					value: `active:${runId}`,
					label: `${th.bold(entry.workflowName)} ${status} ${th.fg("dim", elapsed)}`,
					description: entry.query.slice(0, 60),
				});
			}
		}

		// ── Recent section ──
		if (this.recentRuns.length > 0) {
			// Filter out active runs that appear in recent
			const activeNames = new Set(activeEntries.map(([, e]) => e.workflowName));
			const nonActiveRecent = this.recentRuns.filter(
				(r) => r.status !== "running" || !activeNames.has(r.workflowName),
			);
			if (nonActiveRecent.length > 0) {
				items.push({
					value: "__section_recent__",
					label: th.fg("dim", th.bold(`○ Recent (${nonActiveRecent.length})`)),
					description: "",
				});
				for (const run of nonActiveRecent.slice(0, 10)) {
					const icon = STATUS_ICONS[run.status] ?? "○";
					const color = STATUS_COLORS[run.status] ?? "dim";
					const duration = run.durationMs
						? ` ${Math.round(run.durationMs / 1000)}s`
						: "";
					items.push({
						value: `recent:${run.id}`,
						label: `${th.fg(color, icon)} ${run.workflowName}${th.fg("dim", duration)}`,
						description: run.error
							? `Error: ${run.error.slice(0, 50)}`
							: run.status,
					});
				}
				if (nonActiveRecent.length > 10) {
					items.push({
						value: "__more__",
						label: th.fg("dim", `  … ${nonActiveRecent.length - 10} more`),
						description: "",
					});
				}
			}
		}

		// ── Dispatch section ──
		if (this.allWorkflows.length > 0) {
			items.push({
				value: "__section_launch__",
				label: th.fg("dim", th.bold("▶ Launch")),
				description: "",
			});
			for (const name of this.allWorkflows.slice(0, 8)) {
				items.push({
					value: `launch:${name}`,
					label: `${th.fg("accent", "▸")} ${name}`,
					description: "↵ Enter to launch",
				});
			}
		}

		// Empty state
		if (items.length === 0) {
			items.push({
				value: "__empty__",
				label: th.fg("dim", "No workflows found."),
				description: "Add .archon/workflows/*.yaml to get started",
			});
		}

		const list = new SelectList(items, 12, {
			selectedPrefix: (t: string) => th.fg("accent", "▸ " + t),
			selectedText: (t: string) => th.fg("accent", t),
			description: (t: string) => th.fg("dim", t),
			scrollInfo: (t: string) => th.fg("dim", t),
			noMatch: (t: string) => th.fg("dim", t),
		});
		list.onSelect = (item: SelectItem) => this.onRunListSelect(item);
		list.onCancel = () => this.dismiss();
		return list;
	}

	private onRunListSelect(item: SelectItem): void {
		const val = item.value;

		// Section headers — skip to next selectable item
		if (
			val.startsWith("__section_") ||
			val === "__more__" ||
			val === "__empty__"
		) {
			const nextIdx = this.list.selectedIndex + 1;
			if (nextIdx < this.list.filteredItems.length) {
				this.list.setSelectedIndex(nextIdx);
			}
			return;
		}

		// Active run — drill into detail
		if (val.startsWith("active:")) {
			this.selectedRunId = val.slice(7);
			this.level = "run-detail";
			this.list = this.buildRunDetailList(this.selectedRunId!);
			this.tui.requestRender();
			return;
		}

		// Recent run — drill into detail
		if (val.startsWith("recent:")) {
			this.selectedRunId = val.slice(8);
			this.level = "run-detail";
			void this.loadRunDetailData(this.selectedRunId!);
			this.list = this.buildRunDetailList(this.selectedRunId!);
			this.tui.requestRender();
			return;
		}

		// Launch — start the workflow
		if (val.startsWith("launch:")) {
			const workflowName = val.slice(7);
			const runId = runWorkflowBackground(
				this.pi,
				workflowName,
				"run",
				this.ctx,
			);
			if (runId) {
				this.ctx.ui.notify?.(`${workflowName} started (${runId})`, "info");
			}
			this.dismiss();
			return;
		}
	}

	// ── Level 2: Run Detail ──────────────────────────────────
	private buildRunDetailList(runId: string): SelectList {
		const th = this.theme;
		const items: SelectItem[] = [];
		const entry = this.activeRuns.get(runId);

		if (entry) {
			// Active run — show live node states
			const nodes = entry.tracker.nodes;

			// Group by state
			const running = nodes.filter((n) => n.state === "running");
			const approval = nodes.filter((n) => n.state === "approval");
			const done = nodes.filter((n) => n.state === "done");
			const failed = nodes.filter((n) => n.state === "error");
			const skipped = nodes.filter((n) => n.state === "skipped");
			const queued = nodes.filter((n) => n.state === "queued");

			if (running.length > 0) {
				items.push({
					value: "__section_running__",
					label: th.fg("accent", th.bold(`● Running (${running.length})`)),
					description: "",
				});
				for (const node of running) {
					const elapsed = node.startedAt
						? ` ${fmtElapsed(Math.floor((Date.now() - node.startedAt) / 1000))}`
						: "";
					const iterBadge =
						node.currentIteration && node.maxIterations
							? ` ${th.fg("accent", `${node.currentIteration}/${node.maxIterations}`)}`
							: node.currentIteration
								? ` ${th.fg("accent", `iter ${node.currentIteration}`)}`
								: "";
					const toolBadge = node.activeTool
						? ` ${th.fg("dim", `→ ${node.activeTool}`)}`
						: "";
					items.push({
						value: `node:${node.id}`,
						label: `${th.fg("accent", "●")} ${node.id}${node.nodeType ? th.fg("muted", ` [${node.nodeType}]`) : ""}${th.fg("dim", elapsed)}${iterBadge}${toolBadge}`,
						description: node.approvalMessage ?? node.state,
					});
				}
			}

			if (approval.length > 0) {
				items.push({
					value: "__section_approval__",
					label: th.fg(
						"warning",
						th.bold(`⏸ Awaiting Approval (${approval.length})`),
					),
					description: "",
				});
				for (const node of approval) {
					items.push({
						value: `node:${node.id}`,
						label: `${th.fg("warning", "⏸")} ${node.id}`,
						description: node.approvalMessage ?? "Pending approval",
					});
				}
			}

			if (done.length > 0) {
				items.push({
					value: "__section_done__",
					label: th.fg("success", th.bold(`✓ Completed (${done.length})`)),
					description: "",
				});
				for (const node of done) {
					const dur = node.duration ? ` ${node.duration}` : "";
					items.push({
						value: `node:${node.id}`,
						label: `${th.fg("success", "✓")} ${node.id}${th.fg("dim", dur)}`,
						description: "Completed",
					});
				}
			}

			if (failed.length > 0) {
				items.push({
					value: "__section_failed__",
					label: th.fg("error", th.bold(`✗ Failed (${failed.length})`)),
					description: "",
				});
				for (const node of failed) {
					const err = node.error ? ` — ${node.error.slice(0, 60)}` : "";
					items.push({
						value: `node:${node.id}`,
						label: `${th.fg("error", "✗")} ${node.id}${th.fg("dim", err)}`,
						description: node.error ?? "Failed",
					});
				}
			}

			if (skipped.length > 0) {
				items.push({
					value: "__section_skipped__",
					label: th.fg("warning", th.bold(`⊘ Skipped (${skipped.length})`)),
					description: "",
				});
				for (const node of skipped) {
					const reason = node.skipReason ? ` — ${node.skipReason}` : "";
					items.push({
						value: `node:${node.id}`,
						label: `${th.fg("warning", "⊘")} ${node.id}${th.fg("dim", reason)}`,
						description: node.skipReason ?? "Skipped",
					});
				}
			}

			if (queued.length > 0) {
				items.push({
					value: "__section_queued__",
					label: th.fg("dim", th.bold(`○ Queued (${queued.length})`)),
					description: "",
				});
				for (const node of queued) {
					items.push({
						value: `node:${node.id}`,
						label: `${th.fg("dim", "○")} ${node.id}`,
						description: "Waiting for dependencies",
					});
				}
			}

			// Artifacts section
			if (this.runArtifacts.length > 0) {
				items.push({
					value: "__section_artifacts__",
					label: th.fg(
						"success",
						th.bold(`📦 Artifacts (${this.runArtifacts.length})`),
					),
					description: "",
				});
				for (const art of this.runArtifacts) {
					const icon =
						art.type === "pr"
							? "🔀"
							: art.type === "commit"
								? "📝"
								: art.type === "branch"
									? "🌿"
									: "📄";
					items.push({
						value: `artifact:${art.label}`,
						label: `${icon} ${art.label}`,
						description: art.url ?? art.path ?? art.type,
					});
				}
			}

			// Cancel action (if still running)
			if (!entry.tracker.workflowDone) {
				items.push({
					value: "__cancel__",
					label: th.fg("error", "✕ Cancel this workflow"),
					description: `Cancel ${entry.workflowName} (${runId})`,
				});
			}
		} else {
			// Recent run (not active) — show DB data
			const record = this.recentRuns.find((r) => r.id === runId);

			if (this.nodeSummaries.length > 0) {
				items.push({
					value: "__section_nodes__",
					label: th.fg("dim", th.bold(`Nodes (${this.nodeSummaries.length})`)),
					description: "",
				});
				for (const node of this.nodeSummaries) {
					const icon = STATE_ICONS[node.state ?? "queued"] ?? "○";
					const color = STATE_COLORS[node.state ?? "queued"] ?? "dim";
					const dur = node.durationMs
						? ` ${Math.round(node.durationMs / 1000)}s`
						: "";
					items.push({
						value: `dbnode:${node.nodeId}`,
						label: `${th.fg(color, icon)} ${node.nodeId}${th.fg("dim", dur)}`,
						description: node.error ?? node.state ?? "",
					});
				}
			}

			if (this.runArtifacts.length > 0) {
				items.push({
					value: "__section_artifacts__",
					label: th.fg(
						"success",
						th.bold(`📦 Artifacts (${this.runArtifacts.length})`),
					),
					description: "",
				});
				for (const art of this.runArtifacts) {
					items.push({
						value: `artifact:${art.label}`,
						label: `📄 ${art.label}`,
						description: art.url ?? art.path ?? art.type,
					});
				}
			}

			if (record?.error) {
				items.push({
					value: "__error__",
					label: th.fg("error", `Error: ${record.error.slice(0, 80)}`),
					description: "",
				});
			}
		}

		// Back action
		items.push({
			value: "__back__",
			label: th.fg("dim", "← Back to workflow list"),
			description: "",
		});

		const list = new SelectList(items, 14, {
			selectedPrefix: (t: string) => th.fg("accent", "▸ " + t),
			selectedText: (t: string) => th.fg("accent", t),
			description: (t: string) => th.fg("dim", t),
			scrollInfo: (t: string) => th.fg("dim", t),
			noMatch: (t: string) => th.fg("dim", t),
		});
		list.onSelect = (item: SelectItem) => this.onRunDetailSelect(item);
		list.onCancel = () => this.goBack();
		return list;
	}

	private async loadRunDetailData(runId: string): Promise<void> {
		try {
			this.runArtifacts = await queryRunArtifacts(runId);
		} catch {
			this.runArtifacts = [];
		}
		try {
			this.nodeSummaries = await queryRunNodeSummaries(runId);
		} catch {
			this.nodeSummaries = [];
		}
	}

	private onRunDetailSelect(item: SelectItem): void {
		const val = item.value;

		// Section headers — skip to next selectable item
		if (val.startsWith("__section_") || val === "__error__") {
			const nextIdx = this.list.selectedIndex + 1;
			if (nextIdx < this.list.filteredItems.length) {
				this.list.setSelectedIndex(nextIdx);
			}
			return;
		}

		// Back
		if (val === "__back__") {
			this.goBack();
			return;
		}

		// Cancel
		if (val === "__cancel__" && this.selectedRunId) {
			void cancelRun(this.selectedRunId);
			this.ctx.ui.notify?.("Workflow cancelled.", "info");
			this.goBack();
			return;
		}

		// Node drill-down
		if (val.startsWith("node:") || val.startsWith("dbnode:")) {
			this.selectedNodeId = val.includes(":")
				? val.slice(val.indexOf(":") + 1)
				: val;
			this.level = "node-detail";
			this.list = this.buildNodeDetailList(this.selectedNodeId!);
			this.tui.requestRender();
			return;
		}
	}

	// ── Level 3: Node Detail ─────────────────────────────────
	private buildNodeDetailList(nodeId: string): SelectList {
		const th = this.theme;
		const items: SelectItem[] = [];

		// Find the node data
		const entry = this.selectedRunId
			? this.activeRuns.get(this.selectedRunId)
			: undefined;
		const node = entry?.tracker.nodes.find((n) => n.id === nodeId);
		const dbNode = this.nodeSummaries.find((n) => n.nodeId === nodeId);

		// Node header
		const nodeName = node?.id ?? dbNode?.nodeId ?? nodeId;
		const nodeState = node?.state ?? dbNode?.state ?? "unknown";
		const icon = STATE_ICONS[nodeState] ?? "○";
		const color = STATE_COLORS[nodeState] ?? "dim";

		items.push({
			value: "__header__",
			label: `${th.fg(color, icon)} ${th.bold(nodeName)} ${th.fg(color, nodeState)}`,
			description: "",
		});

		// Duration
		if (node?.duration) {
			items.push({
				value: "__duration__",
				label: `  Duration: ${node.duration}`,
				description: "",
			});
		} else if (dbNode?.durationMs) {
			items.push({
				value: "__duration__",
				label: `  Duration: ${Math.round(dbNode.durationMs / 1000)}s`,
				description: "",
			});
		}

		// Type info from DB
		if (dbNode?.outputPreview) {
			items.push({
				value: "__output__",
				label: `  Output: ${dbNode.outputPreview.slice(0, 80)}`,
				description: "",
			});
		}

		// Error
		if (node?.error) {
			items.push({
				value: "__error__",
				label: th.fg("error", `  Error: ${node.error.slice(0, 80)}`),
				description: "",
			});
		} else if (dbNode?.error) {
			items.push({
				value: "__error__",
				label: th.fg("error", `  Error: ${dbNode.error.slice(0, 80)}`),
				description: "",
			});
		}

		// Skip reason
		if (node?.skipReason) {
			items.push({
				value: "__skip__",
				label: th.fg("warning", `  Skip reason: ${node.skipReason}`),
				description: "",
			});
		}

		// Approval message
		if (node?.approvalMessage) {
			items.push({
				value: "__approval__",
				label: th.fg("warning", `  Approval: ${node.approvalMessage}`),
				description: "",
			});
		}

		// Loop iterations
		if (node?.iterations && node.iterations.length > 0) {
			items.push({
				value: "__section_iterations__",
				label: th.fg("accent", `  Iterations (${node.iterations.length})`),
				description: "",
			});
			for (const iter of node.iterations) {
				const iterIcon =
					iter.state === "completed"
						? "✓"
						: iter.state === "failed"
							? "✗"
							: "●";
				const iterColor =
					iter.state === "completed"
						? "success"
						: iter.state === "failed"
							? "error"
							: "accent";
				const dur = iter.duration ? ` ${iter.duration}` : "";
				const err = iter.error ? ` — ${iter.error.slice(0, 40)}` : "";
				items.push({
					value: `iter:${iter.iteration}`,
					label: `${th.fg(iterColor, `    ${iterIcon}`)} #${iter.iteration}${th.fg("dim", dur)}${th.fg("dim", err)}`,
					description: "",
				});
			}
		}

		// Back action
		items.push({
			value: "__back__",
			label: th.fg("dim", "← Back to run detail"),
			description: "",
		});

		const list = new SelectList(items, 14, {
			selectedPrefix: (t: string) => th.fg("accent", "▸ " + t),
			selectedText: (t: string) => th.fg("accent", t),
			description: (t: string) => th.fg("dim", t),
			scrollInfo: (t: string) => th.fg("dim", t),
			noMatch: (t: string) => th.fg("dim", t),
		});
		list.onSelect = () => {}; // No drill-down from node detail
		list.onCancel = () => this.goBack();
		return list;
	}

	// ── Navigation helpers ───────────────────────────────────
	private goBack(): void {
		if (this.level === "node-detail") {
			this.level = "run-detail";
			this.selectedNodeId = null;
			if (this.selectedRunId) {
				this.list = this.buildRunDetailList(this.selectedRunId);
			}
		} else if (this.level === "run-detail") {
			this.level = "run-list";
			this.selectedRunId = null;
			this.runArtifacts = [];
			this.nodeSummaries = [];
			this.list = this.buildRunList();
		} else {
			this.dismiss();
			return;
		}
		this.tui.requestRender();
	}

	private dismiss(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.done(null);
	}

	// ── Component interface ──────────────────────────────────
	render(width: number): string[] {
		const w = Math.max(width, 30);
		const th = this.theme;
		const border = (s: string) => th.fg("border", s);
		const bl = "│";
		const innerWidth = w - 2;

		// Header
		let header: string;
		if (this.level === "run-list") {
			header = "◆ archon workflows";
		} else if (this.level === "run-detail") {
			const entry = this.selectedRunId
				? this.activeRuns.get(this.selectedRunId)
				: undefined;
			const record = this.recentRuns.find((r) => r.id === this.selectedRunId);
			const name =
				entry?.workflowName ?? record?.workflowName ?? this.selectedRunId ?? "";
			header = `◆ ${name}`;
		} else {
			header = `◆ node: ${this.selectedNodeId ?? ""}`;
		}

		const lines: string[] = [];
		lines.push(border("╭") + border("─".repeat(innerWidth)) + border("╮"));
		lines.push(
			border(bl) + padLine(` ${th.bold(header)}`, innerWidth) + border(bl),
		);
		lines.push(border(bl) + border("├" + "─".repeat(innerWidth - 1) + "┤"));

		// SelectList content
		const listLines = this.list.render(innerWidth);
		for (const line of listLines) {
			lines.push(border(bl) + " " + line + border(bl));
		}

		// Footer with keyboard hints
		let footer: string;
		if (this.level === "run-list") {
			footer = " Enter=open/launch · ↑/↓ navigate · Esc=close ";
		} else if (this.level === "run-detail") {
			footer = " Enter=drill in · Esc=back ";
		} else {
			footer = " Esc=back ";
		}
		lines.push(
			border("╰") + padLine(th.fg("dim", footer), innerWidth) + border("╯"),
		);

		return lines;
	}

	handleInput(data: string): boolean {
		// Esc at top level dismisses
		if (matchesKey(data, Key.escape) && this.level === "run-list") {
			// Let SelectList handle it first (it may close itself)
			// If we're here, SelectList already handled its onCancel → dismiss
			this.dismiss();
			return true;
		}
		// Forward to SelectList
		this.list.handleInput(data);
		return true;
	}
}
