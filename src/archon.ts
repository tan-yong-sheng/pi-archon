/**
 * Barrel module — single entry point for external consumers.
 * All symbols are re-exported from their canonical submodule home.
 *
 * The /archon command tree and route have been removed.
 * Use /archons for the dashboard and archon_workflow for the tool.
 */

// ── Types ────────────────────────────────────────────────────
export type {
	ArchonRunResult,
	WorkflowName,
	CodebaseBindingResult,
	ArchonEndpointConfig,
	DagEvent,
	DagNodeState,
	DagNodeInfo,
	ToolActivity,
	DagModeParams,
	ArtifactType,
	WorkflowArtifact,
	NodeSummaryRow,
	LoopIterationInfo,
	WorkflowRunRecord,
} from "./types";

// ── DAG progress ─────────────────────────────────────────────
export { ProgressBox } from "./ui/progress-box";
export { DagProgressTracker } from "./dag-tracker";

// ── Archon CLI + DB data access ─────────────────────────────────
export {
	getRunDetail,
	findLatestRunIdForWorkflow,
	listWorkflowsWithDetails,
	type ArchonApiRunDetail,
	type ArchonApiRunEvent,
} from "./archon-api";

// ── Artifact & history queries ───────────────────────────────
export {
	findLatestRunId,
	findActiveRunId,
	queryRunArtifacts,
	queryRunNodeSummaries,
	queryLoopIterations,
	queryRecentRuns,
	formatRunRecordLabel,
	renderArtifactsSection,
	artifactIcon,
	artifactLabel,
} from "./artifact-query";

// ── Output parsing ───────────────────────────────────────────
export {
	tryParseDagEvent,
	tryParseStderrDagEvent,
	redactSecrets,
	safeCode,
	truncateOutputBlock,
	cleanOutput,
	LogEvent,
} from "./output-filter";

// ── Archon message panel ─────────────────────────────────────
export { ArchonMessagePanel } from "./ui/message-panel";

// ── Archon exec ──────────────────────────────────────────────
export {
	runArchonCommand,
	runArchonCommandStreaming,
	runArchonCommandWithToolUpdates,
	formatArchonOutput,
	formatArchonToolResult,
} from "./archon-exec";

// ── Git utilities ────────────────────────────────────────────
export {
	gitExec,
	parseLines,
	collectWorktrees,
	pruneWorktrees,
	checkSubmodules,
	fetchSubmodules,
	rollupSubmodules,
	auditAllSubmoduleRefs,
	rollupStaleRefs,
	rollupLocalChanges,
	rollupPushSuperproject,
	readSubmodulePaths,
	isOwnedRepo,
} from "./git-util";

// ── Config ───────────────────────────────────────────────────
export {
	resolveArchonEndpointConfig,
	resolveArchonHome,
	getArchonServerUrl,
	getArchonWebUrl,
	resolveProjectArchonAssistant,
} from "./config";

// ── Helpers ──────────────────────────────────────────────────
export {
	createMessageEmitter,
	normalizeError,
	normalizeString,
	maybeString,
	shellQuote,
	sqlQuote,
	contentToText,
	formatElapsed,
	hasFlag,
	splitArgs,
	levelTag,
} from "./helpers";

// ── Runtime utilities ────────────────────────────────────────
export {
	readPidFile,
	readLogTail,
	isHttpReachable,
	isPidRunning,
} from "./runtime-util";

// ── Workflow discovery ───────────────────────────────────────
export {
	listProjectWorkflowNames,
	peekProjectWorkflowNames,
	readProjectWorkflowNamesFromDisk,
	refreshProjectWorkflowNames,
	findProjectWorkflow,
	clearProjectWorkflowCache,
} from "./workflow-discovery";

// ── Workflow ops (extracted from old manage-runtime) ─────────
export {
	findActiveWorkflowRunId,
	cancelArchonWorkflowRun,
	handleArchonStatusCommand,
	type ArchonWorkflowStatusRow,
	type ArchonWorkflowStatusJson,
} from "./workflow-ops";

// ── Workflow background runner ───────────────────────────────
export {
	runWorkflowBackground,
	cancelRun,
	getActiveRuns,
	getActiveRun,
	type ActiveWorkflowRun,
} from "./workflow-background";

// ── /archons dashboard ───────────────────────────────────────
export {
	handleArchonsCommand,
	buildArchonsCompletions,
} from "./archons-command";

// ── UI components ────────────────────────────────────────────
export { WorkflowOverlay, fmtElapsed, padLine } from "./ui/workflow-overlay";
export {
	showArchonOverlay,
	type ArchonOverlayOptions,
} from "./ui/archon-overlay";

// ── Constants ────────────────────────────────────────────────
export * as constants from "./constants";
