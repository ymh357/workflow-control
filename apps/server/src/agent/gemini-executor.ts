import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { taskLogger } from "../lib/logger.js";

export interface GeminiMessage {
  type: "assistant" | "result" | "init" | "error";
  session_id?: string;
  message?: {
    content: Array<{
      type: "text" | "tool_use";
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  stats?: Record<string, unknown>;
  status?: string;
  result?: string;
  structured_output?: any;
  error_message?: string;
  subtype?: string;
  _synthetic?: boolean;
}

export interface GeminiOptions {
  geminiPath: string;
  model?: string;
  yolo?: boolean;
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  cwd?: string;
  resume?: string;
  env?: Record<string, string>;
  outputFormat?: "text" | "json" | "stream-json";
  mcpServers?: Record<string, any>;
}

export interface GeminiQuery extends AsyncIterable<GeminiMessage> {
  interrupt(): Promise<void>;
  close(): void;
  effectiveCwd?: string;
}

// Track active child processes for cleanup on server exit
const activeChildren = new Set<ChildProcess>();
const activeTempDirs = new Set<string>();

// Clean up stale gemini temp directories on startup (older than 24h)
try {
  const tmpBase = tmpdir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(tmpBase)) {
    if (!entry.startsWith("gemini-")) continue;
    const fullPath = join(tmpBase, entry);
    try {
      if (statSync(fullPath).mtimeMs < cutoff) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    } catch { /* skip */ }
  }
} catch { /* non-critical startup cleanup */ }

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.pid && child.exitCode === null) {
    try { process.kill(-child.pid, signal); } catch { /* already dead */ }
  }
}

function cleanupChildren() {
  for (const child of activeChildren) {
    killProcessGroup(child);
  }
  activeChildren.clear();
  for (const dir of activeTempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  activeTempDirs.clear();
}

process.on("exit", cleanupChildren);
process.on("SIGTERM", () => { cleanupChildren(); process.exit(0); });
process.on("SIGINT", () => { cleanupChildren(); process.exit(0); });

export function queryGemini(input: { prompt: string; options: GeminiOptions }): GeminiQuery {
  const { prompt, options } = input;

  // Inject MCP servers into a project-level .gemini/settings.json
  // IMPORTANT: Never write to global ~/.gemini/settings.json — it would pollute
  // the user's global config and accumulated MCP servers block Gemini CLI startup.
  // When no cwd is available, create a temp directory with isolated settings.
  const mcpNames: string[] = [];
  let tempCwd: string | null = null;
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    const log = taskLogger("gemini-executor");
    let targetCwd = options.cwd;
    if (!targetCwd) {
      // Create a temp directory so gemini reads project-level settings, not global
      tempCwd = join(tmpdir(), `gemini-${Date.now()}`);
      mkdirSync(tempCwd, { recursive: true });
      activeTempDirs.add(tempCwd);
      targetCwd = tempCwd;
    }
    const geminiDir = join(targetCwd, ".gemini");
    const settingsPath = join(geminiDir, "settings.json");

    try {
      if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });

      // Only write the MCP servers needed for this stage — don't merge with existing
      const settings: Record<string, any> = { mcpServers: options.mcpServers };

      // Preserve auth settings from existing project config if present
      if (existsSync(settingsPath)) {
        try {
          const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
          if (existing.security) settings.security = existing.security;
        } catch { /* ignore */ }
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      mcpNames.push(...Object.keys(options.mcpServers));
      log.info({ mcpCount: mcpNames.length, target: targetCwd }, "Injected MCP servers into project settings.json");
    } catch (err) {
      log.error({ err }, "Failed to inject MCP servers into gemini settings");
    }

    // Use the target directory as cwd if we created a temp one
    if (tempCwd && !options.cwd) {
      options.cwd = tempCwd;
    }
  }

  // Isolate gemini home to prevent reading user's global config
  const realGeminiDir = join(process.env.HOME || "/tmp", ".gemini");
  const isolatedHome = join(tmpdir(), `gemini-home-${Date.now()}`);
  mkdirSync(isolatedHome, { recursive: true });
  activeTempDirs.add(isolatedHome);

  // Copy auth files from real home
  for (const f of ["oauth_creds.json", "google_accounts.json"]) {
    const src = join(realGeminiDir, f);
    if (existsSync(src)) {
      try { copyFileSync(src, join(isolatedHome, f)); } catch { /* skip */ }
    }
  }

  const args: string[] = ["--prompt", prompt, "--output-format", "stream-json"];

  if (options.model) args.push("--model", options.model);
  if (options.approvalMode) {
    args.push("--approval-mode", options.approvalMode);
  } else if (options.yolo) {
    args.push("--yolo");
  }
  if (options.resume) args.push("--resume", options.resume);
  for (const name of mcpNames) args.push("--allowed-mcp-server-names", name);

  const log = taskLogger("gemini-executor");
  let child: ChildProcess | null = null;

  const generator = async function* () {
    log.info({ geminiPath: options.geminiPath, args }, "Spawning gemini process");
    
    child = spawn(options.geminiPath, args, {
      cwd: options.cwd || undefined,
      env: { ...process.env, ...options.env, GEMINI_CLI_HOME: isolatedHome },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    activeChildren.add(child);

    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to spawn gemini process: stdout/stderr not available");
    }

    let buffer = "";
    let stderrBuffer = "";
    let accumulatedText = "";
    let gotFirstData = false;

    // Startup timeout: emit warning if no stdout data after 30s
    const startupWarningTimer = setTimeout(() => {
      if (!gotFirstData && !finished) {
        const warning: GeminiMessage = {
          type: "assistant",
          _synthetic: true,
          message: { content: [{ type: "text", text: "Warning: Gemini CLI has not produced any output after 30s. MCP server initialization may be stuck, or the API call is slow. Check MCP configuration or cancel the task." }] },
        };
        if (resolveNext) {
          resolveNext({ value: warning, done: false });
          resolveNext = null;
        } else {
          queue.push(warning);
        }
      }
    }, 30_000);

    // Collect stderr as it arrives
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      log.info({ stderr: text.trim().slice(0, 300) }, "Gemini stderr chunk");
    });

    // Handle stdout using Node.js stream events
    const stdout = child.stdout;

    // We'll use a promise-based queue for the async generator
    const queue: any[] = [];
    let resolveNext: ((value: any) => void) | null = null;
    let finished = false;

    stdout.on("data", (chunk) => {
      const data = chunk.toString();
      if (!gotFirstData) { gotFirstData = true; clearTimeout(startupWarningTimer); }
      log.info({ dataLength: data.length }, "Gemini stdout data received");
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (let line of lines) {
        if (!line.trim()) continue;
        // Gemini CLI may prepend non-JSON text to a JSON line (e.g. "MCP issues detected...{...}")
        const jsonStart = line.indexOf("{");
        if (jsonStart > 0) {
          log.info({ prefix: line.slice(0, jsonStart) }, "Stripped non-JSON prefix from line");
          line = line.slice(jsonStart);
        }
        try {
          const raw = JSON.parse(line);

          // Track accumulated assistant text from delta messages
          if (raw.type === "message" && raw.role === "assistant" && raw.content) {
            accumulatedText += raw.content;
          }

          // Inject accumulated text into result so executor can use it
          if (raw.type === "result") {
            if (!raw.result && accumulatedText) {
              raw.result = accumulatedText;
            }
          }

          const mapped = mapGeminiMessage(raw);
          log.info({ type: mapped.type, rawType: raw.type, hasContent: !!(mapped.message?.content?.length) }, "Mapped gemini message");
          if (resolveNext) {
            resolveNext({ value: mapped, done: false });
            resolveNext = null;
          } else {
            queue.push(mapped);
          }
        } catch {
          log.info({ line: line.slice(0, 200) }, "Non-JSON gemini output line");
        }
      }
    });

    stdout.on("end", () => {
      clearTimeout(startupWarningTimer);
      log.info({ accumulatedTextLength: accumulatedText.length, stderrLength: stderrBuffer.length }, "Gemini stdout stream ended");
      finished = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    });

    child.on("error", (err) => {
      log.error({ err: err.message }, "Gemini child process error");
      finished = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    });

    child.on("exit", (code, signal) => {
      log.info({ code, signal, remainingBuffer: buffer.slice(0, 500) }, "Gemini process exited");
      activeChildren.delete(child!);
      // Keep temp directory alive so gemini --resume can find its session
      if (tempCwd) {
        activeTempDirs.delete(tempCwd);
      }
      // Clean up isolated gemini home (contains copied auth credentials)
      if (activeTempDirs.has(isolatedHome)) {
        activeTempDirs.delete(isolatedHome);
        try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      finished = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    });

    while (!finished || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift();
      } else if (!finished) {
        const next = await new Promise<any>((resolve) => {
          resolveNext = resolve;
        });
        if (next.done) break;
        yield next.value;
      }
    }

    if (stderrBuffer.trim()) {
      log.warn({ stderr: stderrBuffer.slice(0, 2000) }, "Gemini stderr output");
    }
  };

  const effectiveCwd = options.cwd || undefined;
  const query: GeminiQuery = {
    effectiveCwd,
    [Symbol.asyncIterator]: generator,
    interrupt: async () => {
      if (child && child.exitCode === null) {
        log.info("Interrupting gemini process group (SIGINT)");
        killProcessGroup(child, "SIGINT");
      }
    },
    close: () => {
      if (child && child.exitCode === null) {
        log.info("Closing gemini process group (SIGTERM)");
        killProcessGroup(child, "SIGTERM");
        const ref = child;
        setTimeout(() => {
          if (ref.exitCode === null) {
            log.info("Gemini process group did not exit after SIGTERM, sending SIGKILL");
            killProcessGroup(ref, "SIGKILL");
          }
        }, 3000).unref();
      }
    },
  };

  return query;
}

function mapGeminiMessage(raw: any): GeminiMessage {
  const type = raw.type;

  if (type === "init") {
    return {
      type: "init",
      session_id: raw.session_id,
    };
  }

  if (type === "message" && raw.role === "assistant") {
    return {
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: raw.content,
        }],
      },
    };
  }

  if (type === "result") {
    return {
      type: "result",
      status: raw.status,
      subtype: raw.status ?? undefined,
      session_id: raw.session_id,
      total_cost_usd: raw.stats?.cost_usd ?? 0, // TODO: Gemini CLI may not report cost
      duration_ms: raw.stats?.duration_ms ?? 0,
      stats: raw.stats ?? undefined,
      result: raw.result,
      structured_output: raw.structured_output,
    };
  }

  if (type === "tool_use" || type === "action" || type === "tool_call") {
    return {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: raw.tool_name ?? raw.name,
          input: raw.parameters ?? raw.input ?? raw.args,
        }],
      },
    };
  }

  if (type === "tool_result") {
    // Tool results don't map to a user-visible message type;
    // emit as assistant with empty content so executor skips it gracefully
    return { type: "assistant", message: { content: [] } };
  }

  if (type === "message" && raw.role === "user") {
    // User prompt echo — skip
    return { type: "assistant", message: { content: [] } };
  }

  return { type: "assistant", message: { content: [] } }; // Fallback
}
