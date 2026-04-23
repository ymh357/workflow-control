// mcp-servers-expander.ts
//
// Pure expander for ${VAR} placeholders in stage.config.mcpServers declarations.
// Feeds into real-executor-sdk-options.ts → SDK options.mcpServers.
//
// Precedence: taskEnv (from task_env_values table) > processEnv.
// Missing variables throw McpEnvExpansionError with enough context for a
// MCP_ENV_MISSING diagnostic.

import type { McpServerDecl } from "../ir/schema.js";

export class McpEnvExpansionError extends Error {
  constructor(
    public readonly server: string,
    public readonly fieldKey: string,
    public readonly variable: string,
  ) {
    super(
      `mcp server '${server}' field '${fieldKey}' references unset env variable '${variable}'`,
    );
    this.name = "McpEnvExpansionError";
  }
}

export interface ExpandedMcpServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandValue(
  raw: string,
  serverName: string,
  fieldKey: string,
  taskEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): string {
  return raw.replace(VAR_RE, (_m, v: string) => {
    const fromTask = taskEnv[v];
    if (fromTask !== undefined) return fromTask;
    const fromProc = processEnv[v];
    if (fromProc !== undefined) return fromProc;
    throw new McpEnvExpansionError(serverName, fieldKey, v);
  });
}

export function expandMcpServers(
  decls: McpServerDecl[],
  taskEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, ExpandedMcpServer> {
  const out: Record<string, ExpandedMcpServer> = {};
  for (const d of decls) {
    const server: ExpandedMcpServer = {
      type: "stdio",
      command: expandValue(d.command, d.name, "command", taskEnv, processEnv),
      args: d.args.map((a, i) => expandValue(a, d.name, `args[${i}]`, taskEnv, processEnv)),
    };
    if (d.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.env)) {
        env[k] = expandValue(v, d.name, `env.${k}`, taskEnv, processEnv);
      }
      server.env = env;
    }
    out[d.name] = server;
  }
  return out;
}
