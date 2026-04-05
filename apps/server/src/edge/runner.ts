#!/usr/bin/env tsx
/**
 * Edge Runner — spawns isolated Claude/Gemini sessions per stage via node-pty.
 *
 * Usage:
 *   npx tsx src/edge/runner.ts <task-id>
 *   npx tsx src/edge/runner.ts --trigger "task description" --pipeline edge-test-claude
 *   npx tsx src/edge/runner.ts --trigger "task description" --pipeline edge-test-gemini --engine gemini
 *   npx tsx src/edge/runner.ts --trigger "task description" --pipeline pipeline-generator
 */

import * as pty from "node-pty";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildChildEnv } from "../lib/child-env.js";

const tmpSuffix = randomUUID().slice(0, 12);

// --- Configuration ---

const DEFAULT_SERVER_URL = "http://localhost:3001";
const __edgeDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const HOOKS_TEMPLATE_PATH = path.resolve(__edgeDir, "../../config/edge-hooks.json");
const GEMINI_HOOKS_TEMPLATE_PATH = path.resolve(__edgeDir, "../../config/edge-hooks-gemini.json");
const STAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

type Engine = "claude" | "gemini" | "codex";

// --- CLI Argument Parsing ---

interface RunnerArgs {
  taskId?: string;
  trigger?: string;
  pipeline?: string;
  engine: Engine;
  serverUrl: string;
}

function parseCliArgs(): RunnerArgs {
  // Strip leading "--" from argv that pnpm injects when forwarding arguments
  const rawArgs = process.argv.slice(2);
  while (rawArgs.length > 0 && rawArgs[0] === "--") rawArgs.shift();

  const { values, positionals } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      trigger: { type: "string" },
      pipeline: { type: "string" },
      engine: { type: "string", default: "claude" },
      server: { type: "string", default: DEFAULT_SERVER_URL },
    },
  });

  return {
    taskId: positionals[0],
    trigger: values.trigger,
    pipeline: values.pipeline,
    engine: (values.engine as Engine) ?? "claude",
    serverUrl: values.server ?? DEFAULT_SERVER_URL,
  };
}

// --- Binary Resolution ---

function findBinary(name: string): string {
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim();
  } catch {
    return name;
  }
}

// --- Desktop Notification ---

function notifyDesktop(title: string, message: string): void {
  try {
    if (process.platform === "darwin") {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      execFileSync("osascript", [
        "-e",
        `display notification "${esc(message)}" with title "${esc(title)}"`,
      ]);
    }
  } catch { /* non-critical */ }
}

// --- HTTP Helpers ---

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

interface PendingQuestionInfo {
  questionId: string;
  text: string;
  options?: string[];
}

interface StageOptions {
  engine?: Engine;
  model?: string;
  effort?: string;
  permission_mode?: string;
  debug?: boolean;
  max_turns?: number;
  max_budget_usd?: number;
  disallowed_tools?: string[];
  agents?: Record<string, unknown>;
  mcps?: string[];
}

interface NextStageResponse {
  done?: boolean;
  status?: string;
  waiting?: boolean;
  isGate?: boolean;
  stageName?: string;
  cwd?: string;
  stageOptions?: StageOptions;
  error?: string;
  pendingQuestion?: PendingQuestionInfo;
}

async function fetchNextStage(serverUrl: string, taskId: string): Promise<NextStageResponse> {
  return fetchJson<NextStageResponse>(`${serverUrl}/api/edge/${taskId}/next-stage`);
}

// --- SSE Event Source ---

interface EdgeEvent {
  event: string;
  data: Record<string, unknown>;
}

type EdgeEventHandler = (event: EdgeEvent) => void;

interface EdgeEventSource {
  close: () => void;
}

function connectEdgeEvents(serverUrl: string, taskId: string, handler: EdgeEventHandler): EdgeEventSource {
  let abortController: AbortController;
  let closed = false;

  const connect = async () => {
    let backoff = 2000;
    const MAX_BACKOFF = 30_000;

    while (!closed) {
      abortController = new AbortController();
      try {
        const res = await fetch(`${serverUrl}/api/edge/${taskId}/events`, {
          signal: abortController.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          if (!closed) {
            await sleep(backoff);
            backoff = Math.min(backoff * 1.5, MAX_BACKOFF);
          }
          continue;
        }

        // Successful connection - reset backoff
        backoff = 2000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEvent = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ") && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                handler({ event: currentEvent, data });
              } catch { /* malformed data */ }
              currentEvent = "";
            } else if (line === "" || line.startsWith(":")) {
              currentEvent = "";
            }
          }
        }
      } catch (err) {
        if (closed) return;
        // Reconnect after network error with exponential backoff
        await sleep(backoff);
        backoff = Math.min(backoff * 1.5, MAX_BACKOFF);
      }
    }
  };

  connect();

  return {
    close() {
      closed = true;
      abortController.abort();
    },
  };
}

function waitForEdgeEvent(
  serverUrl: string,
  taskId: string,
  predicate: (event: EdgeEvent) => boolean,
  timeoutMs = 30 * 60 * 1000,
): { promise: Promise<EdgeEvent | null>; close: () => void } {
  let resolve: (value: EdgeEvent | null) => void;
  const promise = new Promise<EdgeEvent | null>((r) => { resolve = r; });
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    source.close();
    resolve(null);
  }, timeoutMs);

  const source = connectEdgeEvents(serverUrl, taskId, (event) => {
    if (settled) return;
    if (predicate(event)) {
      settled = true;
      clearTimeout(timer);
      source.close();
      resolve(event);
    }
  });

  return {
    promise,
    close() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.close();
      resolve(null);
    },
  };
}

async function triggerNewTask(
  serverUrl: string,
  pipeline: string,
  taskText: string,
): Promise<string> {
  const { taskId } = await fetchJson<{ taskId: string }>(`${serverUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText, pipelineName: pipeline, edge: true }),
  });

  await fetchJson(`${serverUrl}/api/tasks/${taskId}/launch`, { method: "POST" });

  return taskId;
}

// --- Dynamic Config Generation ---

function writeMcpConfig(serverUrl: string): string {
  const tmpPath = `/tmp/.wfctl-edge-mcp-${tmpSuffix}.json`;
  fs.writeFileSync(tmpPath, JSON.stringify({
    mcpServers: { "workflow-control": { type: "http", url: `${serverUrl}/mcp` } },
  }), { mode: 0o600 });
  return tmpPath;
}

function writeHooksSettings(serverUrl: string): string {
  const tmpPath = `/tmp/.wfctl-edge-hooks-${tmpSuffix}.json`;
  const template = JSON.parse(fs.readFileSync(HOOKS_TEMPLATE_PATH, "utf-8"));

  // Patch PreToolUse check-interrupt with actual server URL
  if (template.hooks?.PreToolUse) {
    for (const rule of template.hooks.PreToolUse) {
      for (const hook of rule.hooks ?? []) {
        if (hook.command?.includes("check-interrupt")) {
          hook.command = `bash -c 'TASK_ID="\${OG_TASK_ID:-}"; [ -z "$TASK_ID" ] && exit 0; R=$(curl -s --max-time 3 "${serverUrl}/api/edge/$TASK_ID/check-interrupt" 2>/dev/null); echo "$R" | grep -q "\\\"interrupted\\\":true" && echo "{\\\"continue\\\": false, \\\"stopReason\\\": \\\"Task interrupted\\\"}"'`;
        }
      }
    }
  }

  fs.writeFileSync(tmpPath, JSON.stringify({ hooks: template.hooks }), { mode: 0o600 });
  return tmpPath;
}

// --- Gemini Project Settings ---

// NOTE: Module-level singletons — safe because edge runner is a single-task-at-a-time CLI process.
// If concurrent execution is ever needed, scope these per-invocation.
let geminiSettingsBackup: { path: string; content: string } | null = null;
let geminiSettingsCwd = process.cwd();

function writeGeminiProjectSettings(serverUrl: string, cwd: string): void {
  geminiSettingsCwd = cwd;
  const geminiDir = path.join(cwd, ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");

  // Backup existing file if present
  if (fs.existsSync(settingsPath)) {
    geminiSettingsBackup = { path: settingsPath, content: fs.readFileSync(settingsPath, "utf-8") };
  }

  // Load hooks template and patch server URL
  const template = JSON.parse(fs.readFileSync(GEMINI_HOOKS_TEMPLATE_PATH, "utf-8"));
  if (template.hooks?.BeforeTool) {
    for (const rule of template.hooks.BeforeTool) {
      for (const hook of rule.hooks ?? []) {
        if (hook.command?.includes("check-interrupt")) {
          hook.command = `bash -c 'TASK_ID="\${OG_TASK_ID:-}"; [ -z "$TASK_ID" ] && exit 0; R=$(curl -s --max-time 3 "${serverUrl}/api/edge/$TASK_ID/check-interrupt" 2>/dev/null); echo "$R" | grep -q "\\\"interrupted\\\":true" && echo "{\\\"continue\\\": false, \\\"stopReason\\\": \\\"Task interrupted\\\"}"'`;
        }
      }
    }
  }

  // Merge with existing project settings if backup exists
  let settings: Record<string, unknown> = {};
  if (geminiSettingsBackup) {
    try { settings = JSON.parse(geminiSettingsBackup.content); } catch { /* start fresh */ }
  }
  settings.hooks = template.hooks;

  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function restoreGeminiProjectSettings(cwd: string): void {
  const settingsPath = path.join(cwd, ".gemini", "settings.json");
  if (geminiSettingsBackup) {
    fs.writeFileSync(geminiSettingsBackup.path, geminiSettingsBackup.content);
    geminiSettingsBackup = null;
  } else {
    try { fs.unlinkSync(settingsPath); } catch { /* ok */ }
  }
}

function cleanup(): void {
  try { fs.unlinkSync(`/tmp/.wfctl-edge-mcp-${tmpSuffix}.json`); } catch { /* ok */ }
  try { fs.unlinkSync(`/tmp/.wfctl-edge-hooks-${tmpSuffix}.json`); } catch { /* ok */ }
  restoreGeminiProjectSettings(geminiSettingsCwd);
}

// --- Transcript Sync ---

function getProjectDir(cwd: string): string {
  const normalized = path.resolve(cwd).replace(/\//g, "-");
  return path.join(process.env.HOME ?? "~", ".claude", "projects", normalized);
}

function findNewestJsonl(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let newest: string | null = null;
    let newestMtime = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = fullPath;
      }
    }
    return newest;
  } catch {
    return null;
  }
}

function startTranscriptSync(taskId: string, serverUrl: string, cwd: string): NodeJS.Timeout {
  const projectDir = getProjectDir(cwd);
  let transcriptPath: string | null = null;
  let lastOffset = 0;

  return setInterval(async () => {
    try {
      if (!transcriptPath) {
        transcriptPath = findNewestJsonl(projectDir);
        if (!transcriptPath) return;
      }

      const stat = fs.statSync(transcriptPath);
      if (stat.size <= lastOffset) return;

      const MAX_TRANSCRIPT_CHUNK = 1024 * 1024; // 1MB per tick
      const readSize = Math.min(stat.size - lastOffset, MAX_TRANSCRIPT_CHUNK);
      const fd = fs.openSync(transcriptPath, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, buf.length, lastOffset);
      fs.closeSync(fd);
      lastOffset += readSize;

      const newData = buf.toString("utf-8");
      const lines = newData.split("\n").filter(Boolean);

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "assistant" && entry.message?.content) {
            for (const block of entry.message.content) {
              if (block.type === "text") {
                events.push({ type: "text", data: { text: block.text?.slice(0, 500) } });
              } else if (block.type === "tool_use") {
                events.push({ type: "tool_use", data: { toolName: block.name, input: block.input } });
              } else if (block.type === "thinking") {
                events.push({ type: "thinking", data: { text: block.thinking?.slice(0, 300) } });
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }

      if (events.length > 0) {
        await fetch(`${serverUrl}/api/edge/${taskId}/stream-event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(events),
        }).catch(() => {});
      }
    } catch { /* non-critical */ }
  }, 2000);
}

// --- Model Validation ---

const KNOWN_CLAUDE_MODELS = [
  "haiku", "sonnet", "opus",
  "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6",
];
const KNOWN_GEMINI_MODELS = [
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash",
];
const KNOWN_CODEX_MODELS = [
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3", "o4-mini",
];

async function resolveModel(
  configured: string | undefined,
  engine: Engine,
): Promise<string | undefined> {
  if (!configured) return undefined;

  const known = engine === "gemini" ? KNOWN_GEMINI_MODELS : engine === "codex" ? KNOWN_CODEX_MODELS : KNOWN_CLAUDE_MODELS;
  if (known.includes(configured)) return configured;

  // Unknown model — prompt user
  console.log(`\nConfigured model "${configured}" is not in known list for ${engine}.`);
  console.log(`Known models: ${known.join(", ")}`);

  if (!process.stdin.isTTY) {
    console.log(`Non-interactive mode — using "${configured}" as-is.`);
    return configured;
  }

  return new Promise<string>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Enter model name (or press Enter to use "${configured}"): `, (input) => {
      rl.close();
      if (process.stdin.isTTY && wasRaw) process.stdin.setRawMode(true);
      const choice = input.trim();
      resolve(choice || configured);
    });
  });
}

// --- Stage Execution ---

async function runStage(
  taskId: string,
  stageName: string,
  serverUrl: string,
  cwd: string,
  defaultEngine: Engine,
  mcpConfigPath: string,
  hooksSettingsPath: string,
  onCancel: () => void,
  stageOptions?: StageOptions,
): Promise<"completed" | "aborted"> {
  const engine: Engine = stageOptions?.engine ?? defaultEngine;
  const model = await resolveModel(stageOptions?.model, engine);

  return new Promise<"completed" | "aborted">((resolve) => {
    const prompt = [
      `Execute stage "${stageName}" for task "${taskId}".`,
      "Call get_stage_context first to get your instructions.",
      "Follow the systemPrompt exactly.",
      "When done, call submit_stage_result with your JSON output.",
    ].join(" ");

    const cmd = engine === "gemini" ? "gemini" : engine === "codex" ? findBinary("codex") : findBinary("claude");
    const args: string[] = [];

    if (engine === "codex") {
      // No --json: edge runner uses PTY interactive mode, not JSONL parsing
      args.push("exec");
      if (model) args.push("--model", model);
      const permMode = stageOptions?.permission_mode ?? "bypassPermissions";
      if (permMode === "bypassPermissions") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else if (permMode === "plan") {
        args.push("--sandbox", "read-only");
      } else {
        args.push("--full-auto");
      }
      args.push(prompt);
    } else if (engine === "gemini") {
      writeGeminiProjectSettings(serverUrl, cwd);
      args.push("--yolo");
      if (model) args.push("--model", model);
      if (stageOptions?.debug) args.push("--debug");
      if (stageOptions?.permission_mode) {
        const modeMap: Record<string, string> = {
          bypassPermissions: "yolo", default: "default",
          acceptEdits: "auto_edit", plan: "plan",
        };
        const mapped = modeMap[stageOptions.permission_mode];
        if (mapped && mapped !== "yolo") args.push("--approval-mode", mapped);
      }
      args.push(prompt);
    } else {
      args.push("--mcp-config", mcpConfigPath, "--settings", hooksSettingsPath);
      if (model) args.push("--model", model);
      if (stageOptions?.effort) args.push("--effort", stageOptions.effort);
      if (stageOptions?.debug) args.push("--debug");

      // Permission mode
      const permMode = stageOptions?.permission_mode ?? "bypassPermissions";
      if (permMode === "bypassPermissions") {
        args.push("--dangerously-skip-permissions");
      } else {
        args.push("--permission-mode", permMode);
      }

      // Disallowed tools
      if (stageOptions?.disallowed_tools?.length) {
        args.push("--disallowed-tools", ...stageOptions.disallowed_tools);
      }

      // Sub-agents
      if (stageOptions?.agents && Object.keys(stageOptions.agents).length > 0) {
        args.push("--agents", JSON.stringify(stageOptions.agents));
      }

      args.push(prompt);
    }

    const modelLabel = model ?? "default";
    const effortLabel = stageOptions?.effort ?? "default";
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Stage: ${stageName} (${engine}, model: ${modelLabel}, effort: ${effortLabel})`);
    console.log(`${"=".repeat(60)}\n`);

    // Warn about unsupported options in edge mode
    const warnings: string[] = [];
    if (stageOptions?.max_turns) warnings.push(`max_turns: ${stageOptions.max_turns} (not supported by ${engine} CLI)`);
    if (stageOptions?.max_budget_usd) warnings.push(`max_budget_usd: ${stageOptions.max_budget_usd} (not supported in interactive mode)`);
    if (engine === "gemini") {
      if (stageOptions?.effort) warnings.push(`effort: ${stageOptions.effort} (not supported by Gemini CLI)`);
      if (stageOptions?.disallowed_tools?.length) warnings.push(`disallowed_tools (not supported by Gemini CLI, use Policy Engine)`);
      if (stageOptions?.agents && Object.keys(stageOptions.agents).length > 0) warnings.push(`agents (not supported by Gemini CLI)`);
    }
    if (engine === "codex") {
      if (stageOptions?.effort) warnings.push(`effort: ${stageOptions.effort} (not supported by Codex CLI)`);
      if (stageOptions?.disallowed_tools?.length) warnings.push(`disallowed_tools (not supported by Codex CLI)`);
      if (stageOptions?.agents && Object.keys(stageOptions.agents).length > 0) warnings.push(`agents (not supported by Codex CLI)`);
    }
    if (warnings.length > 0) {
      console.log(`  Ignored pipeline options (edge mode):`);
      for (const w of warnings) console.log(`    - ${w}`);
      console.log();
    }

    const ptyProcess = pty.spawn(cmd, args, {
      name: "xterm-256color",
      cols: process.stdout.columns ?? 120,
      rows: process.stdout.rows ?? 40,
      cwd,
      env: buildChildEnv({
        OG_TASK_ID: taskId,
        OG_SERVER_URL: serverUrl,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      }),
    });

    let stageCompleted = false;
    let commandMode = false;
    let suspended = false; // true while stdin is handed off (e.g. to readline)
    let ptyBuffer = ""; // buffer PTY output while in command mode

    ptyProcess.onData((data: string) => {
      if (commandMode) {
        ptyBuffer += data;
        return;
      }
      process.stdout.write(data);
      if (!stageCompleted) {
        // Claude: hook outputs this message and process exits
        if (data.includes("hook stopped continuation")) {
          stageCompleted = true;
          setTimeout(() => ptyProcess.kill(), 2000);
        }
        // Gemini: hook stops agent loop but process stays alive in interactive mode
        if (data.includes("Agent execution stopped")) {
          stageCompleted = true;
          setTimeout(() => ptyProcess.kill(), 1000);
        }
      }
    });

    const detachStdin = () => {
      suspended = true;
      process.stdin.removeListener("data", stdinListener);
    };

    const reattachStdin = () => {
      suspended = false;
      process.stdin.on("data", stdinListener);
    };

    // Command mode handler
    const showCommandMenu = () => {
      console.log("\n--- Command Mode (Ctrl+\\) ---");
      console.log("  c = cancel task        (same as Ctrl+C)");
      console.log("  p = pause & exit       (keep task, re-attach later)");
      console.log("  m = send message       (interrupt agent with a message)");
      console.log("  q = back to agent");
      console.log("---\n");
    };

    const exitCommandMode = () => {
      commandMode = false;
      if (ptyBuffer) {
        process.stdout.write(ptyBuffer);
        ptyBuffer = "";
      }
    };

    const handleCommandKey = (key: string) => {
      switch (key) {
        case "c":
          exitCommandMode();
          onCancel();
          break;
        case "p":
          exitCommandMode();
          ptyProcess.kill();
          break;
        case "m":
          exitCommandMode();
          detachStdin();
          readMessageAndWrite(ptyProcess, reattachStdin);
          break;
        case "q":
          console.log("  Resuming...\n");
          exitCommandMode();
          break;
        default:
          console.log("  Unknown command. Use: c, p, m, or q");
          showCommandMenu();
          break;
      }
    };

    const stdinListener = (data: Buffer) => {
      if (commandMode) {
        const key = data.toString().trim().toLowerCase();
        if (key) handleCommandKey(key);
        return;
      }
      // Ctrl+C
      if (data.length === 1 && data[0] === 0x03) {
        onCancel();
        return;
      }
      // Ctrl+\ — enter command mode
      if (data.length === 1 && data[0] === 0x1c) {
        commandMode = true;
        showCommandMenu();
        return;
      }
      ptyProcess.write(data.toString());
    };
    process.stdin.on("data", stdinListener);

    // Stage timeout
    const stageTimeout = setTimeout(() => {
      console.log(`\nStage "${stageName}" timed out after ${STAGE_TIMEOUT_MS / 1000}s`);
      ptyProcess.kill();
      finalKillTimer = setTimeout(() => {
        try { ptyProcess.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5000);
    }, STAGE_TIMEOUT_MS);

    // Transcript sync
    const syncInterval = startTranscriptSync(taskId, serverUrl, cwd);

    // Codex has no hooks — poll server for interrupt signals instead
    const interruptInterval = engine === "codex" ? setInterval(async () => {
      try {
        const res = await fetch(`${serverUrl}/api/edge/${taskId}/check-interrupt`, { signal: AbortSignal.timeout(3000) });
        const body = await res.json() as { interrupted?: boolean };
        if (body.interrupted) {
          console.log("\nTask interrupted — killing Codex process.");
          ptyProcess.kill();
        }
      } catch { /* non-critical */ }
    }, 5000) : null;

    let isResolved = false;
    const resolveOnce = (result: "completed" | "aborted") => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(stageTimeout);
      clearTimeout(finalKillTimer);
      clearInterval(syncInterval);
      if (interruptInterval) clearInterval(interruptInterval);
      process.stdin.removeListener("data", stdinListener);
      if (engine === "gemini") restoreGeminiProjectSettings(cwd);
      resolve(result);
    };

    let finalKillTimer: ReturnType<typeof setTimeout>;

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`\nStage "${stageName}" exited (code: ${exitCode})`);
      // Gemini exits with code 0 after hook stops it; Claude outputs "hook stopped continuation" first.
      // Codex exec runs to completion and exits — no hooks, so exitCode 0 means success.
      const completed = stageCompleted || ((engine === "gemini" || engine === "codex") && exitCode === 0);
      resolveOnce(completed ? "completed" : "aborted");
    });
  });
}

// --- Gate Handling ---

async function handleGate(
  taskId: string,
  gateName: string,
  serverUrl: string,
): Promise<void> {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  notifyDesktop(`Gate: ${gateName}`, "Waiting for your decision in the terminal.");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  GATE: ${gateName}`);
  console.log(`  Waiting for your decision.`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n  a = approve   r = reject   f = feedback`);
  console.log(`  (or approve/reject from the dashboard)\n`);

  return new Promise<void>((resolveGate) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      eventSource.close();
      rl.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      resolveGate();
    };

    // SSE push: dashboard may resolve the gate
    const eventSource = connectEdgeEvents(serverUrl, taskId, (event) => {
      if (done) return;
      if (event.event === "status_changed" || event.event === "task_terminated" || event.event === "slot_created") {
        console.log("\n  Gate resolved from dashboard.");
        finish();
      }
    });

    const promptUser = () => {
      if (done) return;
      rl.question("> ", async (input) => {
        if (done) return;
        const cmd = input.trim().toLowerCase();

        if (cmd === "a" || cmd === "approve") {
          try {
            await fetchJson(`${serverUrl}/api/tasks/${taskId}/confirm`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });
            console.log("  Approved.");
            finish();
          } catch (err) {
            console.log(`  Approve failed: ${err}`);
            promptUser();
          }
        } else if (cmd === "r" || cmd === "reject") {
          rl.question("  Reason (optional): ", async (reason) => {
            if (done) return;
            try {
              await fetchJson(`${serverUrl}/api/tasks/${taskId}/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "reject", reason: reason.trim() || undefined }),
              });
              console.log("  Rejected.");
              finish();
            } catch (err) {
              console.log(`  Reject failed: ${err}`);
              promptUser();
            }
          });
        } else if (cmd === "f" || cmd === "feedback") {
          rl.question("  Feedback: ", async (feedback) => {
            if (done) return;
            if (!feedback.trim()) {
              console.log("  Empty feedback, try again.");
              promptUser();
              return;
            }
            try {
              await fetchJson(`${serverUrl}/api/tasks/${taskId}/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "feedback", feedback: feedback.trim() }),
              });
              console.log("  Feedback sent.");
              finish();
            } catch (err) {
              console.log(`  Feedback failed: ${err}`);
              promptUser();
            }
          });
        } else if (cmd) {
          console.log("  Unknown command. Use: a, r, or f");
          promptUser();
        } else {
          promptUser();
        }
      });
    };

    rl.on("close", () => { done = true; });

    promptUser();
  });
}

// --- Question Handling ---

async function handleQuestion(
  taskId: string,
  question: PendingQuestionInfo,
  serverUrl: string,
): Promise<void> {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  notifyDesktop("Question from agent", question.text);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  QUESTION from agent:`);
  console.log(`  ${question.text}`);
  if (question.options?.length) {
    console.log(`  Options: ${question.options.join(", ")}`);
  }
  console.log(`${"=".repeat(60)}`);
  console.log(`  (or answer from the dashboard)\n`);

  return new Promise<void>((resolveQuestion) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(pollInterval);
      rl.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      resolveQuestion();
    };

    // Poll: question answered does not trigger a status event, so SSE cannot detect it.
    // The questionManager.answer() resolves an internal Promise without emitting wf.status.
    const pollInterval = setInterval(async () => {
      if (done) return;
      try {
        const next = await fetchNextStage(serverUrl, taskId);
        if (!next.pendingQuestion || next.pendingQuestion.questionId !== question.questionId) {
          console.log("\n  Question answered from dashboard.");
          finish();
        }
      } catch { /* retry next tick */ }
    }, 2000);

    const promptUser = () => {
      if (done) return;
      rl.question("Answer> ", async (input) => {
        if (done) return;
        const answer = input.trim();
        if (!answer) {
          promptUser();
          return;
        }
        try {
          await fetchJson(`${serverUrl}/api/tasks/${taskId}/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId: question.questionId, answer }),
          });
          console.log("  Answer sent.");
          finish();
        } catch (err) {
          console.log(`  Answer failed: ${err}`);
          promptUser();
        }
      });
    };

    rl.on("close", () => { done = true; });

    promptUser();
  });
}

// --- Send Message (from command mode) ---
// Writes the user's message directly into the PTY stdin so the running
// Claude/Gemini process receives it as interactive input.

function readMessageAndWrite(
  ptyProcess: pty.IPty,
  reattach: () => void,
): void {
  // Caller already detached stdinListener before invoking this function.
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question("Message> ", (input) => {
    rl.close();
    const message = input.trim();
    if (message) {
      ptyProcess.write(message + "\n");
      console.log("  Message written to agent stdin.\n");
    } else {
      console.log("  Empty message, cancelled.\n");
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    reattach();
  });
}

// --- Main Pipeline Loop ---

async function runPipeline(
  taskId: string,
  serverUrl: string,
  engine: Engine,
  mcpConfigPath: string,
  hooksSettingsPath: string,
  onCancel: () => void,
): Promise<void> {
  console.log(`\nPipeline started: ${taskId}`);
  console.log(`Server: ${serverUrl}`);
  console.log(`Engine: ${engine}\n`);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  // Auto-recover if task is in a terminal-ish state (re-attach scenario)
  const initial = await fetchNextStage(serverUrl, taskId);
  if (initial.done && (initial.status === "blocked" || initial.status === "cancelled")) {
    console.log(`Task is ${initial.status}, attempting to resume...`);
    try {
      await fetchJson(`${serverUrl}/api/tasks/${taskId}/resume`, { method: "POST" });
      console.log("Resume successful.");
    } catch (err) {
      console.log(`Resume failed: ${err}`);
    }
  } else if (initial.done && initial.status === "completed") {
    console.log(`Task already completed.`);
    return;
  }

  try {
    while (true) {
      const next = await fetchNextStage(serverUrl, taskId);

      if (next.done) {
        console.log(`\nPipeline ${next.status}: ${taskId}`);
        break;
      }

      if (next.waiting) {
        if (next.isGate) {
          await handleGate(taskId, next.status ?? "gate", serverUrl);
          continue;
        }
        if (next.pendingQuestion) {
          await handleQuestion(taskId, next.pendingQuestion, serverUrl);
          continue;
        }
        // Wait for an SSE event instead of polling
        const { promise, close } = waitForEdgeEvent(serverUrl, taskId, (e) =>
          e.event === "slot_created" || e.event === "task_terminated" || e.event === "status_changed",
        );
        process.stdout.write(".");
        await promise;
        close();
        continue;
      }

      if (next.stageName) {
        if (next.isGate) {
          await handleGate(taskId, next.stageName, serverUrl);
        } else {
          const result = await runStage(
            taskId, next.stageName, serverUrl, next.cwd ?? process.cwd(), engine,
            mcpConfigPath, hooksSettingsPath,
            onCancel, next.stageOptions,
          );
          if (result === "aborted") {
            console.log("\nPipeline paused. Re-attach with:");
            console.log(`  npx tsx src/edge/runner.ts ${taskId} --server ${serverUrl}\n`);
            return;
          }
        }
        continue;
      }

      // Fallback: wait for event (should rarely reach here)
      const { promise, close } = waitForEdgeEvent(serverUrl, taskId, (e) =>
        e.event === "slot_created" || e.event === "task_terminated" || e.event === "status_changed",
      );
      await promise;
      close();
    }
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Entry Point ---

async function main(): Promise<void> {
  const args = parseCliArgs();
  const serverUrl = args.serverUrl;

  // Generate dynamic configs
  const mcpConfigPath = writeMcpConfig(serverUrl);
  const hooksSettingsPath = writeHooksSettings(serverUrl);

  let taskId: string;

  if (args.trigger) {
    if (!args.pipeline) {
      console.error("Error: --pipeline is required when using --trigger");
      process.exit(1);
    }
    console.log(`Triggering new task: "${args.trigger}" (pipeline: ${args.pipeline})`);
    taskId = await triggerNewTask(serverUrl, args.pipeline, args.trigger);
    console.log(`Task created: ${taskId}`);
  } else if (args.taskId) {
    taskId = args.taskId;
  } else {
    console.error("Usage: runner.ts <task-id> | --trigger <text> --pipeline <name>");
    process.exit(1);
  }

  // Cancel handler
  let cancelRequested = false;
  const cancelAndExit = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    console.log("\nCancelling task...");
    fetch(`${serverUrl}/api/tasks/${taskId}/cancel`, { method: "POST" }).catch(() => {});
    setTimeout(() => {
      cleanup();
      process.exit(1);
    }, 500);
  };

  process.on("SIGINT", cancelAndExit);

  try {
    await runPipeline(taskId, serverUrl, args.engine, mcpConfigPath, hooksSettingsPath, cancelAndExit);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  cleanup();
  console.error("Runner error:", err);
  process.exit(1);
});
