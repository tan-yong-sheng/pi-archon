/**
 * Archon CLI-wrapped data access — queries workflow and run metadata
 * using the Archon CLI and SQLite DB instead of the REST API.
 *
 * No dependency on `archon serve` — everything works via CLI subprocess.
 * The DB path is used directly for fast lookups (read-only SQL queries).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ARCHON_DB_PATH } from "./constants";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────

export interface WorkflowInfo {
	name: string;
	description: string;
	source: "project" | "bundled" | "global";
	provider?: string;
	model?: string;
	nodeCount?: number;
}

export interface NodeOutputInfo {
	nodeId: string;
	nodeType?: string;
	provider?: string;
	output?: string;
	durationMs?: number;
	costUsd?: number;
	stopReason?: string;
	numTurns?: number;
	error?: string;
}

// ── Internal helpers ─────────────────────────────────────────

function resolveArchonBin(): { cmd: string; args: string[] } {
	const archonRoot = process.env.ARCHON_ROOT || "/opt/archon";
	try {
		const fs = require("node:fs");
		if (fs.existsSync(`${archonRoot}/package.json`)) {
			return { cmd: "bun", args: ["run", "cli"] };
		}
	} catch {
		/* ignore */
	}
	return { cmd: "archon", args: [] };
}

/**
 * Strip JSON pino logger lines from CLI output before parsing.
 * The Archon CLI mixes pino JSON log lines with actual JSON output.
 */
function stripPinoLines(text: string): string {
	return text
		.split(/\n/)
		.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return false;
			if (trimmed.startsWith("{")) {
				try {
					const parsed = JSON.parse(trimmed);
					return !(parsed && typeof parsed.level === "number" && parsed.msg);
				} catch {
					return true;
				}
			}
			return true;
		})
		.join("\n");
}

async function runArchonCli(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { cmd, args: baseArgs } = resolveArchonBin();
	const fullArgs = [...baseArgs, ...args];

	try {
		const { stdout, stderr } = await execFileAsync(cmd, fullArgs, {
			timeout: 30000,
			encoding: "utf-8",
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (error: any) {
		if (error.stdout !== undefined) {
			return {
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
				exitCode: error.code ?? 1,
			};
		}
		throw error;
	}
}

// ── Workflow discovery ────────────────────────────────────────

interface CliWorkflowEntry {
	name: string;
	description: string;
	provider?: string;
	model?: string;
}

/**
 * List all available workflows with name + description using `archon workflow list --json`.
 */
export async function listWorkflowsWithDetails(
	projectCwd?: string,
): Promise<WorkflowInfo[] | undefined> {
	try {
		const args = ["workflow", "list", "--json", "--no-worktree"];
		if (projectCwd) {
			args.push("--cwd", projectCwd);
		}
		const result = await runArchonCli(args);

		if (result.exitCode !== 0) return undefined;

		const clean = stripPinoLines(result.stdout);
		const parsed = JSON.parse(clean) as { workflows: CliWorkflowEntry[] };
		if (!parsed.workflows || !Array.isArray(parsed.workflows)) return undefined;

		// Detect source by checking if the workflow file exists on disk
		// Project workflows live in .archon/workflows/; bundled/global are from Archon's install.
		// We can't perfectly distinguish bundled from global without the server,
		// but we can detect project workflows by file presence.
		const projectDir = projectCwd
			? `${projectCwd}/.archon/workflows`
			: `${process.cwd()}/.archon/workflows`;

		return parsed.workflows.map((entry: CliWorkflowEntry) => {
			const fs = require("node:fs");
			const projectFile = `${projectDir}/${entry.name}.yaml`;
			const source: "project" | "bundled" | "global" = fs.existsSync(
				projectFile,
			)
				? "project"
				: "bundled";
			return {
				name: entry.name,
				description: entry.description,
				source,
				provider: entry.provider,
				model: entry.model,
			};
		});
	} catch {
		return undefined;
	}
}

// ── Run detail ────────────────────────────────────────────────

export interface ArchonApiRunDetail {
	run: {
		id: string;
		conversation_id: string;
		workflow_name: string;
		status: string;
		working_path: string | null;
		started_at: string;
		completed_at: string | null;
		metadata: Record<string, unknown>;
		conversation_platform_id: string | null;
		worker_platform_id?: string | null;
		parent_platform_id?: string | null;
	};
	events: ArchonApiRunEvent[];
}

export interface ArchonApiRunEvent {
	id: string;
	workflow_run_id: string;
	event_type: string;
	step_index: number | null;
	step_name: string | null;
	data: Record<string, unknown>;
	created_at: string;
}

/**
 * Get full run detail by querying the SQLite DB directly.
 * Returns undefined if the DB is unavailable or the run doesn't exist.
 */
export async function getRunDetail(
	runId: string,
): Promise<ArchonApiRunDetail | undefined> {
	try {
		// Query the run record
		const runCmd = `sqlite3 "${ARCHON_DB_PATH}" "SELECT json_object('id', id, 'conversation_id', conversation_id, 'workflow_name', workflow_name, 'status', status, 'working_path', working_path, 'started_at', started_at, 'completed_at', completed_at, 'metadata', CASE WHEN metadata IS NOT NULL THEN json(metadata) ELSE '{}' END, 'conversation_platform_id', conversation_platform_id, 'worker_platform_id', worker_platform_id, 'parent_platform_id', parent_platform_id) FROM remote_agent_workflow_runs WHERE id = '${runId.replace(/'/g, "''")}' LIMIT 1;" -json`;
		const { execSync } = await import("child_process");
		const runResult = execSync(runCmd, {
			timeout: 3000,
			encoding: "utf-8",
		}).trim();
		if (!runResult) return undefined;

		const runRows = JSON.parse(runResult) as Array<{
			id: string;
			conversation_id: string;
			workflow_name: string;
			status: string;
			working_path: string | null;
			started_at: string;
			completed_at: string | null;
			metadata: string;
			conversation_platform_id: string | null;
			worker_platform_id: string | null;
			parent_platform_id: string | null;
		}>;
		if (!runRows || runRows.length === 0) return undefined;

		const row = runRows[0];

		// Parse metadata JSON
		let metadata: Record<string, unknown> = {};
		try {
			metadata = JSON.parse(row.metadata ?? "{}");
		} catch {
			/* empty */
		}

		// Query events
		const eventsCmd = `sqlite3 "${ARCHON_DB_PATH}" "SELECT json_object('id', id, 'workflow_run_id', workflow_run_id, 'event_type', event_type, 'step_index', step_index, 'step_name', step_name, 'data', CASE WHEN data IS NOT NULL THEN json(data) ELSE '{}' END, 'created_at', created_at) FROM remote_agent_workflow_events WHERE workflow_run_id = '${runId.replace(/'/g, "''")}' ORDER BY created_at ASC;" -json 2>/dev/null`;

		let events: ArchonApiRunEvent[] = [];
		try {
			const eventsResult = execSync(eventsCmd, {
				timeout: 3000,
				encoding: "utf-8",
			}).trim();
			if (eventsResult) {
				const eventRows = JSON.parse(eventsResult) as Array<{
					id: string;
					workflow_run_id: string;
					event_type: string;
					step_index: number | null;
					step_name: string | null;
					data: string;
					created_at: string;
				}>;
				if (Array.isArray(eventRows)) {
					events = eventRows.map((e) => {
						let eventData: Record<string, unknown> = {};
						try {
							eventData = JSON.parse(e.data ?? "{}");
						} catch {
							/* empty */
						}
						return {
							id: e.id,
							workflow_run_id: e.workflow_run_id,
							event_type: e.event_type,
							step_index: e.step_index,
							step_name: e.step_name,
							data: eventData,
							created_at: e.created_at,
						};
					});
				}
			}
		} catch {
			/* events are optional */
		}

		return {
			run: {
				id: row.id,
				conversation_id: row.conversation_id,
				workflow_name: row.workflow_name,
				status: row.status,
				working_path: row.working_path,
				started_at: row.started_at,
				completed_at: row.completed_at,
				metadata,
				conversation_platform_id: row.conversation_platform_id,
				worker_platform_id: row.worker_platform_id,
				parent_platform_id: row.parent_platform_id,
			},
			events,
		};
	} catch {
		return undefined;
	}
}

// ── Run ID lookup ─────────────────────────────────────────────

/**
 * Find the most recent run ID for a workflow name by querying the SQLite DB.
 */
export async function findLatestRunIdForWorkflow(
	workflowName: string,
	workingPath?: string,
): Promise<string | undefined> {
	try {
		const dbPath = ARCHON_DB_PATH;
		const whereClause = workingPath
			? `workflow_name = '${workflowName.replace(/'/g, "''")}' AND working_path = '${workingPath.replace(/'/g, "''")}'`
			: `workflow_name = '${workflowName.replace(/'/g, "''")}'`;
		const cmd = `sqlite3 "${dbPath}" "SELECT id FROM remote_agent_workflow_runs WHERE ${whereClause} ORDER BY started_at DESC LIMIT 1;" -json`;
		const { execSync } = await import("child_process");
		const result = execSync(cmd, { timeout: 3000, encoding: "utf-8" });
		const rows = JSON.parse(result.trim()) as Array<{ id: string }>;
		if (rows.length > 0) return rows[0].id;
	} catch {
		// DB unavailable
	}
	return undefined;
}
