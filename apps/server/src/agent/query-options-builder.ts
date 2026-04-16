import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { SandboxConfig, AgentRuntimeConfig, SubAgentDefinition } from "../lib/config-loader.js";
import { taskLogger } from "../lib/logger.js";
import { buildChildEnv } from "../lib/child-env.js";

export function buildSandboxOptions(config: SandboxConfig | undefined): Record<string, unknown> {
  if (!config?.enabled) return {};

  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: config.auto_allow_bash ?? true,
      allowUnsandboxedCommands: config.allow_unsandboxed_commands ?? true,
      ...(config.network?.allowed_domains?.length ? {
        network: { allowedDomains: config.network.allowed_domains },
      } : {}),
      ...(config.filesystem ? {
        filesystem: {
          ...(config.filesystem.allow_write?.length ? { allowWrite: config.filesystem.allow_write } : {}),
          ...(config.filesystem.deny_write?.length ? { denyWrite: config.filesystem.deny_write } : {}),
          ...(config.filesystem.deny_read?.length ? { denyRead: config.filesystem.deny_read } : {}),
        },
      } : {}),
    },
  };
}

export function buildQueryOptions(params: {
  taskId: string;
  stageName: string;
  appendPrompt: string;
  stageConfig: {
    model?: string;
    thinking: { type: string };
    effort?: string;
    permissionMode: string;
    debug: boolean;
    maxTurns: number;
    maxBudgetUsd: number;
    mcpServices: string[];
  };
  sandboxConfig?: SandboxConfig;
  hooks?: Record<string, Array<{ hooks: Array<(input: HookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>> }>>;
  localMcp: Record<string, unknown>;
  claudePath: string;
  cwd?: string;
  resumeSessionId?: string;
  interactive?: boolean;
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  agents?: Record<string, SubAgentDefinition>;
  runtime?: AgentRuntimeConfig;
  abortSignal?: AbortSignal;
}): Record<string, unknown> {
  const {
    taskId, stageName, appendPrompt, stageConfig, sandboxConfig,
    hooks, localMcp, claudePath, cwd, resumeSessionId, interactive, canUseTool,
    outputFormat, agents, runtime,
  } = params;

  const hasMcp = Object.keys(localMcp).length > 0;
  const sandboxOptions = buildSandboxOptions(sandboxConfig);

  if (sandboxConfig?.enabled) {
    taskLogger(taskId, stageName).info({ sandboxOptions }, "Sandbox mode enabled — options passed to SDK");
  }

  const options: Record<string, unknown> = {
    systemPrompt: { type: "preset", preset: "claude_code", append: appendPrompt },
    pathToClaudeCodeExecutable: claudePath,
    settingSources: [],
    thinking: stageConfig.thinking,
    ...(stageConfig.effort ? { effort: stageConfig.effort } : {}),
    ...(hasMcp ? { mcpServers: localMcp } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(agents ? { agents } : {}),
    includePartialMessages: true,
    maxTurns: stageConfig.maxTurns,
    maxBudgetUsd: stageConfig.maxBudgetUsd,
    permissionMode: stageConfig.permissionMode,
    ...(stageConfig.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    disallowedTools: [
      "ToolSearch",
      // Block claude.ai remote MCPs from being used by pipeline agents
      "mcp__claude_ai_*",
      ...(runtime?.disallowed_tools ?? []),
    ],
    ...(stageConfig.debug ? { debug: true } : {}),
    ...(hooks && Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(stageConfig.model ? { model: stageConfig.model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    env: { ...buildChildEnv({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }), CLAUDECODE: "", CI: "true" },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...sandboxOptions,
  };

  if (interactive && canUseTool) {
    options.canUseTool = canUseTool;
  }

  return options;
}
