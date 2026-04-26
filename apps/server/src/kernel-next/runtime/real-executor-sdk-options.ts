// Pure builder for Claude Agent SDK base Options. Extracting this keeps
// real-executor.ts focused on orchestration / lifecycle and lets the options
// shape be unit-tested independently.

import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { SubAgentDef } from "../ir/schema.js";
import type { ExpandedMcpServer } from "./mcp-servers-expander.js";

export interface BuildSdkBaseOptionsArgs {
  systemPromptAppend: string;
  kernelMcp: NonNullable<SdkOptions["mcpServers"]>[string];
  model: string | undefined;
  maxTurns: number;
  maxBudgetUsd: number | undefined;
  claudePath: string | undefined;
  childEnv: NodeJS.ProcessEnv;
  subAgents: SubAgentDef[] | undefined;
  workspaceDir: string | undefined;
  /**
   * P3.5 — per-stage external MCP servers already expanded from
   * stage.config.mcpServers (${VAR} → concrete values) by
   * mcp-servers-expander.ts. Merged into mcpServers alongside the
   * built-in __kernel_next__ entry. Absent/empty → kernel-only mode.
   */
  externalMcpServers?: Record<string, ExpandedMcpServer>;
  /**
   * F22 (2026-04-26) — per-attempt AbortController. When aborted, the SDK
   * subprocess stops immediately so it cannot write port_values after the
   * attempt is marked terminal (error / secret_pending / interrupted).
   * doAttempt creates one per invocation and aborts it at every termination
   * path before calling finishAttempt.
   */
  abortController?: AbortController;
}

export function buildSdkBaseOptions(args: BuildSdkBaseOptionsArgs): SdkOptions {
  return {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: args.systemPromptAppend,
    },
    mcpServers: {
      __kernel_next__: args.kernelMcp,
      ...(args.externalMcpServers ?? {}),
    },
    model: args.model,
    maxTurns: args.maxTurns,
    maxBudgetUsd: args.maxBudgetUsd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    disallowedTools: ["ToolSearch", "mcp__claude_ai_*"],
    pathToClaudeCodeExecutable: args.claudePath,
    env: args.childEnv,
    ...(args.subAgents && args.subAgents.length > 0
      ? { agents: buildSdkAgents(args.subAgents) }
      : {}),
    ...(args.workspaceDir !== undefined ? { cwd: args.workspaceDir } : {}),
    ...(args.abortController !== undefined
      ? { abortController: args.abortController }
      : {}),
  };
}

/**
 * Maps IR SubAgentDef[] to the Claude SDK options.agents record shape.
 * Conditionally spreads optional fields so absent IR values yield absent
 * SDK keys (SDK treats tools: undefined as "inherit from parent").
 */
function buildSdkAgents(
  defs: SubAgentDef[],
): NonNullable<SdkOptions["agents"]> {
  const out: Record<string, NonNullable<SdkOptions["agents"]>[string]> = {};
  for (const d of defs) {
    out[d.name] = {
      description: d.description,
      prompt: d.prompt,
      ...(d.tools ? { tools: d.tools } : {}),
      ...(d.model ? { model: d.model } : {}),
      ...(d.maxTurns !== undefined ? { maxTurns: d.maxTurns } : {}),
    };
  }
  return out;
}
