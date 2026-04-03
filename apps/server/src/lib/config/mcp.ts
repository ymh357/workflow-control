import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";

import type { McpRegistryEntry } from "./types.js";
import { CONFIG_DIR, interpolateEnvVar } from "./settings.js";
import { logger } from "../logger.js";

// --- MCP registry loader ---

export function loadMcpRegistry(): Record<string, McpRegistryEntry> | null {
  const filePath = join(CONFIG_DIR, "mcps", "registry.yaml");
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYAML(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, McpRegistryEntry>;
  } catch (err) {
    logger.warn({ err, filePath }, "Failed to parse MCP registry YAML");
    return null;
  }
}

interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function hasMissing(value: string): boolean {
  return value.includes("\0MISSING\0");
}

export function buildMcpFromRegistry(
  serviceName: string,
  entry: McpRegistryEntry,
): McpStdioConfig | null {
  if (!entry || !entry.command) {
    logger.warn({ service: serviceName }, "MCP service skipped: missing command");
    return null;
  }

  const env: Record<string, string> = {};

  if (entry.env) {
    for (const [key, value] of Object.entries(entry.env)) {
      if (value == null) {
        logger.warn({ service: serviceName, envKey: key }, "MCP env value is null, skipping key");
        continue;
      }
      if (typeof value === "string") {
        const interpolated = interpolateEnvVar(value);
        if (hasMissing(interpolated)) {
          logger.warn({ service: serviceName, envKey: key }, "MCP service skipped: missing env var");
          return null;
        }
        env[key] = interpolated;
      } else if (typeof value === "object" && "json" in value && value.json && typeof value.json === "object") {
        const obj: Record<string, string> = {};
        for (const [k, v] of Object.entries(value.json)) {
          if (typeof v !== "string") {
            logger.warn({ service: serviceName, envKey: `${key}.json.${k}` }, "MCP env json value is not a string, skipping key");
            continue;
          }
          const interpolated = interpolateEnvVar(v);
          if (hasMissing(interpolated)) {
            logger.warn({ service: serviceName, envKey: `${key}.json.${k}` }, "MCP service skipped: missing env var");
            return null;
          }
          obj[k] = interpolated;
        }
        env[key] = JSON.stringify(obj);
      } else {
        logger.warn({ service: serviceName, envKey: key }, "MCP env value has unexpected type, skipping key");
      }
    }
  }

  return {
    command: entry.command,
    ...(entry.args ? { args: entry.args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
