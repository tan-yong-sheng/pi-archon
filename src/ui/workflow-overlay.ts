/**
 * WorkflowOverlay — non-capturing overlay popup showing live DAG progress.
 *
 * Anchored top-right, compact: shows node states, elapsed time, and
 * an optional cancel hint. Designed to float over the terminal
 * while the user continues working.
 *
 * Supports scrolling via ↑/↓ keys with persistent scroll offset.
 *
 * This component is created inside a ctx.ui.custom() callback and
 * attached to the screen via tui.showOverlay(component, { nonCapturing: true }).
 * The TUI system calls render() each frame; we call tui.requestRender()
 * after updating tracker state.
 */
import type { Component, Theme } from "@mariozechner/pi-tui";
import {
	truncateToWidth,
	visibleWidth,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";
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

	// Scroll state — persists across renders so ↑/↓ don't reset
	private scrollOffset = 0;

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
		this.scrollOffset = 0;
	}

	get expanded(): boolean {
		return this._expanded;
	}

	set expanded(v: boolean) {
		this._expanded = v;
		// Reset scroll when toggling expand mode
		this.scrollOffset = 0;
	}

	// ── Component interface ───────────────────────────────────
	render(width: number, _height?: number): string[] {
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
				padLine(`${titleText} ${th.fg("dim", timeText)}`, innerWidth) +
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

		// ── Node list with scroll ────────────────────────────
		const nodes = tracker.nodes;
		const maxVisible = this._expanded ? 12 : 5;

		// Clamp scroll offset
		const maxScroll = Math.max(0, nodes.length - maxVisible);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		if (this.scrollOffset < 0) this.scrollOffset = 0;

		const visible = nodes.slice(
			this.scrollOffset,
			this.scrollOffset + maxVisible,
		);

		// Scroll indicator if scrolled
		if (this.scrollOffset > 0) {
			lines.push(
				border(bl) +
					padLine(
						th.fg("dim", ` ↑ ${this.scrollOffset} more above`),
						innerWidth,
					) +
					border(bl),
			);
		}

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

			// Node type badge (e.g., "bash", "prompt")
			let typeBadge = "";
			if (node.nodeType) {
				typeBadge = th.fg("muted", ` [${node.nodeType}]`);
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

			// Provider badge for running AI nodes
			let providerBadge = "";
			if (node.state === "running" && node.provider && !node.activeTool) {
				providerBadge = th.fg("dim", ` via ${node.provider}`);
			}

			const line = `${th.fg(color, icon)} ${name}${typeBadge}${iterBadge}${toolBadge}${providerBadge}${suffix}`;
			lines.push(border(bl) + padLine(` ${line}`, innerWidth) + border(bl));
		}

		if (nodes.length > this.scrollOffset + maxVisible) {
			const remaining = nodes.length - this.scrollOffset - maxVisible;
			lines.push(
				border(bl) +
					padLine(th.fg("dim", ` ↓ ${remaining} more below`), innerWidth) +
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
		const scrollHint = nodes.length > maxVisible ? " · ↑/↓ scroll" : "";
		const footerHint = tracker.workflowDone
			? tracker.workflowError
				? th.fg("error", " failed ")
				: th.fg("success", " complete ")
			: th.fg("dim", ` Esc=cancel · e=expand${scrollHint} `);
		lines.push(border("╰") + padLine(footerHint, innerWidth) + border("╯"));

		return lines;
	}

	handleInput(data: string): boolean {
		// ESC = cancel
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
			return true;
		}

		// 'e' = toggle expand
		if (data === "e") {
			this._expanded = !this._expanded;
			return true;
		}

		// ↑ = scroll up
		if (matchesKey(data, Key.up)) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				return true;
			}
			return false;
		}

		// ↓ = scroll down
		if (matchesKey(data, Key.down)) {
			this.scrollOffset++;
			// Will be clamped in render()
			return true;
		}

		// Page Up
		if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 5);
			return true;
		}

		// Page Down
		if (matchesKey(data, "pageDown")) {
			this.scrollOffset += 5;
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
