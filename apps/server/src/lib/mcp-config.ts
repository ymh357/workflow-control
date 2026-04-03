// Build MCP server configs to pass to query() options.
// Uses config/mcps/registry.yaml as the single source of truth.
// Tokens are read from process.env at call time.

import { loadMcpRegistry, buildMcpFromRegistry } from "./config-loader.js";
import { logger } from "./logger.js";

interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpServiceName = string;

export function buildMcpServers(
  services: McpServiceName[],
  engine?: "claude" | "gemini" | "codex",
): Record<string, McpStdioConfig> {
  const registry = loadMcpRegistry();
  const result: Record<string, McpStdioConfig> = {};

  for (const svc of services) {
    let config: McpStdioConfig | null = null;

    if (registry?.[svc]) {
      const entry = registry[svc];
      // Use engine-specific override if available
      if (engine === "gemini" && entry.gemini) {
        config = buildMcpFromRegistry(svc, entry.gemini);
      }
      if (!config) {
        config = buildMcpFromRegistry(svc, entry);
      }
    }

    if (config) {
      result[svc] = config;
    } else {
      logger.warn({ service: svc }, "MCP not found in registry or missing env vars, skipping");
    }
  }

  return result;
}

export type { McpServiceName };
