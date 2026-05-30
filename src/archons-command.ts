/**
 * /archons command — view and manage running Archon workflows.
 *
 * Shows a SelectList overlay with all active runs. User can:
 *   - Select a run to see details (node states, duration, progress)
 *   - Cancel a running workflow
 *   - Press Esc to dismiss
 *
 * Also accepts params like: /archons cancel <runId>
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type {
	Component,
	TUI,
	Theme,
} from "@mariozechner/pi-tui";
import { SelectList, type SelectItem } from "@mariozechner/pi-tui";
import {
	getActiveRuns,
	cancelRun,
	type ActiveWorkflowRun,
} from "./workflow-background";
import { handleArchonStatusCommand } from "./workflow-ops";
import { fmtElapsed, padLine } from "./ui/workflow-overlay";

// ── Completions for /archons ────────────────────────────────
export function buildArchonsCompletions(
  prefix: string,
): { value: string; description?: string }[] {
  const items = [
    { value: "status", description: "Full workflow status from Archon CLI" },
    { value: "cancel", description: "Cancel a running workflow by run ID" },
  ];
  // TODO: add workflow name completions for run dispatch (Task 1)
  if (prefix.length > 0) {
    return items.filter(
      (i) => i.value.startsWith(prefix),
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

	// Sub-command: status (full status from archon CLI)
	if (trimmed === "status") {
		await handleArchonStatusCommand(pi, ctx);
		return;
	}

	// Default: show active runs overlay
	const runs = getActiveRuns();

	if (runs.size === 0) {
		// No active runs — check if we have any via archon CLI too
		ctx.ui.notify?.("No active Archon workflows.", "info");
		// Also show the static status for reference
		await handleArchonStatusCommand(pi, ctx);
		return;
	}

	if (!ctx.hasUI) {
		// No UI — just print text
		pi.sendMessage?.(
			{
				customType: "archon",
				content: formatRunsAsText(runs),
				display: true,
				details: { action: "list_active_runs", count: runs.size },
			},
			{ deliverAs: "nextTurn" },
		);
		return;
	}

	// Show interactive overlay
	await ctx.ui.custom<string | null>(
		(
			tui: TUI,
			theme: Theme,
			_kb: unknown,
			done: (value: string | null) => void,
		) => {
			return new ArchonsOverlay(tui, theme, runs, done);
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 52,
				maxHeight: "60%",
			},
		},
	);
}

// ── Overlay component ────────────────────────────────────────

class ArchonsOverlay implements Component {
	private tui: TUI;
	private theme: Theme;
	private done: (value: string | null) => void;
	private runs: ReadonlyMap<string, ActiveWorkflowRun>;
	private list: SelectList;
	private detailRunId: string | null = null;
	private showDetail = false;

	constructor(
		tui: TUI,
		theme: Theme,
		runs: ReadonlyMap<string, ActiveWorkflowRun>,
		done: (value: string | null) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.runs = runs;
		this.done = done;

		const items = this.buildItems();
		this.list = new SelectList(items, 10, {
			selectedPrefix: (t: string) => theme.fg("accent", "▸ " + t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("dim", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("dim", t),
		});

		this.list.onSelect = (item: SelectItem) => {
			if (item.value === "__cancel__" && this.detailRunId) {
				void cancelRun(this.detailRunId);
				this.showDetail = false;
				this.detailRunId = null;
				this.tui.requestRender();
			} else if (item.value === "__back__") {
				this.showDetail = false;
				this.detailRunId = null;
				this.list = new SelectList(this.buildItems(), 10, {
					selectedPrefix: (t: string) => theme.fg("accent", "▸ " + t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("dim", t),
				});
				this.list.onSelect = this.list.onSelect;
				this.list.onCancel = this.list.onCancel;
				this.tui.requestRender();
			} else {
				// Show detail for this run
				this.detailRunId = item.value;
				this.showDetail = true;
				this.list = new SelectList(this.buildDetailItems(item.value), 10, {
					selectedPrefix: (t: string) => theme.fg("accent", "▸ " + t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("dim", t),
				});
				this.list.onSelect = this.list.onSelect;
				this.list.onCancel = this.list.onCancel;
				this.tui.requestRender();
			}
		};

		this.list.onCancel = () => {
			this.done(null);
		};
	}

	private buildItems(): SelectItem[] {
		const items: SelectItem[] = [];
		const th = this.theme;

		for (const [runId, entry] of this.runs) {
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
				: th.fg("accent", `◆ ${progress}`);

			items.push({
				value: runId,
				label: `${th.bold(entry.workflowName)} ${status} ${th.fg("dim", elapsed)}`,
				description: runId,
			});
		}

		return items;
	}

	private buildDetailItems(runId: string): SelectItem[] {
		const entry = this.runs.get(runId);
		const items: SelectItem[] = [];
		const th = this.theme;

		if (!entry) {
			items.push({
				value: "__back__",
				label: "← Back",
				description: "Run not found",
			});
			return items;
		}

		// Show node states
		const nodes = entry.tracker.nodes;
		for (const node of nodes) {
			const stateIcons: Record<string, string> = {
				queued: "○",
				running: "●",
				done: "✓",
				error: "✗",
				skipped: "⊘",
				approval: "⏸",
			};
			const stateColors: Record<string, string> = {
				queued: "dim",
				running: "accent",
				done: "success",
				error: "error",
				skipped: "warning",
				approval: "warning",
			};
			const icon = stateIcons[node.state] ?? "○";
			const color = stateColors[node.state] ?? "dim";
			const elapsed =
				node.state === "running" && node.startedAt
					? ` ${fmtElapsed(Math.floor((Date.now() - node.startedAt) / 1000))}`
					: node.duration
						? ` ${node.duration}`
						: "";

			items.push({
				value: `node-${node.id}`,
				label: `${th.fg(color, icon)} ${node.id}${th.fg("dim", elapsed)}`,
				description:
					node.error ?? node.skipReason ?? node.approvalMessage ?? node.state,
			});
		}

		// Actions
		items.push({
			value: "__cancel__",
			label: th.fg("error", "✕ Cancel this workflow"),
			description: `Cancel ${entry.workflowName} (${runId})`,
		});
		items.push({
			value: "__back__",
			label: "← Back to list",
			description: "",
		});

		return items;
	}

	render(width: number): string[] {
		const w = Math.max(width, 30);
		const th = this.theme;
		const border = (s: string) => th.fg("border", s);
		const bl = "│";
		const innerWidth = w - 2;

		const header =
			this.showDetail && this.detailRunId
				? `◆ archon runs — ${this.runs.get(this.detailRunId)?.workflowName ?? this.detailRunId}`
				: "◆ archon runs";

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

		// Footer
		const footer = th.fg("dim", " Enter=select · Esc=close ");
		lines.push(border("╰") + padLine(footer, innerWidth) + border("╯"));

		return lines;
	}

	handleInput(data: string): boolean {
		// Forward to SelectList
		this.list.handleInput(data);
		return true;
	}
}

// ── Text fallback (no UI) ────────────────────────────────────

function formatRunsAsText(
	runs: ReadonlyMap<string, ActiveWorkflowRun>,
): string {
	const lines = ["## Active Archon Workflows", ""];

	if (runs.size === 0) {
		lines.push("No active workflows.");
		lines.push("");
		return lines.join("\n");
	}

	for (const [runId, entry] of runs) {
		const elapsed = fmtElapsed(
			Math.floor((Date.now() - entry.startedAt) / 1000),
		);
		const progress = entry.tracker.progressSummary(
			Math.floor((Date.now() - entry.startedAt) / 1000),
		);
		lines.push(
			`- \`${runId}\` — **${entry.workflowName}** · ${progress} · ${elapsed}`,
		);
	}

	lines.push("");
	return lines.join("\n");
}
