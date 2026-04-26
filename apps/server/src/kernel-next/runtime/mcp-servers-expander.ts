// mcp-servers-expander.ts
//
// Pure expander for ${VAR} placeholders in stage.config.mcpServers declarations.
// Feeds into real-executor-sdk-options.ts → SDK options.mcpServers.
//
// Precedence: taskEnv (from task_env_values table) > processEnv.
//
// 2026-04-26 F17 (secret-gate): expander now returns a discriminated-union
// result. On missing variable(s), it ENUMERATES ALL of them rather than
// throwing on the first encounter. This is the data the secret-gate
// detector uses to write a single secret_gate_queue row covering every
// envKey the operator must supply. The legacy McpEnvExpansionError class
// is kept exported for any downstream consumer that still imports the
// type, but is no longer thrown by expandMcpServers.

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

export interface MissingKeyDetail {
  server: string;
  fieldKey: string;
  key: string;
}

export type ExpandResult =
  | { ok: true; servers: Record<string, ExpandedMcpServer> }
  | { ok: false; missingKeys: string[]; details: MissingKeyDetail[] };

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandValueCollecting(
  raw: string,
  serverName: string,
  fieldKey: string,
  taskEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
  missing: MissingKeyDetail[],
): string {
  return raw.replace(VAR_RE, (_m, v: string) => {
    const fromTask = taskEnv[v];
    if (fromTask !== undefined) return fromTask;
    const fromProc = processEnv[v];
    if (fromProc !== undefined) return fromProc;
    missing.push({ server: serverName, fieldKey, key: v });
    return "";
  });
}

export function expandMcpServers(
  decls: McpServerDecl[],
  taskEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env,
): ExpandResult {
  const missing: MissingKeyDetail[] = [];
  const out: Record<string, ExpandedMcpServer> = {};
  for (const d of decls) {
    const server: ExpandedMcpServer = {
      type: "stdio",
      command: expandValueCollecting(d.command, d.name, "command", taskEnv, processEnv, missing),
      args: d.args.map((a, i) => expandValueCollecting(a, d.name, `args[${i}]`, taskEnv, processEnv, missing)),
    };
    if (d.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.env)) {
        env[k] = expandValueCollecting(v, d.name, `env.${k}`, taskEnv, processEnv, missing);
      }
      server.env = env;
    }
    out[d.name] = server;
  }
  if (missing.length > 0) {
    const dedup = Array.from(new Set(missing.map((m) => m.key))).sort();
    return { ok: false, missingKeys: dedup, details: missing };
  }
  return { ok: true, servers: out };
}
