// B 可行性实验 —— SDK message stream 建模探测 (2026-04-19).
//
// Runs 2 synthetic agent stages (one simple 1-port output, one 3-port
// output) through the real Claude Agent SDK, dumping EVERY message in
// the stream to disk as JSONL so we can analyse whether agent-level
// XState modelling is feasible.
//
// Not a test, not part of the product. Delete after the feasibility
// report is finalised.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options as SdkOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { createKernelMcp } from "../mcp/server.js";
import { versionHash } from "../ir/canonical.js";
import { PortRuntime, type EventDispatcher } from "../runtime/port-runtime.js";
import type { PipelineIR, StageIR } from "../ir/schema.js";

const OUT_DIR = "/tmp/sdk-probe";
const MODEL = "claude-haiku-4-5";

// Minimal inert dispatcher — we don't care about PORT_WRITTEN events
// during the probe; we only care about what the SDK emits.
const INERT_DISPATCHER: EventDispatcher = { send: () => { /* noop */ } };

function buildChildEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") inherited[k] = v;
  }
  inherited.CLAUDECODE = "";
  inherited.CI = "true";
  return inherited;
}

function findBinPath(name: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", name);
    if (existsSync(cand)) return cand;
    dir = dirname(dir);
  }
  return undefined;
}

// Build a system prompt that demands exactly N write_port calls.
function buildSystemPrompt(stage: StageIR, taskId: string, attemptId: string): string {
  const outputList = stage.outputs.map((p) => `  - ${p.name}: ${p.type}`).join("\n");
  const examples = stage.outputs
    .map((p) => {
      const ex = p.type === "number" ? "42" : p.type === "string" ? "\"example\"" : "\"...\"";
      return `  write_port(taskId="${taskId}", attemptId="${attemptId}", stage="${stage.name}", port="${p.name}", value=${ex})`;
    })
    .join("\n");

  return [
    `You are running stage '${stage.name}' — probe mode.`,
    "",
    "### Output ports (you MUST write every one):",
    outputList,
    "",
    "### Identity",
    `  taskId    = "${taskId}"`,
    `  attemptId = "${attemptId}"`,
    `  stage     = "${stage.name}"`,
    "",
    "### Required tool calls:",
    examples,
    "",
    "Use only the mcp__kernel_next__write_port tool. Do not return a",
    "final JSON object in text — only tool calls count. After every",
    "port is written, end your turn with a one-sentence confirmation.",
  ].join("\n");
}

interface Scenario {
  id: string;
  description: string;
  stage: StageIR;
  userPrompt: string;
  maxTurns: number;
}

function buildScenarios(): Scenario[] {
  // Scenario A: simplest — 1 write_port call.
  const stageA: StageIR = {
    name: "simple",
    type: "agent",
    inputs: [],
    outputs: [{ name: "x", type: "number" }],
    config: { promptRef: "Pick a number between 1 and 100." },
  };

  // Scenario B: 3 write_port calls — observe whether they batch in one
  // assistant message or come in sequence.
  const stageB: StageIR = {
    name: "multi",
    type: "agent",
    inputs: [],
    outputs: [
      { name: "title", type: "string" },
      { name: "score", type: "number" },
      { name: "summary", type: "string" },
    ],
    config: {
      promptRef:
        "Produce a random book recommendation with a title, a score 0-10, " +
        "and a one-sentence summary.",
    },
  };

  return [
    {
      id: "A-simple",
      description: "Single port write (numeric). Baseline turn/tool dynamics.",
      stage: stageA,
      userPrompt: "Pick a number between 1 and 100 inclusive.",
      maxTurns: 10,
    },
    {
      id: "B-multi",
      description: "Three port writes (mixed types). Batch vs sequential.",
      stage: stageB,
      userPrompt:
        "Recommend a book. Use write_port three times — once for title, " +
        "score, summary.",
      maxTurns: 15,
    },
  ];
}

/**
 * Build a one-stage IR that makes the scenario's stage valid for the
 * kernel (write_port handler validates against the pipeline version).
 */
function buildProbeIR(stage: StageIR): PipelineIR {
  return {
    name: `probe-${stage.name}-${Date.now()}`,
    stages: [stage],
    wires: [],
  };
}

interface StreamRecord {
  index: number;
  receivedAt: number;
  msType: string;
  msSubtype?: string | null;
  /** Full JSON-stringified SDK message (for later offline analysis). */
  raw: unknown;
}

async function runScenario(
  scenario: Scenario,
  runIdx: number,
  tscPath: string | undefined,
  claudePath: string | undefined,
): Promise<{ scenarioId: string; runIdx: number; dumpPath: string; messageCount: number; resultSubtype: string | null; numTurns: number; durationMs: number }> {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);

  try {
    const ir = buildProbeIR(scenario.stage);
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // Manually open a stage_attempt (so write_port validates). We don't
    // go through PortRuntime.startAttempt because we want the caller
    // (this probe) to own the attemptId.
    const portRuntime = new PortRuntime(db, INERT_DISPATCHER);
    const taskId = `probe-${scenario.id}-run${runIdx}`;
    const { attemptId } = portRuntime.startAttempt({
      taskId,
      versionHash: hash,
      stageName: scenario.stage.name,
    });

    const systemPromptAppend = buildSystemPrompt(scenario.stage, taskId, attemptId);

    const dumpPath = join(OUT_DIR, `${scenario.id}-run${runIdx}.jsonl`);
    // Truncate file if exists.
    writeFileSync(dumpPath, "");

    const options: SdkOptions = {
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend },
      mcpServers: {
        __kernel_next__: createKernelMcp(db, {
          // Probe observes end-to-end SDK behaviour against the full
          // tool surface; explicit 'combined' after the default flip to
          // 'external' (Debt #2 retire) so the agent's tool-discovery
          // behaviour is unchanged by this refactor.
          surface: "combined",
          tscPath,
          writePortDispatcher: INERT_DISPATCHER,
        }) as NonNullable<SdkOptions["mcpServers"]>[string],
      },
      model: MODEL,
      maxTurns: scenario.maxTurns,
      maxBudgetUsd: 0.2,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      disallowedTools: ["ToolSearch", "mcp__claude_ai_*"],
      pathToClaudeCodeExecutable: claudePath,
      env: buildChildEnv(),
    };

    const startMs = Date.now();
    const stream = query({ prompt: scenario.userPrompt, options });

    let index = 0;
    let resultSubtype: string | null = null;
    let numTurns = 0;

    for await (const message of stream as AsyncIterable<SDKMessage>) {
      const m = message as Record<string, unknown>;
      const record: StreamRecord = {
        index,
        receivedAt: Date.now(),
        msType: typeof m.type === "string" ? m.type : "<unknown>",
        msSubtype: typeof m.subtype === "string" ? m.subtype : null,
        raw: m,
      };
      appendFileSync(dumpPath, JSON.stringify(record) + "\n");
      index++;
      if (m.type === "result") {
        resultSubtype = typeof m.subtype === "string" ? m.subtype : null;
        numTurns = typeof m.num_turns === "number" ? m.num_turns : 0;
      }
    }

    const durationMs = Date.now() - startMs;

    // Finalise the attempt row so the DB doesn't look like it crashed
    // mid-run (makes debugging easier if we inspect).
    portRuntime.finishAttempt(attemptId, "success");

    return {
      scenarioId: scenario.id,
      runIdx,
      dumpPath,
      messageCount: index,
      resultSubtype,
      numTurns,
      durationMs,
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  if (!process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      "ANTHROPIC_API_KEY not set; falling back to local Claude CLI auth.",
    );
  }
  const tscPath = findBinPath("tsc");
  const claudePath = findBinPath("claude");

  const scenarios = buildScenarios();
  const results: Array<Awaited<ReturnType<typeof runScenario>>> = [];

  for (const scenario of scenarios) {
    for (let i = 1; i <= 2; i++) {
      // eslint-disable-next-line no-console
      console.log(`\n--- scenario ${scenario.id}, run ${i} ---`);
      try {
        const r = await runScenario(scenario, i, tscPath, claudePath);
        results.push(r);
        // eslint-disable-next-line no-console
        console.log(
          `  messages=${r.messageCount} result=${r.resultSubtype} turns=${r.numTurns} dur=${r.durationMs}ms dump=${r.dumpPath}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`  FAILED: ${msg}`);
      }
    }
  }

  const summary = {
    model: MODEL,
    scenarios: scenarios.map((s) => ({ id: s.id, description: s.description })),
    runs: results,
  };
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  // eslint-disable-next-line no-console
  console.log(`\nsummary written to ${join(OUT_DIR, "summary.json")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("sdk-probe failed:", err);
    process.exit(1);
  });
}
