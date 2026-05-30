/**
 * WorkflowOverlay — non-capturing overlay popup showing live DAG progress.
 *
 * Anchored top-right, compact: shows node states, elapsed time, and
 * an optional cancel hint. Designed to float over the terminal
 * while the user continues working.
 *
 * This component is created inside a ctx.ui.custom() callback and
 * attached to the screen via tui.showOverlay(component, { nonCapturing: true }).
 * The TUI system calls render() each frame; we call tui.requestRender()
 * after updating tracker state.
 */

import type { Component, Theme } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { DagProgressTracker } from "../dag-tracker";
import type { DagNodeState } from "../types";

// ── State icons ──────────────────────────────────────────────
const NODE_ICONS: Record<DagNodeState, string> = {
	queued: "○",
	running: "●",
	done: "✓",
	error: "✗",
	skipped: "⊘",
	approval: "⏸",
};

const NODE_COLORS: Record<
	DagNodeState,
	"accent" | "success" | "error" | "warning" | "muted" | "dim"
> = {
	queued: "dim",
	running: "accent",
	done: "success",
	error: "error",
	skipped: "warning",
	approval: "warning",
};

// ── Public config ────────────────────────────────────────────
export interface WorkflowOverlayOptions {
	workflowName: string;
	queryPreview: string;
	dagTracker: DagProgressTracker;
	onCancel?: () => void;
}

// ── Component ────────────────────────────────────────────────
export class WorkflowOverlay implements Component {
	private readonly workflowName: string;
	private readonly queryPreview: string;
	private readonly tracker: DagProgressTracker;
	private readonly onCancel?: () => void;
	private theme: Theme;
	private startedAt: number;
	private _expanded = false;

	constructor(opts: WorkflowOverlayOptions, theme: Theme) {
		this.workflowName = opts.workflowName;
		this.queryPreview = opts.queryPreview;
		this.tracker = opts.dagTracker;
		this.onCancel = opts.onCancel;
		this.theme = theme;
		this.startedAt = Date.now();
	}

	// ── Public API ────────────────────────────────────────────

	/** Reset start time when reused. */
	reset(): void {
		this.startedAt = Date.now();
	}

	get expanded(): boolean {
		return this._expanded;
	}

	set expanded(v: boolean) {
		this._expanded = v;
	}

	// ── Component interface ───────────────────────────────────

	render(width: number): string[] {
		const w = Math.max(width, 24);
		const th = this.theme;
		const elapsed = fmtElapsed(
			Math.floor((Date.now() - this.startedAt) / 1000),
		);
		const tracker = this.tracker;
		const progress = tracker.progressSummary(
			Math.floor((Date.now() - this.startedAt) / 1000),
		);

		const lines: string[] = [];
		const bl = "│";
		const border = (s: string) => th.fg("border", s);
		const innerWidth = w - 2; // subtract borders

		// ── Header ───────────────────────────────────────────
		const statusIcon = tracker.workflowDone
			? tracker.workflowError
				? th.fg("error", "✗")
				: th.fg("success", "✓")
			: th.fg("accent", "◆");
		const titleText = `${statusIcon} ${this.workflowName}`;
		const timeText = tracker.workflowDone ? elapsed : progress;

		lines.push(border("╭") + border("─".repeat(innerWidth)) + border("╮"));
		lines.push(
			border(bl) +
				padLine(`${titleText}  ${th.fg("dim", timeText)}`, innerWidth) +
				border(bl),
		);

		// ── Query preview (truncated) ────────────────────────
		if (this.queryPreview) {
			const preview = truncateToWidth(
				this.queryPreview.length > innerWidth - 4
					? `${this.queryPreview.slice(0, innerWidth - 5)}…`
					: this.queryPreview,
				innerWidth,
			);
			lines.push(
				border(bl) +
					padLine(th.fg("dim", ` ${preview}`), innerWidth) +
					border(bl),
			);
		}

		// ── Separator ────────────────────────────────────────
		lines.push(border(bl) + border("├" + "─".repeat(innerWidth - 1) + "┤"));

		// ── Node list ────────────────────────────────────────
		const nodes = tracker.nodes;
		const maxVisible = this._expanded ? 12 : 5;
		const visible = nodes.slice(0, maxVisible);

		for (const node of visible) {
			const icon = NODE_ICONS[node.state] ?? "○";
			const color = NODE_COLORS[node.state] ?? "dim";
			const name = truncateToWidth(node.id, innerWidth - 12);

			let suffix = "";
			if (node.state === "running" && node.startedAt) {
				const nodeElapsed = Math.floor((Date.now() - node.startedAt) / 1000);
				suffix = th.fg("dim", ` ${fmtElapsed(nodeElapsed)}`);
			} else if (node.state === "done" && node.duration) {
				suffix = th.fg("dim", ` ${node.duration}`);
			} else if (node.state === "error" && node.error) {
				const err = truncateToWidth(node.error, innerWidth - 14);
				suffix = th.fg("error", ` ${err}`);
			} else if (node.state === "skipped" && node.skipReason) {
				suffix = th.fg("dim", ` ${node.skipReason}`);
			} else if (node.state === "approval" && node.approvalMessage) {
				const msg = truncateToWidth(node.approvalMessage, innerWidth - 14);
				suffix = th.fg("warning", ` ${msg}`);
			}

			// Iteration badge
			let iterBadge = "";
			if (node.currentIteration != null && node.maxIterations != null) {
				iterBadge = th.fg(
					"accent",
					` ${node.currentIteration}/${node.maxIterations}`,
				);
			} else if (node.currentIteration != null) {
				iterBadge = th.fg("accent", ` iter ${node.currentIteration}`);
			}

			// Active tool
			let toolBadge = "";
			if (node.state === "running" && node.activeTool) {
				toolBadge = th.fg("dim", ` 🔧${node.activeTool}`);
			}

			const line = `${th.fg(color, icon)} ${name}${iterBadge}${toolBadge}${suffix}`;
			lines.push(border(bl) + padLine(` ${line}`, innerWidth) + border(bl));
		}

		if (nodes.length > maxVisible) {
			const remaining = nodes.length - maxVisible;
			lines.push(
				border(bl) +
					padLine(th.fg("dim", ` … +${remaining} more`), innerWidth) +
					border(bl),
			);
		}

		if (nodes.length === 0) {
			lines.push(
				border(bl) +
					padLine(th.fg("dim", " (no nodes yet)"), innerWidth) +
					border(bl),
			);
		}

		// ── Footer ───────────────────────────────────────────
		const footerHint = tracker.workflowDone
			? tracker.workflowError
				? th.fg("error", " failed ")
				: th.fg("success", " complete ")
			: th.fg("dim", " Esc=cancel · e=expand ");

		lines.push(border("╰") + padLine(footerHint, innerWidth) + border("╯"));

		return lines;
	}

	handleInput(data: string): boolean {
		// ESC = cancel
		if (data === "\x1b" || data === "\x03") {
			this.onCancel?.();
			return true;
		}
		// 'e' = toggle expand
		if (data === "e") {
			this._expanded = !this._expanded;
			return true;
		}
		return false;
	}
}

// ── Shared helpers ───────────────────────────────────────────

export function padLine(text: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(text));
	return text + " ".repeat(pad);
}

export function fmtElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}
