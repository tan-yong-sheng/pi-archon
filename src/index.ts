/**
 * pi-archon extension — unified /archons dashboard + archon_workflow tool.
 *
 * Entry point: registers the /archons command and the archon_workflow tool.
 * The /archon command tree has been removed; CLI-equivalent operations
 * (server, web, manage, update) should be run directly in the terminal.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { ArchonTheme } from "./types";

interface ArchonCustomMessage {
	content?: unknown;
	details?: unknown;
}

interface MessageRendererCapableExtensionAPI extends ExtensionAPI {
	registerMessageRenderer(
		customType: string,
		renderer: typeof archonMessageRenderer,
	): void;
}

interface CommandCapableExtensionAPI extends ExtensionAPI {
	registerCommand(
		name: string,
		config: {
			description: string;
			getArgumentCompletions: (
				prefix: string,
			) => { value: string; description?: string }[] | null;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		},
	): void;
}

import {
	handleArchonsCommand,
	buildArchonsCompletions,
} from "./archons-command";
import { registerArchonWorkflowTool } from "./archon-workflow-tool";
import { registerGetWorkflowInfoTool } from "./get-workflow-info-tool";
import { refreshProjectWorkflowNames } from "./workflow-discovery";
import { ArchonMessagePanel } from "./ui/message-panel";

const archonMessageRenderer = (
	message: ArchonCustomMessage,
	options: { expanded: boolean },
	_theme: ArchonTheme,
) => {
	return new ArchonMessagePanel(
		message.content,
		message.details,
		options.expanded,
	);
};

export default async function onEnable(api: ExtensionAPI): Promise<void> {
	try {
		const messageApi = api as MessageRendererCapableExtensionAPI;
		const commandApi = api as CommandCapableExtensionAPI;

		// Register message renderer for custom archon messages
		messageApi.registerMessageRenderer("archon", archonMessageRenderer);

		// /archons — unified workflow dashboard (launch, monitor, inspect, cancel)
		commandApi.registerCommand("archons", {
			description:
				"Archon workflow dashboard — launch, monitor, inspect, and cancel workflows",
			getArgumentCompletions: (prefix: string) => {
				const completions = buildArchonsCompletions(prefix);
				return completions.length > 0 ? completions : null;
			},
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				await handleArchonsCommand(api, args, ctx);
			},
		});

// Register the archon_workflow tool for AI agent use
		registerArchonWorkflowTool(api);

		// Register get_workflow_info tool — discover workflows with descriptions + full definitions
		registerGetWorkflowInfoTool(api);

		// Refresh workflow names on startup (best-effort)
		void refreshProjectWorkflowNames(process.cwd()).catch(() => undefined);
	} catch {
		/* best-effort */
	}
}

// ── Public exports ────────────────────────────────────────────

export { DagProgressTracker } from "./dag-tracker";
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
export { tryParseDagEvent, tryParseStderrDagEvent } from "./output-filter";
export { ArchonMessagePanel } from "./ui/message-panel";
export {
	runArchonCommand,
	runArchonCommandStreaming,
	runArchonCommandWithToolUpdates,
	formatArchonOutput,
	formatArchonToolResult,
} from "./archon-exec";
export {
	resolveArchonEndpointConfig,
	resolveArchonHome,
	getArchonServerUrl,
	getArchonWebUrl,
	resolveProjectArchonAssistant,
} from "./config";
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
export {
	readPidFile,
	readLogTail,
	isHttpReachable,
	isPidRunning,
} from "./runtime-util";
export {
	listProjectWorkflowNames,
	peekProjectWorkflowNames,
	readProjectWorkflowNamesFromDisk,
	refreshProjectWorkflowNames,
	findProjectWorkflow,
	clearProjectWorkflowCache,
} from "./workflow-discovery";
export {
	redactSecrets,
	safeCode,
	truncateOutputBlock,
	cleanOutput,
	LogEvent,
} from "./output-filter";
export {
	runWorkflowBackground,
	cancelRun,
	getActiveRuns,
	getActiveRun,
	type ActiveWorkflowRun,
} from "./workflow-background";
export {
	handleArchonsCommand,
	buildArchonsCompletions,
} from "./archons-command";
export { WorkflowOverlay, fmtElapsed, padLine } from "./ui/workflow-overlay";
export {
	showArchonOverlay,
	type ArchonOverlayOptions,
} from "./ui/archon-overlay";
export {
	findActiveWorkflowRunId,
	cancelArchonWorkflowRun,
	handleArchonStatusCommand,
	type ArchonWorkflowStatusRow,
	type ArchonWorkflowStatusJson,
} from "./workflow-ops";
export * as constants from "./constants";
