/**
 * Query workflow artifacts from the Archon SQLite database.
 *
 * Since the Archon CLI does not render artifact events to stderr,
 * we query the DB directly after a workflow completes to discover
 * what artifacts (PRs, commits, files, branches) the run produced.
 *
 * Falls back gracefully if sqlite3 CLI or the DB file is unavailable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { ARCHON_DB_PATH } from "./constants";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────

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

export interface WorkflowRunSummary {
	id: string;
	workflowName: string;
	status: string;
	startedAt: string;
	artifacts: WorkflowArtifact[];
}

// ─── Artifact icon mapping ────────────────────────────────────────

const ARTIFACT_ICONS: Record<ArtifactType, string> = {
	pr: "🔀",
	commit: "🔖",
	file_created: "📄",
	file_modified: "✏️",
	branch: "🌿",
};

const ARTIFACT_LABELS: Record<ArtifactType, string> = {
	pr: "PR",
	commit: "Commit",
	file_created: "Created",
	file_modified: "Modified",
	branch: "Branch",
};

export function artifactIcon(type: ArtifactType): string {
	return ARTIFACT_ICONS[type] ?? "📎";
}

export function artifactLabel(type: ArtifactType): string {
	return ARTIFACT_LABELS[type] ?? type;
}

// ─── DB query ─────────────────────────────────────────────────────

/**
 * Find the most recent run ID for a workflow name in a given working path.
 * Returns undefined if the DB or sqlite3 is unavailable.
 */
export async function findLatestRunId(
	workflowName: string,
	workingPath: string,
): Promise<string | undefined> {
	if (!fs.existsSync(ARCHON_DB_PATH)) return undefined;

	const sql = `
		SELECT id
		FROM remote_agent_workflow_runs
		WHERE workflow_name = ? AND working_path = ?
		ORDER BY started_at DESC
		LIMIT 1
	`;

	try {
		const { stdout } = await execFileAsync("sqlite3", [
			ARCHON_DB_PATH,
			"-json",
			"-cmd",
			`.mode json`,
			sql,
			workflowName,
			workingPath,
		]);
		const rows = JSON.parse(stdout.trim() || "[]") as Array<{ id: string }>;
		return rows[0]?.id;
	} catch {
		return undefined;
	}
}

/**
 * Query artifacts for a specific workflow run from the events DB.
 * Returns an empty array if the DB or sqlite3 is unavailable.
 */
export async function queryRunArtifacts(
	runId: string,
): Promise<WorkflowArtifact[]> {
	if (!fs.existsSync(ARCHON_DB_PATH)) return [];

	const sql = `
		SELECT data
		FROM remote_agent_workflow_events
		WHERE workflow_run_id = ? AND event_type = 'workflow_artifact'
		ORDER BY created_at ASC
	`;

	try {
		const { stdout } = await execFileAsync("sqlite3", [
			ARCHON_DB_PATH,
			"-json",
			"-cmd",
			`.mode json`,
			sql,
			runId,
		]);
		const rows = JSON.parse(stdout.trim() || "[]") as Array<{
			data: string;
		}>;
		const artifacts: WorkflowArtifact[] = [];
		for (const row of rows) {
			try {
				const data = JSON.parse(row.data) as {
					artifactType?: string;
					label?: string;
					url?: string;
					path?: string;
				};
				if (
					data.artifactType &&
					data.label &&
					isValidArtifactType(data.artifactType)
				) {
					artifacts.push({
						type: data.artifactType as ArtifactType,
						label: data.label,
						url: data.url,
						path: data.path,
					});
				}
			} catch (parseErr) {
				// Skip malformed event data — artifacts are best-effort
			}
		}
		return artifacts;
	} catch {
		return [];
	}
}

/**
 * Query node summaries for a specific workflow run.
 * Returns per-node state/duration/error information.
 */
export async function queryRunNodeSummaries(runId: string): Promise<
	Array<{
		nodeId: string;
		state: string;
		durationMs?: number;
		error?: string;
		outputPreview?: string;
	}>
> {
	if (!fs.existsSync(ARCHON_DB_PATH)) return [];

	const sql = `
		SELECT event_type, step_name, data, created_at
		FROM remote_agent_workflow_events
		WHERE workflow_run_id = ?
			AND event_type IN ('node_started', 'node_completed', 'node_failed', 'node_skipped')
		ORDER BY created_at ASC
	`;

	try {
		const { stdout } = await execFileAsync("sqlite3", [
			ARCHON_DB_PATH,
			"-json",
			"-cmd",
			`.mode json`,
			sql,
			runId,
		]);
		const rows = JSON.parse(stdout.trim() || "[]") as Array<{
			event_type: string;
			step_name: string | null;
			data: string;
			created_at: string;
		}>;
		const startTimes = new Map<string, number>();
		const summaries = new Map<
			string,
			{
				nodeId: string;
				state: string;
				durationMs?: number;
				error?: string;
				outputPreview?: string;
			}
		>();
		for (const row of rows) {
			const nodeId = row.step_name ?? "";
			if (!nodeId) continue;
			const ts = new Date(row.created_at).getTime();
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(row.data) as Record<string, unknown>;
			} catch (parseErr) {
				// Malformed event data — skip
			}

			switch (row.event_type) {
				case "node_started":
					startTimes.set(nodeId, ts);
					if (!summaries.has(nodeId))
						summaries.set(nodeId, { nodeId, state: "running" });
					break;
				case "node_completed": {
					const started = startTimes.get(nodeId);
					const rawOutput = data.node_output as string | undefined;
					summaries.set(nodeId, {
						nodeId,
						state: "completed",
						durationMs: started != null ? ts - started : undefined,
						outputPreview:
							rawOutput != null
								? rawOutput.slice(0, 200) +
									(rawOutput.length > 200 ? "..." : "")
								: undefined,
					});
					break;
				}
				case "node_failed": {
					const started = startTimes.get(nodeId);
					summaries.set(nodeId, {
						nodeId,
						state: "failed",
						durationMs: started != null ? ts - started : undefined,
						error:
							typeof data.error === "string" ? data.error : "Unknown error",
					});
					break;
				}
				case "node_skipped":
					summaries.set(nodeId, { nodeId, state: "skipped" });
					break;
			}
		}
		return [...summaries.values()];
	} catch {
		return [];
	}
}

/**
 * Render artifacts as a markdown section suitable for inclusion
 * in the workflow result message.
 */
export function renderArtifactsSection(artifacts: WorkflowArtifact[]): string {
	if (artifacts.length === 0) return "";

	const lines: string[] = ["", "### Artifacts", ""];
	for (const artifact of artifacts) {
		const icon = artifactIcon(artifact.type);
		const typeLabel = artifactLabel(artifact.type);
		if (artifact.url) {
			lines.push(
				`- ${icon} **${typeLabel}:** [${artifact.label}](${artifact.url})`,
			);
		} else if (artifact.path) {
			lines.push(`- ${icon} **${typeLabel}:** \`${artifact.path}\``);
		} else {
			lines.push(`- ${icon} **${typeLabel}:** ${artifact.label}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

// ─── Loop iteration query ────────────────────────────────────────

/**
 * Query loop iteration events for a running workflow from the events DB.
 * Used during the run to supplement CLI stderr (which doesn't emit
 * loop iteration events) so the ProgressBox can show iteration counts.
 *
 * Returns an array of DagEvent-like loop iteration objects.
 */
export async function queryLoopIterations(runId: string): Promise<
	Array<
		| {
				type: "loop_iteration_started";
				nodeId: string;
				iteration: number;
				maxIterations: number;
		  }
		| {
				type: "loop_iteration_completed";
				nodeId: string;
				iteration: number;
				duration?: number;
		  }
		| {
				type: "loop_iteration_failed";
				nodeId: string;
				iteration: number;
				error: string;
		  }
	>
> {
	if (!fs.existsSync(ARCHON_DB_PATH)) return [];

	const sql = `
		SELECT event_type, step_name, data
		FROM remote_agent_workflow_events
		WHERE workflow_run_id = ?
			AND event_type IN (
				'loop_iteration_started',
				'loop_iteration_completed',
				'loop_iteration_failed'
			)
		ORDER BY created_at ASC
	`;

	try {
		const { stdout } = await execFileAsync("sqlite3", [
			ARCHON_DB_PATH,
			"-json",
			"-cmd",
			`.mode json`,
			sql,
			runId,
		]);
		const rows = JSON.parse(stdout.trim() || "[]") as Array<{
			event_type: string;
			step_name: string | null;
			data: string;
		}>;

		const events: Array<
			| {
					type: "loop_iteration_started";
					nodeId: string;
					iteration: number;
					maxIterations: number;
			  }
			| {
					type: "loop_iteration_completed";
					nodeId: string;
					iteration: number;
					duration?: number;
			  }
			| {
					type: "loop_iteration_failed";
					nodeId: string;
					iteration: number;
					error: string;
			  }
		> = [];

		for (const row of rows) {
			const nodeId = row.step_name ?? "";
			if (!nodeId) continue;
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(row.data) as Record<string, unknown>;
			} catch (parseErr) {
				// Malformed event data — skip
			}

			const iteration = typeof data.iteration === "number" ? data.iteration : 0;

			switch (row.event_type) {
				case "loop_iteration_started": {
					const maxIterations =
						typeof data.maxIterations === "number" ? data.maxIterations : 0;
					events.push({
						type: "loop_iteration_started",
						nodeId,
						iteration,
						maxIterations,
					});
					break;
				}
				case "loop_iteration_completed": {
					const duration =
						typeof data.duration === "number" ? data.duration : undefined;
					events.push({
						type: "loop_iteration_completed",
						nodeId,
						iteration,
						duration,
					});
					break;
				}
				case "loop_iteration_failed": {
					const error =
						typeof data.error === "string" ? data.error : "Unknown error";
					events.push({
						type: "loop_iteration_failed",
						nodeId,
						iteration,
						error,
					});
					break;
				}
			}
		}

		return events;
	} catch (queryErr) {
		return [];
	}
}

/**
 * Find the most recent running workflow run ID (across all workflows)
 * in the DB. Used for periodic iteration polling during a run.
 */
export async function findActiveRunId(
	workingPath: string,
): Promise<string | undefined> {
	if (!fs.existsSync(ARCHON_DB_PATH)) return undefined;

	const sql = `
		SELECT id
		FROM remote_agent_workflow_runs
		WHERE working_path = ? AND status IN ('running', 'pending')
		ORDER BY started_at DESC
		LIMIT 1
	`;

	try {
		const { stdout } = await execFileAsync("sqlite3", [
			ARCHON_DB_PATH,
			"-json",
			"-cmd",
			`.mode json`,
			sql,
			workingPath,
		]);
		const rows = JSON.parse(stdout.trim() || "[]") as Array<{ id: string }>;
		return rows[0]?.id;
	} catch (queryErr) {
		return undefined;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────

const VALID_ARTIFACT_TYPES = new Set<string>([
	"pr",
	"commit",
	"file_created",
	"file_modified",
	"branch",
]);

function isValidArtifactType(value: string): value is ArtifactType {
	return VALID_ARTIFACT_TYPES.has(value);
}
