import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { showArchonOverlay } from "../ui/archon-overlay";
import { generateFullHelp, generateScopedHelp, getScopedMetaByHandlerKey } from "../command-tree";
import { handlerRegistry, isHandlerKey } from "../handlers/registry";
import type { ArchonHandler } from "../handlers/base";
import type { ArchonHandlerKey } from "../handlers/registry";
import type { CommandNode } from "./defs";
import { isGroup } from "./defs";

const HELP_TOKENS = new Set(["help", "-h", "--help"]);

export abstract class ArchonCommand {
  static readonly meta = {} as CommandNode;
  static readonly handlerKey: string = "";

  protected get handlerKey(): ArchonHandlerKey {
    const key = (this.constructor as typeof ArchonCommand).handlerKey;
    if (!isHandlerKey(key)) throw new Error(`Invalid Archon handler key: ${key}`);
    return key;
  }

  protected get handler(): ArchonHandler {
    const handler = handlerRegistry.get(this.handlerKey);
    if (!handler) throw new Error(`Missing Archon handler for key: ${this.handlerKey}`);
    return handler;
  }

  async execute(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
    await this.handler.run(pi, ctx, args);
  }

  async executeTool(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext) {
    return this.handler.runTool(pi, ctx, args);
  }

  async showHelpIfRequested(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<boolean> {
    if (!args.some((arg) => HELP_TOKENS.has(arg.toLowerCase()))) return false;
    const meta = (this.constructor as typeof ArchonCommand).meta;
    const scoped = getScopedMetaByHandlerKey(this.handlerKey);
    await showArchonOverlay(pi, ctx, isGroup(meta) ? generateFullHelp() : generateScopedHelp(scoped ?? { ...meta, path: this.handlerKey.replace(/:/g, " ") }), { title: "Archon Help" });
    return true;
  }
}

export abstract class HelpableArchonCommand extends ArchonCommand {
  async execute(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
    if (await this.showHelpIfRequested(pi, ctx, args)) return;
    await super.execute(pi, args, ctx);
  }
}

export abstract class HelpFilteringArchonCommand extends ArchonCommand {
  async execute(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
    await super.execute(pi, args.filter((arg) => !HELP_TOKENS.has(arg.toLowerCase())), ctx);
  }
}
