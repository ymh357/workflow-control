// Pre-flight check for OAuth-mediated MCP servers declared via the
// `mcp-remote` bridge. Runs before `run_pipeline` actually spins up
// stage agents, so authoring errors ("I forgot to authorise Linear
// before calling this pipeline") surface as a clear 400 instead of
// waiting ~8 seconds for the agent to spawn, watch the SDK fail to
// advertise any MCP tools, and then report MCP_STARTUP_FAILED.
//
// Scope is intentionally narrow:
//   - Only inspects stdio MCP declarations whose launch command is
//     recognisably `npx … mcp-remote <url>` (the canonical remote
//     bridge used by Linear / Notion / Atlassian / ...).
//   - Checks for a tokens.json file cached by mcp-remote under
//     ~/.mcp-auth/mcp-remote-<ver>/<md5(url)>_tokens.json. Presence is
//     treated as "the user has authorised this server at least once";
//     token freshness / scope correctness is NOT validated here —
//     that's the MCP_STARTUP_FAILED safety net's job (which runs once
//     the agent actually spawns and the SDK observes zero tools).
//
// Caveat: the ~/.mcp-auth/mcp-remote-<ver>/ path embeds the bridge
// version. Different CLIs pinned to different versions would create
// parallel dirs. We scan all mcp-remote-* dirs so a user pinned to an
// older version still passes the check.

import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerDecl } from "../ir/schema.js";

/**
 * True when the declaration is a stdio wrapper spawning `mcp-remote`
 * against a remote HTTP MCP. Recognises the canonical form
 * `{ command:"npx", args:["-y","mcp-remote","<url>", ...] }` that
 * both Linear and the PulseMCP catalog document. `-y` may be omitted
 * (newer npx defaults), so we walk `args` for the `mcp-remote` token.
 */
export function isMcpRemoteDecl(decl: McpServerDecl): string | null {
  const cmd = decl.command;
  if (cmd !== "npx" && cmd !== "npx.cmd") return null;
  const idx = decl.args.findIndex((a) => a === "mcp-remote" || /\/mcp-remote(\b|$)/.test(a));
  if (idx === -1) return null;
  const urlArg = decl.args[idx + 1];
  if (!urlArg) return null;
  if (!/^https?:\/\//.test(urlArg)) return null;
  return urlArg;
}

/**
 * Compute the mcp-remote server-URL hash. Mirrors mcp-remote's
 * `getServerUrlHash(url)` (md5 of the URL string, hex). Only the bare
 * URL variant is supported — the bridge's optional resource +
 * headers salt is not surfaced through IR today, so we scope the
 * pre-flight to that common case. If a user authorises via a custom
 * resource they can still succeed via the MCP_STARTUP fallback.
 */
export function mcpRemoteUrlHash(url: string): string {
  return createHash("md5").update(url).digest("hex");
}

/**
 * Walk every installed mcp-remote version under ~/.mcp-auth/ and
 * return true iff a <hash>_tokens.json exists for this URL. The
 * tokens file is only created after the user completes OAuth consent
 * in their browser (mcp-remote writes it on successful refresh).
 */
export function hasCachedMcpRemoteToken(url: string): boolean {
  const hash = mcpRemoteUrlHash(url);
  const root = join(homedir(), ".mcp-auth");
  if (!existsSync(root)) return false;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.startsWith("mcp-remote-")) continue;
    const tokenPath = join(root, entry, `${hash}_tokens.json`);
    if (existsSync(tokenPath)) return true;
  }
  return false;
}

export interface MissingMcpAuth {
  serverName: string;
  url: string;
  stage: string;
}

/**
 * Inspect every agent stage of an IR and report any `mcp-remote`-based
 * external MCP that has no cached token file yet. Callers should emit
 * a clear 400-style diagnostic pointing the user at the one-line
 * `npx -y mcp-remote <url>` bootstrap.
 */
export function findMissingMcpRemoteAuth(
  stages: Array<{
    name: string;
    type: string;
    config?: { mcpServers?: McpServerDecl[] | undefined } | unknown;
  }>,
): MissingMcpAuth[] {
  const missing: MissingMcpAuth[] = [];
  for (const stage of stages) {
    if (stage.type !== "agent") continue;
    const cfg = stage.config as { mcpServers?: McpServerDecl[] } | undefined;
    const decls = cfg?.mcpServers;
    if (!decls || decls.length === 0) continue;
    for (const decl of decls) {
      const url = isMcpRemoteDecl(decl);
      if (url === null) continue;
      if (!hasCachedMcpRemoteToken(url)) {
        missing.push({ serverName: decl.name, url, stage: stage.name });
      }
    }
  }
  return missing;
}
