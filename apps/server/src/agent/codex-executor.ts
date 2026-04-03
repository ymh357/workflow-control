import { spawn, type ChildProcess } from "node:child_process";
import { taskLogger } from "../lib/logger.js";

export interface CodexOptions {
  codexPath: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  cwd?: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, any>;
}

export interface CodexMessage {
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
  subtype?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  stats?: Record<string, unknown>;
  result?: string;
  error_message?: string;
  _synthetic?: boolean;
}

export interface CodexQuery extends AsyncIterable<CodexMessage> {
  interrupt(): Promise<void>;
  close(): void;
  effectiveCwd?: string;
}

// Track active child processes for cleanup on server exit
const activeChildren = new Set<ChildProcess>();

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
}

process.on("exit", cleanupChildren);

export function queryCodex(input: { prompt: string; options: CodexOptions }): CodexQuery {
  const { prompt, options } = input;
  const log = taskLogger("codex-executor");

  const args: string[] = ["exec", "--json"];

  if (options.model) args.push("--model", options.model);

  // Sandbox + approval: --full-auto = workspace-write + on-request approval
  // --dangerously-bypass-approvals-and-sandbox for full access
  const sandbox = options.sandbox ?? "workspace-write";
  if (sandbox === "danger-full-access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", sandbox, "--full-auto");
  }

  if (options.cwd) args.push("--cd", options.cwd);

  args.push(prompt);

  let child: ChildProcess | null = null;
  let accumulatedText = "";
  let threadId: string | undefined;
  let totalCost = 0;
  let totalDuration = 0;

  const generator = async function* () {
    log.info({ codexPath: options.codexPath, args: args.slice(0, 6) }, "Spawning codex process");

    child = spawn(options.codexPath, args, {
      cwd: options.cwd || undefined,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    activeChildren.add(child);

    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to spawn codex process: stdout/stderr not available");
    }

    let buffer = "";
    let stderrBuffer = "";
    let gotFirstData = false;
    const queue: CodexMessage[] = [];
    let resolveNext: ((value: IteratorResult<CodexMessage>) => void) | null = null;
    let finished = false;

    const startupWarningTimer = setTimeout(() => {
      if (!gotFirstData && !finished) {
        const warning: CodexMessage = {
          type: "assistant",
          _synthetic: true,
          message: { content: [{ type: "text", text: "Warning: Codex CLI has not produced any output after 30s. Check authentication or API connectivity." }] },
        };
        if (resolveNext) {
          resolveNext({ value: warning, done: false });
          resolveNext = null;
        } else {
          queue.push(warning);
        }
      }
    }, 30_000);

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      log.info({ stderr: text.trim().slice(0, 300) }, "Codex stderr chunk");
    });

    const stdout = child.stdout;

    stdout.on("data", (chunk) => {
      const data = chunk.toString();
      if (!gotFirstData) { gotFirstData = true; clearTimeout(startupWarningTimer); }
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          const mapped = mapCodexEvent(raw);
          if (!mapped) continue;

          if (mapped.session_id && !threadId) threadId = mapped.session_id;

          // Track accumulated text for result extraction
          if (mapped.type === "assistant" && mapped.message?.content) {
            for (const block of mapped.message.content) {
              if (block.type === "text" && block.text) accumulatedText += block.text;
            }
          }

          if (mapped.total_cost_usd) totalCost += mapped.total_cost_usd;
          if (mapped.duration_ms) totalDuration += mapped.duration_ms;

          if (resolveNext) {
            resolveNext({ value: mapped, done: false });
            resolveNext = null;
          } else {
            queue.push(mapped);
          }
        } catch {
          log.info({ line: line.slice(0, 200) }, "Non-JSON codex output line");
        }
      }
    });

    stdout.on("end", () => {
      clearTimeout(startupWarningTimer);
      log.info({ accumulatedTextLength: accumulatedText.length }, "Codex stdout stream ended");
      finished = true;

      // Emit final result if we accumulated any text
      if (accumulatedText) {
        const finalResult: CodexMessage = {
          type: "result",
          subtype: "success",
          session_id: threadId,
          result: accumulatedText,
          total_cost_usd: totalCost,
          duration_ms: totalDuration,
        };
        if (resolveNext) {
          resolveNext({ value: finalResult, done: false });
          resolveNext = null;
        } else {
          queue.push(finalResult);
        }
      }

      // Signal end
      setTimeout(() => {
        if (resolveNext) {
          resolveNext({ value: undefined as any, done: true });
          resolveNext = null;
        }
      }, 0);
    });

    child.on("error", (err) => {
      log.error({ err: err.message }, "Codex child process error");
      finished = true;
      if (resolveNext) {
        resolveNext({ value: undefined as any, done: true });
        resolveNext = null;
      }
    });

    child.on("exit", (code, signal) => {
      log.info({ code, signal }, "Codex process exited");
      activeChildren.delete(child!);
      finished = true;
      if (resolveNext) {
        resolveNext({ value: undefined as any, done: true });
        resolveNext = null;
      }
    });

    while (!finished || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else if (!finished) {
        const next = await new Promise<IteratorResult<CodexMessage>>((resolve) => {
          resolveNext = resolve;
        });
        if (next.done) break;
        yield next.value;
      }
    }

    if (stderrBuffer.trim()) {
      log.warn({ stderr: stderrBuffer.slice(0, 2000) }, "Codex stderr output");
    }
  };

  const query: CodexQuery = {
    effectiveCwd: options.cwd || undefined,
    [Symbol.asyncIterator]: generator,
    interrupt: async () => {
      if (child && child.exitCode === null) {
        log.info("Interrupting codex process (SIGINT)");
        killProcessGroup(child, "SIGINT");
      }
    },
    close: () => {
      if (child && child.exitCode === null) {
        log.info("Closing codex process (SIGTERM)");
        killProcessGroup(child, "SIGTERM");
        const ref = child;
        setTimeout(() => {
          if (ref.exitCode === null) killProcessGroup(ref, "SIGKILL");
        }, 3000).unref();
      }
    },
  };

  return query;
}

export function mapCodexEvent(raw: any): CodexMessage | null {
  const type = raw.type;

  if (type === "thread.started") {
    return {
      type: "init",
      session_id: raw.thread_id,
    };
  }

  if (type === "item.completed" && raw.item) {
    const item = raw.item;

    if (item.type === "agent_message") {
      return {
        type: "assistant",
        message: { content: [{ type: "text", text: item.text ?? "" }] },
      };
    }

    if (item.type === "command_execution") {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Bash",
            input: { command: item.command ?? "" },
          }],
        },
      };
    }

    if (item.type === "file_edit") {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Edit",
            input: { file_path: item.file_path ?? "", diff: item.diff ?? "" },
          }],
        },
      };
    }

    if (item.type === "mcp_tool_call") {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: item.tool_name ?? "mcp_tool",
            input: item.arguments ?? {},
          }],
        },
      };
    }

    if (item.type === "reasoning") {
      return {
        type: "assistant",
        message: { content: [{ type: "text", text: item.text ?? "" }] },
      };
    }

    if (item.type === "web_search") {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "WebSearch",
            input: { query: item.query ?? "" },
          }],
        },
      };
    }
  }

  // item.started -- emit in-progress command execution for live feedback
  if (type === "item.started" && raw.item) {
    const item = raw.item;
    if (item.type === "command_execution" && item.status === "in_progress") {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Bash",
            input: { command: item.command ?? "" },
          }],
        },
      };
    }
  }

  if (type === "turn.completed") {
    const usage = raw.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    // Rough cost estimate based on GPT-4o pricing ($2.50/1M input, $10/1M output)
    const estimatedCost = (inputTokens * 2.5 + outputTokens * 10) / 1_000_000;

    return {
      type: "result",
      subtype: "success",
      session_id: raw.thread_id,
      total_cost_usd: estimatedCost,
      duration_ms: raw.duration_ms ?? 0,
      stats: usage,
    };
  }

  if (type === "error") {
    // Map to result with error subtype so stream-processor throws AgentError
    return {
      type: "result",
      subtype: "error",
      error_message: raw.message ?? raw.error ?? "Unknown codex error",
    };
  }

  return null;
}
