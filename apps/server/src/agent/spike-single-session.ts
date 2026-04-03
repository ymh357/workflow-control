// @ts-nocheck — experimental spike, runtime types differ from SDK declarations
/**
 * Spike: Single Session Architecture Validation
 *
 * Tests:
 * 1. Can we use AsyncIterable<SDKUserMessage> as prompt?
 * 2. Does the for-await loop continue after a "result" message?
 * 3. Can we push a second stage instruction and get a second result?
 * 4. Is session_id the same across both results?
 * 5. Can we call setMcpServers() between stages?
 *
 * Run: cd apps/server && npx tsx src/agent/spike-single-session.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

// Simple message queue -> AsyncIterable adapter
function createMessageQueue() {
  const queue: unknown[] = [];
  let waiting: ((val: IteratorResult<unknown>) => void) | null = null;

  function push(text: string) {
    const msg = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: "",
    };
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: msg, done: false });
    } else {
      queue.push(msg);
    }
  }

  function end() {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          return new Promise((resolve) => { waiting = resolve; });
        },
      };
    },
  };

  return { push, end, iterable };
}

async function main() {
  const claudePath = process.env.CLAUDE_PATH ?? "claude";
  const { push, end, iterable } = createMessageQueue();

  // Stage 1: simple task (no MCP needed)
  push("Stage 1: What is 2+2? Answer with just the number.");

  console.log("[spike] Starting single-session test...\n");

  const q = query({
    prompt: iterable as any,
    options: {
      systemPrompt: "You are a test assistant. Be extremely brief. Answer in one line.",
      pathToClaudeCodeExecutable: claudePath,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      thinking: { type: "disabled" },
      allowedTools: [],
      maxTurns: 5,
      maxBudgetUsd: 0.5,
      env: { ...process.env, CLAUDECODE: "" },
    },
  });

  let stageCount = 0;
  let sessionId1: string | undefined;
  let sessionId2: string | undefined;

  for await (const message of q) {
    const type = message.type;

    if (type === "assistant") {
      const text = message.message?.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (text) console.log(`[spike] assistant: ${text.slice(0, 100)}`);
    }

    if (type === "result") {
      stageCount++;
      const sid = message.session_id;
      const sub = message.subtype;
      console.log(`\n[spike] === Stage ${stageCount} result ===`);
      console.log(`[spike]   subtype: ${sub}`);
      console.log(`[spike]   session_id: ${sid}`);
      console.log(`[spike]   cost: $${message.total_cost_usd?.toFixed(4)}`);

      if (stageCount === 1) {
        sessionId1 = sid;

        // Test: can we call setMcpServers between stages?
        console.log("\n[spike] Attempting setMcpServers({}) between stages...");
        try {
          await q.setMcpServers({});
          console.log("[spike] setMcpServers: SUCCESS");
        } catch (err) {
          console.log(`[spike] setMcpServers: FAILED — ${err}`);
        }

        // Test: can we call setModel between stages?
        console.log("[spike] Attempting setModel('claude-sonnet-4-6') between stages...");
        try {
          await q.setModel("claude-sonnet-4-6");
          console.log("[spike] setModel: SUCCESS");
        } catch (err) {
          console.log(`[spike] setModel: FAILED — ${err}`);
        }

        // Push stage 2
        console.log("[spike] Pushing Stage 2 message...\n");
        push("Stage 2: What is 3+3? Answer with just the number.");
      }

      if (stageCount === 2) {
        sessionId2 = sid;
        end(); // signal iterable is done
        break;
      }
    }
  }

  console.log("\n[spike] ========== RESULTS ==========");
  console.log(`[spike] Stages completed: ${stageCount}`);
  console.log(`[spike] Session 1: ${sessionId1}`);
  console.log(`[spike] Session 2: ${sessionId2}`);

  if (stageCount < 2) {
    console.log("[spike] FAIL: Loop ended after stage 1. AsyncIterable multi-turn not working.");
  } else if (sessionId1 === sessionId2) {
    console.log("[spike] SUCCESS: Same session_id across both stages. Single session works!");
  } else {
    console.log("[spike] PARTIAL: Both stages ran but session_id differs. Context may not carry over.");
  }
}

main().catch((err) => {
  console.error("[spike] Fatal error:", err);
  process.exit(1);
});
