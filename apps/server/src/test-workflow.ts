/**
 * Workflow E2E smoke test.
 *
 * Usage:
 *   1. Start server:  pnpm --filter server dev
 *   2. Run test:      npx tsx apps/server/src/test-workflow.ts [taskText] [repoName]
 *
 * The script auto-confirms at each awaiting stage.
 */

const API = "http://localhost:3001/api";
const DEFAULT_TASK_TEXT = "Test task: verify workflow pipeline execution";
const DEFAULT_REPO_NAME = "workflow-control-test-target";

const taskText = process.argv[2] ?? DEFAULT_TASK_TEXT;
const repoName = process.argv[3] ?? DEFAULT_REPO_NAME;

const AWAITING_STATES = [
  "awaitingTicketConfirm",
  "awaitingDesignConfirm",
  "awaitingSpecConfirm",
  "awaitingDeployConfirm",
];

const TERMINAL_STATES = ["completed", "error", "blocked"];

let taskId = "";
let currentStatus = "";
let sseConnected = false;

// --- Helpers ---

function log(tag: string, ...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}]`, ...args);
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    log("API", `${method} ${path} => ${res.status}`, json);
    throw new Error(`API error: ${res.status}`);
  }
  return json;
}

async function pollStatus(): Promise<string> {
  const data = await api("GET", `/tasks/${taskId}`);
  return data.status;
}

// --- Step 1: Create task ---

async function createTask() {
  log("TEST", `Creating task: "${taskText}", repo: ${repoName}`);
  const data = await api("POST", "/tasks", { taskText, repoName });
  taskId = data.taskId;
  log("TEST", `Task created: ${taskId}`);
}

// --- Step 2: Connect SSE and stream events ---

function connectSSE(): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${API}/stream/${taskId}`, {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        log("SSE", "Failed to connect");
        return;
      }

      sseConnected = true;
      log("SSE", "Connected");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            handleSSE(msg);
          } catch { /* skip */ }
        }
      }

      log("SSE", "Disconnected");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      log("SSE", "Error:", err);
    }
  })();

  return controller;
}

function handleSSE(msg: { type: string; data: Record<string, unknown> }) {
  switch (msg.type) {
    case "status": {
      const newStatus = String(msg.data.status);
      if (newStatus !== currentStatus) {
        currentStatus = newStatus;
        log("STATUS", `${newStatus}${msg.data.message ? ` — ${msg.data.message}` : ""}`);
      }
      break;
    }
    case "stage_change":
      log("STAGE", String(msg.data.stage));
      break;
    case "agent_text":
      log("AGENT", String(msg.data.text).slice(0, 120));
      break;
    case "agent_tool_use":
      log("TOOL", String(msg.data.toolName));
      break;
    case "result":
      log("RESULT", JSON.stringify(msg.data).slice(0, 200));
      break;
    case "question":
      log("QUESTION", String(msg.data.question));
      // Auto-answer: pick first option or reply "proceed"
      autoAnswer(String(msg.data.questionId), msg.data.options as string[] | undefined);
      break;
    case "error":
      log("ERROR", String(msg.data.error));
      break;
  }
}

async function autoAnswer(questionId: string, options?: string[]) {
  const answer = options?.[0] ?? "Proceed with your best judgment.";
  log("AUTO-ANSWER", `questionId=${questionId.slice(0, 8)} answer="${answer}"`);
  await api("POST", `/tasks/${taskId}/answer`, { questionId, answer });
}

// --- Step 3: Poll and auto-confirm ---

async function waitForCompletion(timeoutMs = 30 * 60 * 1000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));

    const status = await pollStatus();

    if (status !== currentStatus) {
      currentStatus = status;
      log("POLL", `Status: ${status}`);
    }

    // Auto-confirm at awaiting states
    if (AWAITING_STATES.includes(status)) {
      log("AUTO-CONFIRM", `Confirming at ${status}...`);
      await new Promise((r) => setTimeout(r, 2000)); // brief pause to let SSE catch up
      await api("POST", `/tasks/${taskId}/confirm`);
      log("AUTO-CONFIRM", "Confirmed");
    }

    // Auto-retry at blocked state (max 1 retry)
    if (status === "blocked") {
      log("AUTO-RETRY", "Task blocked, retrying...");
      await api("POST", `/tasks/${taskId}/retry`);
    }

    // Done
    if (TERMINAL_STATES.includes(status)) {
      return status;
    }
  }

  return "timeout";
}

// --- Main ---

async function main() {
  console.log("=".repeat(60));
  log("TEST", "workflow-control E2E smoke test");
  console.log("=".repeat(60));

  // Check server health
  try {
    await api("GET", "/../health");
    log("TEST", "Server is running");
  } catch {
    console.error("Server not running at http://localhost:3001. Start it first:");
    console.error("  pnpm --filter server dev");
    process.exit(1);
  }

  await createTask();

  const sseController = connectSSE();

  const finalStatus = await waitForCompletion();

  sseController.abort();

  console.log("\n" + "=".repeat(60));
  log("TEST", `Final status: ${finalStatus}`);

  // Print final task state
  try {
    const task = await api("GET", `/tasks/${taskId}`);
    log("TEST", "Final task state:");
    console.log(JSON.stringify({
      status: task.status,
      sessionId: task.sessionId?.slice(0, 12) + "...",
      branch: task.branch,
      worktreePath: task.worktreePath,
      notionPageId: task.notionPageId,
      prUrl: task.prUrl,
      error: task.error,
    }, null, 2));
  } catch {
    log("TEST", "(Task already cleaned up from registry)");
  }

  console.log("=".repeat(60));

  if (finalStatus === "completed") {
    log("TEST", "PASS");
    process.exit(0);
  } else {
    log("TEST", `FAIL — ended with: ${finalStatus}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
