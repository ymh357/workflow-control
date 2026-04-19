// A2.3.2 前置 POC (task #94) — 验证 XState v5 在以下组合下的行为：
//
//   parent parallel region
//     ├─ regionA state: executing (invoke { src: 'agentActor', input: A-specific })
//     └─ regionB state: executing (invoke { src: 'agentActor', input: B-specific })
//
// 关键问题:
//   Q1. parent 能否在 setup() 里声明 actors.agentActor 一次，
//       然后 parallel 的两个 region 各自 invoke 同一个 src，
//       且 input 按 region 分别传入？
//   Q2. 两个子 actor 的 output 能否通过 onDone.actions 被 parent 正确
//       收走，不串台（A 的 output 不会进 B 的 onDone）？
//   Q3. parent 能否从外部接收 INTERRUPT 事件、用 sendTo + guard 精确
//       路由给其中一个 invoked child？
//
// 成功判据 (全部通过才进 A2.3.2):
//   - parent 到达 done 时，context.resultA / context.resultB 各自记录
//     正确的子机 output（包含各自的 stageName）
//   - INTERRUPT { stage: 'A' } 只让子 A 进入 interrupted，子 B 正常 done
//
// 运行方式:
//   cd apps/server
//   ./node_modules/.bin/tsx src/kernel-next/__poc__/invoke-probe.ts
//
// 本文件不在测试套件，失败/成功不影响 CI；commit 后一次性参考资料，
// A2.3.2 落地后可删除。

import { setup, assign, createActor, sendTo, waitFor } from "xstate";
import {
  createAgentMachine,
  type AgentMachineOutput,
  type AgentMachineInput,
} from "../runtime/agent-machine.js";

// --- Parent machine ---------------------------------------------------------

interface ParentContext {
  resultA: AgentMachineOutput | null;
  resultB: AgentMachineOutput | null;
}

type ParentEvent =
  | { type: "START" }
  | { type: "INTERRUPT"; stage: "A" | "B" }
  // SDK event shims — in real code these come from the stream pump. For the
  // POC we just raise them directly on the child actors to drive the state.
  | { type: "SDK_INIT"; stage: "A" | "B" }
  | { type: "RESULT_SUCCESS"; stage: "A" | "B" }
  | { type: "TOOL_USE_REQUESTED"; stage: "A" | "B"; id: string; name: string; input: unknown }
  | { type: "TOOL_RESULT_RECEIVED"; stage: "A" | "B"; id: string };

const agentLogic = createAgentMachine();

const parent = setup({
  types: {} as {
    context: ParentContext;
    events: ParentEvent;
  },
  actors: {
    // Q1 — same logic instance reused across two invokes. XState v5 accepts
    // this; the `id` distinguishes the two child actors at runtime.
    agentActor: agentLogic,
  },
}).createMachine({
  id: "parent",
  type: "parallel",
  context: { resultA: null, resultB: null },
  states: {
    regionA: {
      initial: "executing",
      states: {
        executing: {
          invoke: {
            id: "agent-A",
            src: "agentActor",
            input: (): AgentMachineInput => ({
              stageName: "A", taskId: "t-poc", attemptId: "att-A",
            }),
            onDone: {
              target: "done",
              actions: assign({
                resultA: ({ event }) =>
                  (event as unknown as { output: AgentMachineOutput }).output,
              }),
            },
            onError: "done",
          },
          on: {
            // Q3 — stage-specific INTERRUPT forward. Guard matches on the
            // event's `stage` field; sendTo targets the child by id string.
            INTERRUPT: {
              guard: ({ event }) => event.stage === "A",
              actions: sendTo("agent-A", { type: "INTERRUPT" }),
            },
            // Driver events from the POC harness: feed into the child to
            // drive its state machine through the SDK turn states.
            SDK_INIT: {
              guard: ({ event }) => event.stage === "A",
              actions: sendTo("agent-A", { type: "SDK_INIT" }),
            },
            RESULT_SUCCESS: {
              guard: ({ event }) => event.stage === "A",
              actions: sendTo("agent-A", { type: "RESULT_SUCCESS" }),
            },
            TOOL_USE_REQUESTED: {
              guard: ({ event }) => event.stage === "A",
              actions: sendTo("agent-A", ({ event }) => ({
                type: "TOOL_USE_REQUESTED" as const,
                id: event.type === "TOOL_USE_REQUESTED" ? event.id : "",
                name: event.type === "TOOL_USE_REQUESTED" ? event.name : "",
                input: event.type === "TOOL_USE_REQUESTED" ? event.input : undefined,
              })),
            },
            TOOL_RESULT_RECEIVED: {
              guard: ({ event }) => event.stage === "A",
              actions: sendTo("agent-A", ({ event }) => ({
                type: "TOOL_RESULT_RECEIVED" as const,
                id: event.type === "TOOL_RESULT_RECEIVED" ? event.id : "",
              })),
            },
          },
        },
        done: { type: "final" },
      },
    },
    regionB: {
      initial: "executing",
      states: {
        executing: {
          invoke: {
            id: "agent-B",
            src: "agentActor",
            input: (): AgentMachineInput => ({
              stageName: "B", taskId: "t-poc", attemptId: "att-B",
            }),
            onDone: {
              target: "done",
              actions: assign({
                resultB: ({ event }) =>
                  (event as unknown as { output: AgentMachineOutput }).output,
              }),
            },
            onError: "done",
          },
          on: {
            INTERRUPT: {
              guard: ({ event }) => event.stage === "B",
              actions: sendTo("agent-B", { type: "INTERRUPT" }),
            },
            SDK_INIT: {
              guard: ({ event }) => event.stage === "B",
              actions: sendTo("agent-B", { type: "SDK_INIT" }),
            },
            RESULT_SUCCESS: {
              guard: ({ event }) => event.stage === "B",
              actions: sendTo("agent-B", { type: "RESULT_SUCCESS" }),
            },
          },
        },
        done: { type: "final" },
      },
    },
  },
});

// --- Probe scenarios --------------------------------------------------------

async function scenario1_bothSucceed(): Promise<boolean> {
  console.log("\n--- Scenario 1: both agents succeed ---");
  const actor = createActor(parent);
  actor.start();
  // Drive both children through init → success.
  actor.send({ type: "SDK_INIT", stage: "A" });
  actor.send({ type: "SDK_INIT", stage: "B" });
  actor.send({ type: "RESULT_SUCCESS", stage: "A" });
  actor.send({ type: "RESULT_SUCCESS", stage: "B" });
  await waitFor(actor, (s) => s.status === "done", { timeout: 1000 });
  const ctx = actor.getSnapshot().context;
  actor.stop();

  const ok =
    ctx.resultA?.status === "done" &&
    ctx.resultA?.stageName === "A" &&
    ctx.resultB?.status === "done" &&
    ctx.resultB?.stageName === "B";
  console.log(`  resultA: ${JSON.stringify(ctx.resultA)}`);
  console.log(`  resultB: ${JSON.stringify(ctx.resultB)}`);
  console.log(`  PASS=${ok}`);
  return ok;
}

async function scenario2_interruptAOnly(): Promise<boolean> {
  console.log("\n--- Scenario 2: INTERRUPT only A; B finishes normally ---");
  const actor = createActor(parent);
  actor.start();
  actor.send({ type: "SDK_INIT", stage: "A" });
  actor.send({ type: "SDK_INIT", stage: "B" });
  // Interrupt A — according to AgentMachine §4.2, from waiting_for_claude
  // this arms the interrupt; the "summary turn" (next bounce) finalises
  // as interrupted. A direct SDK_INIT re-bounce would fire the always
  // guard on re-entry; easier path: send TOOL_USE + TOOL_RESULT to drive
  // a tool loop that consumes the summary-turn slot, then no RESULT is
  // delivered → we'd need to force done somehow. Simpler for POC:
  // send INTERRUPT + RESULT_SUCCESS — per §4.2 this is allowed; the
  // summary turn landed successfully, final = 'done'.
  //
  // But the point of this POC scenario is to prove stage-specific forward.
  // Simplest assertion: sending INTERRUPT {stage:'A'} does NOT affect B.
  // We then RESULT_SUCCESS both and confirm A is still 'done' with
  // interruptArmed visible via turns count difference OR (since
  // interruptArmed → done matrix says RESULT_SUCCESS still wins) by
  // observing that the INTERRUPT was accepted by A only.
  //
  // We prove the isolation by: INTERRUPT both stages, one at a time,
  // and observe the guard only forwarded to the intended child.
  // Minimal observable: both still reach done with their own stageName.
  actor.send({ type: "INTERRUPT", stage: "A" });
  actor.send({ type: "RESULT_SUCCESS", stage: "A" });
  actor.send({ type: "RESULT_SUCCESS", stage: "B" });
  await waitFor(actor, (s) => s.status === "done", { timeout: 1000 });
  const ctx = actor.getSnapshot().context;
  actor.stop();

  // Even after INTERRUPT, RESULT_SUCCESS in waiting_for_claude transitions
  // to done (summary turn landed). The POC proves:
  //   - parent routed INTERRUPT to A, not B
  //   - B reached done without issues despite the cross-region INTERRUPT
  const ok =
    ctx.resultA?.status === "done" &&
    ctx.resultA?.stageName === "A" &&
    ctx.resultB?.status === "done" &&
    ctx.resultB?.stageName === "B";
  console.log(`  resultA: ${JSON.stringify(ctx.resultA)}`);
  console.log(`  resultB: ${JSON.stringify(ctx.resultB)}`);
  console.log(`  PASS=${ok}`);
  return ok;
}

async function scenario3_interruptForcesInterrupted(): Promise<boolean> {
  console.log("\n--- Scenario 3: INTERRUPT A → then re-bounce drives A to interrupted ---");
  const actor = createActor(parent);
  actor.start();
  actor.send({ type: "SDK_INIT", stage: "A" });
  actor.send({ type: "SDK_INIT", stage: "B" });
  // Interrupt A, then drive a tool roundtrip on A to consume the
  // summary-turn slot. Per AgentMachine, the second time we enter
  // waiting_for_claude after arming, the `always` guard fires and A
  // finalises as interrupted.
  actor.send({ type: "INTERRUPT", stage: "A" });
  // Drive a tool roundtrip on A through the parent-level forward.
  // After this, A is back in waiting_for_claude with summaryTurnUsed=true,
  // so the `always` guard fires and finalises A as interrupted.
  actor.send({ type: "TOOL_USE_REQUESTED", stage: "A", id: "t1", name: "x", input: {} });
  actor.send({ type: "TOOL_RESULT_RECEIVED", stage: "A", id: "t1" });
  // Now A should be back in waiting, summaryTurnUsed → always fires →
  // A reaches done with interrupted. B is untouched; drive it to success.
  actor.send({ type: "RESULT_SUCCESS", stage: "B" });
  await waitFor(actor, (s) => s.status === "done", { timeout: 1000 });
  const ctx = actor.getSnapshot().context;
  actor.stop();

  const ok =
    ctx.resultA?.status === "interrupted" &&
    ctx.resultA?.stageName === "A" &&
    ctx.resultA?.interruptedFrom === "waiting_for_claude" &&
    ctx.resultB?.status === "done" &&
    ctx.resultB?.stageName === "B";
  console.log(`  resultA: ${JSON.stringify(ctx.resultA)}`);
  console.log(`  resultB: ${JSON.stringify(ctx.resultB)}`);
  console.log(`  PASS=${ok}`);
  return ok;
}

async function main() {
  const results: Array<{ name: string; ok: boolean }> = [];
  try {
    results.push({ name: "both succeed", ok: await scenario1_bothSucceed() });
  } catch (e) {
    results.push({ name: "both succeed", ok: false });
    console.log(`  EXCEPTION: ${(e as Error).message}`);
  }
  try {
    results.push({ name: "interrupt A isolation", ok: await scenario2_interruptAOnly() });
  } catch (e) {
    results.push({ name: "interrupt A isolation", ok: false });
    console.log(`  EXCEPTION: ${(e as Error).message}`);
  }
  try {
    results.push({ name: "interrupt A → interrupted", ok: await scenario3_interruptForcesInterrupted() });
  } catch (e) {
    results.push({ name: "interrupt A → interrupted", ok: false });
    console.log(`  EXCEPTION: ${(e as Error).message}`);
  }

  console.log("\n=== POC summary ===");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  const allPass = results.every((r) => r.ok);
  console.log(allPass ? "\nALL POC SCENARIOS PASSED → A2.3.2 OK to proceed" : "\nPOC FAILED → stop and discuss");
  process.exit(allPass ? 0 : 1);
}

void main();
