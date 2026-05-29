import type {
	CommandGroupMeta,
	PositionalArg,
	SubCommandMeta,
} from "./commands/defs";
import type { ArchonCommand } from "./commands/base";
import { archonGroups, commandHandlers } from "./commands";
import { isHandlerKey } from "./handlers/registry";
import { readProjectWorkflowNamesFromDisk } from "./workflow-discovery";
import { isGroup } from "./commands/defs";

export const archonTree: CommandGroupMeta = {
	name: "archon",
	description: "Archon workspace launcher",
	category: "",
	children: archonGroups,
};

export interface CompletionItem {
	value: string;
	label: string;
}

export type ScopedCommandMeta = SubCommandMeta & { path: string };
export type ScopedGroupMeta = CommandGroupMeta & { path: string };

function getScopedNodes(
	nodes: Array<SubCommandMeta | CommandGroupMeta>,
	prefix = "",
): Array<ScopedCommandMeta | ScopedGroupMeta> {
	const scoped: Array<ScopedCommandMeta | ScopedGroupMeta> = [];
	for (const node of nodes) {
		const path = `${prefix}${node.name}`.trim();
		if (isGroup(node)) {
			const group = { ...node, path };
			scoped.push(group, ...getScopedNodes(node.children, `${path} `));
			continue;
		}
		scoped.push({ ...node, path });
	}
	return scoped;
}

const scopedNodes = getScopedNodes(archonTree.children);
const scopedCommands = scopedNodes.filter(
	(node): node is ScopedCommandMeta => !isGroup(node),
);
const scopedGroups = scopedNodes.filter((node): node is ScopedGroupMeta =>
	isGroup(node),
);
const scopedCommandByHandlerKey = new Map(
	scopedCommands.map((node) => [node.path.replace(/ /g, ":"), node]),
);
const directScopedCommandsByGroupPath = new Map(
	scopedGroups.map((group) => {
		const prefix = `${group.path} `;
		const children = scopedCommands.filter(
			(node) =>
				node.path.startsWith(prefix) &&
				!node.path.slice(prefix.length).includes(" "),
		);
		return [group.path, children] as const;
	}),
);
const resolverIndex = new Map<
	string,
	Map<string, ScopedCommandMeta | ScopedGroupMeta>
>();
for (const group of scopedGroups) {
	resolverIndex.set(group.path, new Map());
}
resolverIndex.set("", new Map());
for (const node of scopedNodes) {
	const parts = node.path.split(" ");
	const parentPath = parts.slice(0, -1).join(" ");
	const siblings =
		resolverIndex.get(parentPath) ??
		new Map<string, ScopedCommandMeta | ScopedGroupMeta>();
	siblings.set(node.name.toLowerCase(), node);
	resolverIndex.set(parentPath, siblings);
}

export function buildCompletions(): CompletionItem[] {
	const items: CompletionItem[] = [];
	for (const node of scopedNodes) {
		if (isGroup(node)) {
			items.push({ value: node.path, label: node.description || node.path });
			continue;
		}
		items.push({
			value: formatInvocationPath(node.path, node.args),
			label: node.description || node.path,
		});
	}
	for (const workflow of readProjectWorkflowNamesFromDisk(process.cwd())) {
		items.push({
			value: `workflow run ${workflow}`,
			label: `Run workflow ${workflow}`,
		});
		items.push({
			value: `workflow history ${workflow}`,
			label: `History for ${workflow}`,
		});
	}
	items.push(
		{ value: "-h", label: "Show per-command help" },
		{ value: "--help", label: "Show per-command help (long form)" },
		{ value: "help", label: "Show full help" },
	);
	return items;
}

/**
 * Context-aware completions: given the current partial argument text,
 * return suggestions whose `value` is the **full replacement** for the
 * argument string. Pi's applyCompletion replaces the entire prefix
 * (argumentText) with the selected item's value, so values must include
 * the already-typed path tokens.
 *
 * E.g. ""              -> "workflow", "manage", "server", "web"
 *      "workflow"      -> "workflow run", "workflow history",
 *                         "workflow run <name>", "workflow history <name>"
 *      "workflow run"  -> "workflow run archon-hello", "workflow run archon-ping-pong"
 */
export function buildContextCompletions(
	partialInput: string,
): CompletionItem[] {
	const tokens = partialInput.trim().split(/\s+/).filter(Boolean);

	// No tokens -> show top-level groups and commands
	if (tokens.length === 0) {
		const items: CompletionItem[] = [];

		// Show top-level groups
		for (const group of scopedGroups) {
			if (!group.path.includes(" ")) {
				items.push({
					value: group.path,
					label: group.description || group.path,
				});
			}
		}

		// Show top-level commands (direct children of root)
		for (const cmd of scopedCommands) {
			if (!cmd.path.includes(" ")) {
				items.push({
					value: formatInvocationPath(cmd.path, cmd.args),
					label: cmd.description || cmd.path,
				});
			}
		}

		items.push(
			{ value: "-h", label: "Show per-command help" },
			{ value: "--help", label: "Show per-command help (long form)" },
			{ value: "help", label: "Show full help" },
		);
		return items;
	}

	// Try to resolve the tokens to find where we are in the tree
	const result = resolveTokens([...tokens]);

	// If resolved to a group -> show its children
	// VALUES must include the group path prefix so pi replaces the
	// entire argument text with the full path, not just the child name.
	if (result.meta && isGroup(result.meta)) {
		const groupPath = result.meta.path;
		const items: CompletionItem[] = [];
		const children = resolverIndex.get(groupPath);
		if (children) {
			for (const [name, child] of children) {
				if (isGroup(child)) {
					items.push({
						value: child.path, // e.g. "workflow run"
						label: child.description || child.path,
					});
				} else {
					items.push({
						value: formatInvocationPath(
							child.path, // e.g. "workflow run"
							(child as ScopedCommandMeta).args,
						),
						label: child.description || child.path,
					});
				}
			}
		}

		// Special: if we're in the "workflow" group, also suggest
		// workflow names with the full group path prefix
		if (groupPath === "workflow") {
			for (const workflow of readProjectWorkflowNamesFromDisk(
				process.cwd(),
			)) {
				items.push({
					value: `workflow run ${workflow}`,
					label: `Run ${workflow}`,
				});
				items.push({
					value: `workflow history ${workflow}`,
					label: `History for ${workflow}`,
				});
			}
		}

		items.push({ value: `${groupPath} -h`, label: "Show help" });
		return items;
	}

	// If resolved to a command -> show positional arg completions if applicable
	if (result.handler) {
		const handlerPath = result.path; // e.g. "workflow:run"
		const commandPath = handlerPath.replace(/:/g, " "); // e.g. "workflow run"
		if (
			handlerPath === "workflow:run" ||
			handlerPath === "workflow:history"
		) {
			const items: CompletionItem[] = [];
			for (const workflow of readProjectWorkflowNamesFromDisk(
				process.cwd(),
			)) {
				// Full replacement value: "workflow run <workflow-name>"
				items.push({
					value: `${commandPath} ${workflow}`,
					label: workflow,
				});
			}
			return items;
		}
		// No further completions for this command
		return [];
	}

	// Tokens didn't resolve -> fall back to full completion list filtered by prefix
	const allCompletions = buildCompletions();
	const lastToken = tokens[tokens.length - 1].toLowerCase();
	return allCompletions.filter(
		(c) =>
			c.value.toLowerCase().startsWith(lastToken) ||
			c.value.toLowerCase().includes(lastToken),
	);
}



export function getAllLeaves(): ScopedCommandMeta[] {
	return [...scopedCommands];
}

export function getHandler(path: string): ArchonCommand | undefined {
	const lower = path.toLowerCase();
	if (!isHandlerKey(lower)) return undefined;
	return commandHandlers.get(lower);
}

export interface DispatchResult {
	handler?: ArchonCommand;
	path: string;
	rest: string[];
	meta?: ScopedCommandMeta | ScopedGroupMeta;
}

export function resolveTokens(tokens: string[]): DispatchResult {
	const pathParts: string[] = [];
	let lastGroup: ScopedGroupMeta | undefined;
	while (tokens.length) {
		const token = tokens.shift()!;
		const lower = token.toLowerCase();
		const parentPath = pathParts.join(" ");
		const match = resolverIndex.get(parentPath)?.get(lower);
		if (!match)
			return {
				path: pathParts.join(":"),
				rest: [token, ...tokens],
				meta: lastGroup,
			};
		pathParts.push(match.name);
		if (isGroup(match)) {
			lastGroup = match;
			continue;
		}
		return {
			handler: getHandler(pathParts.join(":")),
			path: pathParts.join(":"),
			meta: match,
			rest: [...tokens],
		};
	}
	return { path: pathParts.join(":"), rest: [], meta: lastGroup };
}

export function resolveCommandPath(
	command: string,
	args: string[],
): DispatchResult {
	return resolveTokens(command.split(":").filter(Boolean).concat(args));
}

const HELP_TOKENS = new Set(["help", "-h", "--help"]);

export function isHelpTrigger(args: string[]): boolean {
	return args.some((arg) => HELP_TOKENS.has(arg.toLowerCase()));
}

export function formatInvocationPath(
	path: string,
	args?: PositionalArg[],
): string {
	return `${path}${args?.length ? ` ${args.map((arg) => `<${arg.name}>`).join(" ")}` : ""}`;
}

export function formatInvocation(path: string, args?: PositionalArg[]): string {
	return `/archon ${formatInvocationPath(path, args)}`;
}

function getScopedGroups(): ScopedGroupMeta[] {
	return scopedGroups;
}

function getDirectScopedCommands(group: ScopedGroupMeta): ScopedCommandMeta[] {
	return directScopedCommandsByGroupPath.get(group.path) ?? [];
}

export function generateFullHelp(): string {
	const lines: string[] = ["## Archon", ""];
	for (const group of getScopedGroups()) {
		if (group.path.includes(" ")) continue;
		lines.push(
			`### ${group.category ?? group.name}`,
			"",
			`${group.description}`,
			"",
		);
		for (const child of getDirectScopedCommands(group)) {
			lines.push(
				`- \`${formatInvocation(child.path, child.args)}\` — ${child.description}`,
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}

export function getScopedMetaByHandlerKey(
	handlerKey: string,
): ScopedCommandMeta | undefined {
	return scopedCommandByHandlerKey.get(handlerKey);
}

export function generateHelpForPath(tokens: string[]): string {
	if (!tokens.length || isHelpTrigger(tokens)) return generateFullHelp();
	const result = resolveTokens([...tokens]);
	if (result.meta)
		return isGroup(result.meta)
			? generateGroupHelp(result.meta)
			: generateScopedHelp(result.meta);
	return generateFullHelp();
}

export function generateScopedHelp(node: ScopedCommandMeta): string {
	const lines: string[] = [`## /archon ${node.path}`, "", node.description];
	if (node.args?.length) {
		lines.push("", "### Arguments");
		for (const arg of node.args)
			lines.push(
				`- \`${arg.name}\`${arg.required ? " *(required)*" : ""}: ${arg.description ?? ""}`,
			);
	}
	if (node.flags?.length) {
		lines.push("", "### Flags");
		for (const flag of node.flags)
			lines.push(
				`- ${flag.aliases?.map((alias) => `${alias}, `).join("") ?? ""}\`${flag.name}\`: ${flag.description ?? ""}`,
			);
	}
	if (node.examples?.length) {
		lines.push("", "### Examples");
		for (const example of node.examples) lines.push("```bash", example, "```");
	}
	lines.push("");
	return lines.join("\n");
}

export function generateGroupHelp(group: ScopedGroupMeta): string {
	const lines: string[] = [
		`## /archon ${group.path}`,
		"",
		group.description,
		"",
	];
	const children = getDirectScopedCommands(group);
	if (children.length) {
		lines.push("### Sub-commands", "");
		for (const child of children) {
			lines.push(
				`- \`${formatInvocation(child.path, child.args)}\` — ${child.description}`,
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}
