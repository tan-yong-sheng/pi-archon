import type { TUI } from "@mariozechner/pi-tui";

export interface ArchonTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold(text: string): string;
}

export type BufferLine = { text: string; isErr: boolean };

export interface LiveEventLine {
	text: string;
	isErr: boolean;
	step?: string;
}

export interface LogLevelConfig {
	debug: number;
	info: number;
	warn: number;
	error: number;
}

export interface JsonPayload extends Record<string, unknown> {
	level?: number;
	module?: string;
	msg?: string;
	nodeId?: string;
	err?: unknown;
}

export interface ArchonRunResult {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ArchonToolUpdate {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export interface ExtensionExecResult {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

export interface ExtensionExecOptions {
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExtensionMessagePayload {
	customType?: string;
	content?: unknown;
	details?: Record<string, unknown>;
	display?: boolean;
}

export interface ArchonMessageDetails extends Record<string, unknown> {
	pill?: string;
	action?: string;
	runs?: number;
	runId?: string;
	error?: string;
	artifacts?: WorkflowArtifact[];
	nodeSummaries?: NodeSummaryRow[];
}

export interface RuntimeHealthStatus {
	isHealthy: boolean;
	logTail: string;
}

export interface WebHealthStatus extends RuntimeHealthStatus {
	serverHealthy: boolean;
}

export interface ExtensionCommandRegistration {
	description: string;
	getArgumentCompletions: (
		prefix: string,
	) => { value: string; description?: string }[] | null;
	handler: (
		args: string,
		ctx: import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
	) => Promise<void>;
}

export interface ExtensionRouteRegistration {
	method: string;
	path: string;
	schema?: unknown;
	handler: (req: { body?: unknown; cwd?: string }) => Promise<unknown>;
}

export interface CommandArchonOutcome {
	cancelled?: boolean;
	run?: ArchonRunResult;
	error?: string;
	durationMs?: number;
}

export interface CodebaseBindingResult {
	id: string;
	name: string;
	assistant: string;
	created: boolean;
	updated: boolean;
}

export interface ArchonRuntimeCleanupResult {
	pidFile: string;
	matchedPids: string[];
	remainingPids: string[];
}

export interface ArchonRuntimeStartResult {
	pid: string;
	logFile: string;
	pidFile: string;
	alreadyRunning: boolean;
}

export interface ArchonWebCleanupResult extends ArchonRuntimeCleanupResult {}

export interface ArchonWebStartResult extends ArchonRuntimeStartResult {
	uiPort: string;
}

export interface ArchonWebStartOptions {
	assistant: string;
	open: boolean;
	defaultPort: string;
}

export interface ArchonWebStatusSnapshot {
	port: string;
	isHealthy: boolean;
	serverHealthy: boolean;
	logTail: string;
}

export interface RuntimeStatusSection {
	label: string;
	value: string;
}

export interface ArchonEndpointConfig {
	host: string;
	serverPort: string;
	webPort: string;
}

export interface CommandWorkflowOutcome {
	cancelled?: boolean;
	run?: ArchonRunResult;
	error?: string;
	durationMs?: number;
}

export type TuiRendererFn = (...args: unknown[]) => unknown;

export interface ExtensionUiShim {
	custom<T>(renderer: TuiRendererFn): Promise<T | undefined>;
	notify(message: string, level?: string): void;
	setStatus?(id: string, text: string): void;
}

export interface TuiBaseParams {
	tui: TUI;
	theme: ArchonTheme;
	title: string;
	onAbort: () => void;
	maxLines?: number;
	pill?: string;
}

export interface RgbPainter {
	rgb(
		mode: 38 | 48,
		color: readonly [number, number, number],
		text: string,
	): string;
	fg(text: string): string;
	text(text: string): string;
	bg(text: string): string;
	panel(text: string): string;
	border(text: string): string;
	accent(text: string): string;
	accentHot(text: string): string;
	success(text: string): string;
	warning(text: string): string;
	muted(text: string): string;
	dim(text: string): string;
}

export type MessagePanelRowKind = "pill" | "panel" | "plain";

export interface MessagePanelLine {
	text: string;
	kind: MessagePanelRowKind;
	wrap?: boolean;
}

export type StepState =
	| "queued"
	| "running"
	| "done"
	| "error"
	| "skipped"
	| "approval";

// ─── Workflow artifact types ────────────────────────────────────

export type ArtifactType =
	| "pr"
	| "commit"
	| "file_created"
	| "file_modified"
	| "branch";

export interface WorkflowArtifact {
	type: ArtifactType;
	label: string;
	url?: string;
	path?: string;
}

export interface NodeSummaryRow {
	nodeId: string;
	state: string;
	durationMs?: number;
	error?: string;
	outputPreview?: string;
}

// ─── DAG progress tracking types ────────────────────────────────────

/** Discriminated DAG event emitted by Archon CLI stderr or --json-events */
export type DagEvent =
	| { type: "workflow_started"; workflowName: string }
	| { type: "node_started"; nodeId: string }
	| { type: "node_completed"; nodeId: string; duration: string }
	| { type: "node_failed"; nodeId: string; error: string }
	| { type: "node_skipped"; nodeId: string; reason: string }
	| { type: "approval_pending"; nodeId: string; message: string }
	| { type: "tool_started"; stepName: string; toolName: string }
	| {
			type: "tool_completed";
			stepName: string;
			toolName: string;
			durationMs: number;
	  }
	| { type: "workflow_completed"; duration?: number }
	| { type: "workflow_failed"; error?: string };

export type DagNodeState =
	| "queued"
	| "running"
	| "done"
	| "error"
	| "skipped"
	| "approval";

export interface DagNodeInfo {
	id: string;
	state: DagNodeState;
	duration?: string;
	error?: string;
	skipReason?: string;
	approvalMessage?: string;
	activeTool?: string;
	startedAt?: number;
}

export interface ToolActivity {
	toolName: string;
	stepName: string;
	startedAt: number;
	durationMs?: number;
}

export interface ProgressStepInfo {
	title: string;
	state: StepState;
	detail?: string;
	durationMs?: number;
}

export interface StepResult {
	title: string;
	ok: boolean;
	lines: string[];
	durationMs: number;
}

export interface StreamMessage extends LiveEventLine {
	timestamp?: number;
}

export type LineParserFn = (line: string, isErr: boolean) => LiveEventLine;

export interface PipelineStep {
	title: string;
	run: () => Promise<string[]>;
}

export interface PipelineConfig<TData = unknown> {
	title: string;
	steps: string[] | (() => PipelineStep[]);
	maxLines?: number;
	executor?: () => Promise<{ results: StepResult[]; data?: TData }>;
	renderReport?: (
		results: StepResult[],
		totalDurationMs: number,
		data?: TData,
	) => string;
	emitLine?: (text: string) => void;
	successLabel?: string;
	errorLabel?: string;
}

export interface PhaseRunnerConfig<TData = unknown> {
	title: string;
	executor: (
		onLine?: (line: string, isErr?: boolean) => void,
	) => Promise<{ lines: string[]; data?: TData }>;
	lineParser?: LineParserFn;
	renderReport?: (
		lines: StreamMessage[],
		totalDurationMs: number,
		data?: TData,
	) => string;
	emitLine?: (text: string) => void;
	successLabel?: string;
	errorLabel?: string;
	maxLines?: number;
}

export interface StepModeParams extends TuiBaseParams {
	mode?: "steps";
	steps?: string[];
	lineParser?: never;
}

export interface StreamModeParams extends TuiBaseParams {
	mode: "stream";
	steps?: string[];
	lineParser?: LineParserFn;
}

export interface DagModeParams extends TuiBaseParams {
	mode: "dag";
	steps?: never;
	lineParser?: never;
}

export type ProgressBoxParams =
	| StepModeParams
	| StreamModeParams
	| DagModeParams;

export type WorkflowName = string;

export interface GitExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
}

export interface SubmoduleInfo {
	path: string;
	defaultBranch: string;
	localHash: string;
	remoteHash: string;
	ahead: number;
	behind: number;
}

export interface CleanupStep {
	title: string;
	run: () => Promise<string[]>;
}

export interface CleanupWorktreeEntry {
	path: string;
	branch: string;
	commit: string;
	removed: boolean;
}

export interface CleanupSubmoduleEntry {
	name: string;
	path: string;
	commit: string;
	upToDate: boolean;
	dirty: boolean;
}

export interface StaleRemoteRef {
	repoPath: string;
	repoName: string;
	branch: string;
	reason: "alias" | "codex" | "behind-only";
}

export interface FeatureBranchCandidate {
	repoPath: string;
	repoName: string;
	branch: string;
	uniqueCommits: number;
	lastMessage: string;
	date: string;
}

export interface SubmoduleAuditResult {
	staleRefsFound: StaleRemoteRef[];
	featureCandidates: FeatureBranchCandidate[];
	deletedLocally: { repo: string; refs: string[] }[];
	deletedRemotely: { repo: string; refs: string[] }[];
	protectedSkipped: { repo: string; refs: string[] }[];
	fetchPruned: string[];
}

export interface CleanupResult {
	webDevStopped: boolean;
	worktreesRemoved: CleanupWorktreeEntry[];
	branchesDeleted: string[];
	submodulesChecked: CleanupSubmoduleEntry[];
	archonReset: boolean;
	archonBranch: string;
	workflowRunsCleared: number;
	localChangesCommitted: number;
	superprojectPushed: boolean;
	submodulesUpdated: number;
	remoteBranchesDeleted: number;
	stashesCleared: number;
	submoduleAudit?: SubmoduleAuditResult;
	error?: string;
}
