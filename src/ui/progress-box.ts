import { TuiBase } from "./base";
import type {
	ProgressBoxParams,
	ProgressStepInfo,
	StepState,
	StreamMessage,
	LineParserFn,
	DagNodeInfo,
	DagNodeState,
} from "../types";
import { formatElapsed } from "../helpers";
import { ARCHON_LOG_RE } from "../output-filter";
import { DagProgressTracker } from "../dag-tracker";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ProgressBox extends TuiBase {
	readonly mode: "steps" | "stream" | "dag";
	readonly steps: ProgressStepInfo[];

	/** DAG tracker — only used in dag mode */
	readonly dagTracker: DagProgressTracker;

	#messages: StreamMessage[] = [];
	#expanded = false;
	#error?: string;
	#currentStep = "";
	#totalEvents = 0;
	readonly #formatLine: LineParserFn;
	#spinner = 0;
	#ticker?: NodeJS.Timeout;
	#pendingEsc?: NodeJS.Timeout;
	readonly #startedAt = Date.now();

	constructor(params: ProgressBoxParams) {
		super(params);

		if (params.mode === "stream") {
			this.mode = "stream";
			this.steps = [];
			this.dagTracker = new DagProgressTracker();
			this.#formatLine =
				params.lineParser ?? ((line, isErr) => ({ text: line, isErr }));
		} else if (params.mode === "dag") {
			this.mode = "dag";
			this.steps = [];
			this.dagTracker = new DagProgressTracker();
			this.#formatLine = () => ({ text: "", isErr: false });
		} else {
			this.mode = "steps";
			this.steps = (params.steps ?? []).map((title) => ({
				title,
				state: "queued" as StepState,
			}));
			this.dagTracker = new DagProgressTracker();
			this.#formatLine = () => ({ text: "", isErr: false });
		}

		this.#ticker = setInterval(() => {
			const hasActive =
				this.mode === "steps"
					? this.steps.some((step) => step.state === "running")
					: this.mode === "dag"
						? this.dagTracker.runningNodeIds.length > 0 &&
							!this.dagTracker.workflowDone
						: true;
			if (!hasActive) return;
			this.#spinner = (this.#spinner + 1) % SPINNER_FRAMES.length;
			this.invalidate();
			this.tui.requestRender();
		}, 120);
	}

	stop(): void {
		if (this.#ticker) clearInterval(this.#ticker);
		if (this.#pendingEsc) clearTimeout(this.#pendingEsc);
	}

	setRunning(index: number): void {
		if (index >= this.steps.length) return;
		this.steps[index].state = "running";
		this.invalidate();
		this.tui.requestRender();
	}

	setDone(index: number, detail?: string, durationMs?: number): void {
		if (index >= this.steps.length) return;
		this.steps[index] = {
			...this.steps[index],
			state: "done",
			detail,
			durationMs,
		};
		this.invalidate();
		this.tui.requestRender();
	}

	setError(index: number, detail?: string, durationMs?: number): void {
		if (index >= this.steps.length) return;
		this.steps[index] = {
			...this.steps[index],
			state: "error",
			detail,
			durationMs,
		};
		this.invalidate();
		this.tui.requestRender();
	}

	get completedCount(): number {
		if (this.mode === "dag") return this.dagTracker.completedCount;
		return this.steps.filter((step) => step.state === "done").length;
	}

	get errorCount(): number {
		if (this.mode === "dag") return this.dagTracker.errorCount;
		return this.steps.filter((step) => step.state === "error").length;
	}

	get totalCount(): number {
		if (this.mode === "dag") return this.dagTracker.totalCount;
		return this.steps.length;
	}

	appendLine(line: string, isErr: boolean): void {
		const normalized = line.replace(/\r/g, "").trim();
		if (!normalized || ARCHON_LOG_RE.test(normalized)) return;

		// In dag mode, try to parse structured DAG events first
		if (this.mode === "dag") {
			const wasDagEvent = this.dagTracker.onLine(normalized, isErr);
			if (wasDagEvent) {
				this.#totalEvents += 1;
				this.#currentStep =
					this.dagTracker.runningNodeIds[0] ?? this.#currentStep;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
		}

		const event = this.#formatLine(normalized, isErr);
		if (!event?.text?.trim()) return;

		this.#totalEvents += 1;
		if (event.step) this.#currentStep = event.step;
		this.#messages.push({
			text: event.text,
			isErr: event.isErr,
			timestamp: Date.now(),
		});
		this.invalidate();
		this.tui.requestRender();
	}

	toggleExpanded(): void {
		this.#expanded = !this.#expanded;
		this.invalidate();
		this.tui.requestRender();
	}

	setStreamError(error: string): void {
		this.#error = error;
		this.invalidate();
		this.tui.requestRender();
	}

	/** In dag mode, signal that approval was resolved (approved/rejected) */
	clearApproval(): void {
		// The tracker keeps its node state; this just lets the UI know
		// to stop showing the approval prompt hint.
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.#pendingEsc) {
			clearTimeout(this.#pendingEsc);
			this.#pendingEsc = undefined;
		}
		if (data === "\u001b") {
			this.#pendingEsc = setTimeout(() => {
				this.#pendingEsc = undefined;
				this.onAbort();
			}, 40);
			return;
		}
		if (data === "\x1c") {
			this.onAbort();
			return;
		}
		if (this.mode === "steps") return;

		const expandKey = this.keyHint("app.tools.expand", "ctrl+o");
		if (this.matchesKey(data, "ctrl+o") || this.matchesKey(data, expandKey)) {
			this.toggleExpanded();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const elapsed = formatElapsed(
			Math.floor((Date.now() - this.#startedAt) / 1000),
		);

		let body: string[];
		switch (this.mode) {
			case "dag":
				body = [...this.renderDagHeader(elapsed), ...this.renderDagBody()];
				break;
			case "steps":
				body = [...this.renderStepsHeader(elapsed), ...this.renderStepsBody()];
				break;
			default:
				body = [
					...this.renderStreamHeader(elapsed),
					...this.renderStreamBody(),
				];
				break;
		}

		body.push("");

		// Footer key hints
		if (this.mode === "stream" || this.mode === "dag") {
			const approvalHint =
				this.mode === "dag" && this.dagTracker.approvalPendingNodeId
					? " · [A]pprove/[R]eject"
					: "";
			body.push(
				`${this.panelGutter()}${this.fireDim(`[Esc] cancel · ${this.keyHint("app.tools.expand", "expand")} toggle${approvalHint}`)}`,
			);
		} else {
			body.push(`${this.panelGutter()}${this.fireDim("[Esc] cancel")}`);
		}

		const rows = [
			this.renderPanelPillRow(width),
			...this.renderPanelRows(body, width),
		];
		this.cachedWidth = width;
		this.cachedLines = rows;
		return rows;
	}

	// ─── DAG mode rendering ──────────────────────────────────────

	private renderDagHeader(elapsed: string): string[] {
		const tracker = this.dagTracker;
		const progress = tracker.progressSummary(
			Math.floor((Date.now() - this.#startedAt) / 1000),
		);
		const icon = tracker.workflowDone
			? tracker.workflowError
				? this.fireWarning("❌")
				: this.fireSuccess("✅")
			: this.fireAccent(SPINNER_FRAMES[this.#spinner] ?? "•");

		const rows: string[] = [
			`${this.panelGutter()}${icon} ${this.theme.bold(this.fireAccentHot(this.title))} ${this.fireDim(progress)}`,
		];

		// Show current running node(s)
		const running = tracker.runningNodeIds;
		if (running.length > 0 && !tracker.workflowDone) {
			const runningLabel = running
				.map((id) => {
					const node = tracker.nodes.find((n) => n.id === id);
					const tool = node?.activeTool;
					const elapsed = node?.startedAt
						? ` ${this.fireDim(formatElapsed(Math.floor((Date.now() - node.startedAt) / 1000)))}`
						: "";
					const toolLabel = tool ? ` → ${this.fireAccent(tool)}` : "";
					return `${this.fireAccent(id)}${toolLabel}${elapsed}`;
				})
				.join(", ");
			rows.push(
				`${this.panelGutter()}${this.fireMuted("running:")} ${runningLabel}`,
			);
		}

		// Show approval pending
		const approvalId = tracker.approvalPendingNodeId;
		if (approvalId && !tracker.workflowDone) {
			const node = tracker.nodes.find((n) => n.id === approvalId);
			const msg = node?.approvalMessage
				? `: ${this.fireDim(node.approvalMessage.slice(0, 60))}`
				: "";
			rows.push(
				`${this.panelGutter()}${this.fireWarning("⏸ approval")} ${this.fireAccent(approvalId)}${msg}`,
			);
		}

		rows.push("");
		return rows;
	}

	private renderDagBody(): string[] {
		const tracker = this.dagTracker;
		const nodes = tracker.nodes;
		const rows: string[] = [];

		if (this.#error) {
			rows.push(
				`${this.panelGutter()}${this.fireWarning(`❌ ${this.#error}`)}`,
			);
		}

		if (nodes.length === 0) {
			rows.push(
				`${this.panelGutter()}${this.fireDim("(waiting for DAG nodes...)")}`,
			);
			return rows;
		}

		// Show all nodes — compact view (or expanded with details)
		const visible = this.#expanded ? nodes : nodes.slice(-this.maxLines);

		for (const node of visible) {
			const line = this.renderDagNode(node);
			rows.push(`${this.panelGutter()}${line}`);
		}

		const dropped = Math.max(0, nodes.length - visible.length);
		if (dropped > 0) {
			rows.push(
				`${this.panelGutter()}${this.fireDim(`... and ${dropped} more above`)}`,
			);
		}

		// In expanded mode, also show recent tool events under active nodes
		if (this.#expanded) {
			const recentTools = this.#messages
				.filter((m) => m.text.startsWith("  ↳"))
				.slice(-3);
			for (const tool of recentTools) {
				rows.push(
					`${this.panelGutter()}  ${tool.isErr ? this.fireWarning(tool.text) : this.fireDim(tool.text)}`,
				);
			}
		}

		return rows;
	}

	private renderDagNode(node: DagNodeInfo): string {
		let icon: string;
		let color: (text: string) => string;

		switch (node.state) {
			case "queued":
				icon = "○ ";
				color = (text) => this.fireMuted(text);
				break;
			case "running":
				icon = `${this.fireAccent(SPINNER_FRAMES[this.#spinner] ?? "•")} `;
				color = (text) => this.fireFg(text);
				break;
			case "done":
				icon = this.fireSuccess("✓ ");
				color = (text) => this.fireSuccess(text);
				break;
			case "error":
				icon = this.fireWarning("✗ ");
				color = (text) => this.fireWarning(text);
				break;
			case "skipped":
				icon = this.fireDim("⊘ ");
				color = (text) => this.fireDim(text);
				break;
			case "approval":
				icon = this.fireWarning("⏸ ");
				color = (text) => this.fireAccentHot(text);
				break;
		}

		let text = `${icon}${color(node.id)}`;

		// Duration
		if (node.duration) {
			text += this.fireDim(` ${node.duration}`);
		} else if (node.state === "running" && node.startedAt) {
			const elapsed = Math.floor((Date.now() - node.startedAt) / 1000);
			text += this.fireDim(` ${formatElapsed(elapsed)}`);
		}

		// Loop iteration badge
		if (node.currentIteration != null && node.maxIterations != null) {
			text += this.fireDim(` ${this.fireAccent(`${node.currentIteration}/${node.maxIterations}`)}`);
		} else if (node.currentIteration != null) {
			text += this.fireDim(` iter ${node.currentIteration}`);
		}

		// Active tool indicator
		if (node.activeTool && node.state === "running") {
			text += this.fireDim(` → ${this.fireAccent(node.activeTool)}`);
		}

		// Error detail
		if (node.error) {
			const truncated =
				node.error.length > 50 ? `${node.error.slice(0, 47)}...` : node.error;
			text += this.fireDim(` ${this.fireWarning(truncated)}`);
		}

		// Skip reason
		if (node.skipReason) {
			text += this.fireDim(` (${node.skipReason})`);
		}

		return text;
	}

	// ─── Steps mode rendering (unchanged) ────────────────────────

	private renderStepsHeader(elapsed: string): string[] {
		const progress = `${this.completedCount}/${this.totalCount}`;
		const errBadge =
			this.errorCount > 0 ? ` · ${this.errorCount} error(s)` : "";
		return [
			`${this.panelGutter()}${this.fireAccentHot("◆")} ${this.theme.bold(this.fireAccentHot(this.title))} ${this.fireDim(`${progress}${errBadge} · ${elapsed}`)}`,
			"",
		];
	}

	private renderStepsBody(): string[] {
		const visibleSteps = this.steps.slice(-this.maxLines);
		const rows: string[] = [];
		for (const step of visibleSteps) {
			let icon = "○ ";
			let color = (text: string) => this.fireMuted(text);
			switch (step.state) {
				case "running":
					icon = `${this.fireAccent(SPINNER_FRAMES[this.#spinner] ?? "•")} `;
					break;
				case "done":
					icon = this.fireSuccess("✓ ");
					color = (text: string) => this.fireSuccess(text);
					break;
				case "error":
					icon = this.fireWarning("✗ ");
					color = (text: string) => this.fireWarning(text);
					break;
			}
			let text = `${icon}${color(step.title)}`;
			if (step.detail) text += this.fireDim(` — ${step.detail}`);
			if (step.durationMs != null)
				text += this.fireDim(
					` (${formatElapsed(Math.floor(step.durationMs / 1000))})`,
				);
			rows.push(`${this.panelGutter()}${text}`);
		}
		const dropped = Math.max(0, this.steps.length - this.maxLines);
		if (dropped > 0)
			rows.push(
				`${this.panelGutter()}${this.fireDim(`... and ${dropped} more above`)}`,
			);
		return rows;
	}

	// ─── Stream mode rendering (unchanged) ───────────────────────

	private renderStreamHeader(elapsed: string): string[] {
		const spinner =
			this.#messages.length === 0 && !this.#error
				? this.fireAccent(SPINNER_FRAMES[this.#spinner] ?? "•")
				: this.getStateIcon();
		return [
			`${this.panelGutter()}${spinner} ${this.theme.bold(this.fireAccentHot(this.title))} ${this.fireDim(elapsed)}`,
			`${this.panelGutter()}${this.fireMuted(`events: ${this.#totalEvents} · ${this.#currentStep || "starting"}`)}`,
			"",
		];
	}

	private renderStreamBody(): string[] {
		const rows: string[] = [];
		if (this.#error)
			rows.push(
				`${this.panelGutter()}${this.fireWarning(`❌ ${this.#error}`)}`,
			);
		const visible = this.#expanded
			? this.#messages
			: this.#messages.slice(-this.maxLines);
		for (const message of visible.length > 0
			? visible
			: [{ text: "(waiting for output...)", isErr: false }]) {
			rows.push(
				`${this.panelGutter()}${message.isErr ? this.fireWarning(message.text) : this.fireFg(message.text)}`,
			);
		}
		return rows;
	}

	private getStateIcon(): string {
		if (this.#error) return this.fireWarning("❌");
		if (this.#messages.length > 0) return this.fireSuccess("✅");
		return this.fireAccent("⏳");
	}
}
