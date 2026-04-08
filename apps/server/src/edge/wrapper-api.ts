import { Hono } from "hono";
import { getTaskSlots, getAllSlots, addSlotListener, addTaskTerminationListener } from "./registry.js";
import { getTaskContext } from "../actions/task-actions.js";
import { getAllWorkflows, getWorkflow } from "../machine/actor-registry.js";
import { flattenStages } from "../lib/config-loader.js";
import { TERMINAL_STATES } from "../machine/types.js";
import { questionManager } from "../lib/question-manager.js";
import { sseManager } from "../sse/manager.js";
import type { SSEMessage } from "../types/index.js";
import { taskLogger } from "../lib/logger.js";

export function buildWrapperRoute(): Hono {
  const route = new Hono();

  // Authentication middleware: verify X-Edge-Token against the task's taskToken
  route.use("/:taskId/*", async (c, next) => {
    const taskId = c.req.param("taskId");
    const actor = getWorkflow(taskId);
    if (!actor) {
      return c.json({ error: "Task not found" }, 404);
    }
    const expectedToken = actor.getSnapshot()?.context?.taskToken;
    if (expectedToken) {
      const token = c.req.header("X-Edge-Token");
      if (token !== expectedToken) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });

  // GET /api/edge/:taskId/next-stage
  // Returns the next edge stage to execute, or waiting/done status.
  route.get("/:taskId/next-stage", (c) => {
    const taskId = c.req.param("taskId");
    const ctx = getTaskContext(taskId);

    if (!ctx) {
      return c.json({ error: `Task ${taskId} not found` }, 404);
    }

    // Check terminal states
    if (TERMINAL_STATES.has(ctx.status)) {
      return c.json({ done: true, status: ctx.status });
    }

    // Check for pending edge slots (own task + child sub-pipeline tasks)
    const ownSlots = getTaskSlots(taskId);
    const childSlots = getAllSlots().filter(
      (s) => s.taskId !== taskId && s.taskId.startsWith(taskId),
    );
    const slots = ownSlots.length > 0 ? ownSlots : childSlots;
    if (slots.length > 0) {
      const slot = slots[0];
      // Resolve stage config from the correct task's pipeline (parent or child)
      const slotCtx = slot.taskId === taskId ? ctx : getTaskContext(slot.taskId);
      const slotStages = slotCtx?.config?.pipeline?.stages ? flattenStages(slotCtx.config.pipeline.stages) : [];
      const stageConfig = slotStages.find((s) => s.name === slot.stageName);
      const isGate = stageConfig?.type === "human_confirm";
      return c.json({
        // Use child taskId so edge runner submits result to the correct task
        taskId: slot.taskId,
        stageName: slot.stageName,
        isGate,
        cwd: (slotCtx?.stageCwds as Record<string, string> | undefined)?.[slot.stageName] ?? ctx.worktreePath,
        ...(stageConfig && !isGate ? {
          stageOptions: {
            engine: stageConfig.engine,
            model: stageConfig.model,
            effort: stageConfig.effort,
            permission_mode: stageConfig.permission_mode,
            debug: stageConfig.debug,
            max_turns: stageConfig.max_turns,
            max_budget_usd: stageConfig.max_budget_usd,
            disallowed_tools: stageConfig.runtime && "disallowed_tools" in stageConfig.runtime
              ? (stageConfig.runtime as { disallowed_tools?: string[] }).disallowed_tools
              : undefined,
            agents: stageConfig.runtime && "agents" in stageConfig.runtime
              ? (stageConfig.runtime as { agents?: Record<string, unknown> }).agents
              : undefined,
            mcps: stageConfig.mcps,
          },
        } : {}),
      });
    }

    // Check if current status is a human_confirm stage (gate waiting for user)
    const stages = ctx.config?.pipeline?.stages ? flattenStages(ctx.config.pipeline.stages) : [];
    const currentStage = stages.find((s) => s.name === ctx.status);
    if (currentStage?.type === "human_confirm") {
      return c.json({ waiting: true, status: ctx.status, isGate: true });
    }

    // Check for pending questions
    const pq = questionManager.getPersistedPending(taskId);
    if (pq) {
      return c.json({
        waiting: true,
        status: ctx.status,
        pendingQuestion: { questionId: pq.questionId, question: pq.question, options: pq.options },
      });
    }

    // Server-side stage is running, wait
    return c.json({ waiting: true, status: ctx.status });
  });

  // GET /api/edge/:taskId/check-interrupt
  route.get("/:taskId/check-interrupt", (c) => {
    const taskId = c.req.param("taskId");
    const ctx = getTaskContext(taskId);

    if (!ctx) {
      return c.json({ interrupted: true, reason: "Task not found" });
    }

    const interrupted = ["cancelled", "blocked", "completed", "error"].includes(ctx.status);
    return c.json({
      interrupted,
      reason: interrupted ? (ctx.error ?? ctx.status) : undefined,
    });
  });

  // GET /api/edge/_active-pipeline
  // Returns the first non-terminal task, or { isTerminal: true } if none.
  // Used by the stop hook to detect if any pipeline is still running.
  // Prefixed with _ to avoid collision with /:taskId param routes.
  route.get("/_active-pipeline", (c) => {
    for (const [taskId, actor] of getAllWorkflows()) {
      const snapshot = actor.getSnapshot();
      const ctx = snapshot.context;
      if (!TERMINAL_STATES.has(ctx.status)) {
        const stages = ctx.config?.pipeline?.stages ? flattenStages(ctx.config.pipeline.stages) : [];
        const completedStages = Object.keys(ctx.stageTokenUsages ?? {}).length;
        return c.json({
          isTerminal: false,
          taskId,
          status: ctx.status,
          progress: `${completedStages}/${stages.length}`,
          pipelineName: ctx.config?.pipelineName ?? "unknown",
        });
      }
    }
    return c.json({ isTerminal: true });
  });

  // POST /api/edge/:taskId/stream-event
  // Receives transcript events from the runner and forwards to SSE.
  route.post("/:taskId/stream-event", async (c) => {
    const taskId = c.req.param("taskId");

    let events: Array<{ type: string; data: Record<string, unknown> }>;
    try {
      const body = await c.req.json();
      if (body == null || typeof body !== "object") {
        return c.json({ error: "Expected JSON object or array" }, 400);
      }
      events = Array.isArray(body) ? body : [body];
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const VALID_EVENT_TYPES = new Set(["text", "tool_use", "thinking"]);

    let forwarded = 0;
    for (const event of events) {
      if (!VALID_EVENT_TYPES.has(event.type)) continue;

      const sseType = event.type === "text" ? "agent_text"
        : event.type === "tool_use" ? "agent_tool_use"
        : "agent_thinking";

      sseManager.pushMessage(taskId, {
        type: sseType as SSEMessage["type"],
        taskId,
        timestamp: new Date().toISOString(),
        data: event.data as SSEMessage["data"],
      });
      forwarded++;
    }

    taskLogger(taskId).debug({ count: forwarded }, "Stream events received from runner");
    return c.json({ ok: true, received: forwarded });
  });

  // GET /api/edge/:taskId/events
  // SSE stream for edge runner — pushes slot_created, status_changed, task_terminated events.
  // Replaces polling of /next-stage for stage-ready and gate detection.
  // Note: question_answered is NOT observable here (questionManager resolves internally without emitting wf.status).
  route.get("/:taskId/events", (c) => {
    const taskId = c.req.param("taskId");
    const ctx = getTaskContext(taskId);
    if (!ctx) {
      return c.json({ error: `Task ${taskId} not found` }, 404);
    }

    const encoder = new TextEncoder();

    let cleanup: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch { /* stream closed */ }
        };

        // Slot created — new stage is ready for execution
        const removeSlotListener = addSlotListener((info) => {
          if (info.taskId !== taskId) return;
          send("slot_created", { stageName: info.stageName, nonce: info.nonce });
        });

        // Task terminated — completed, blocked, or cancelled
        const removeTerminationListener = addTaskTerminationListener(taskId, (_, reason) => {
          send("task_terminated", { reason });
          cleanup?.();
        });

        // Status changes (gate resolved, question answered, stage transitions)
        const removeSseListener = sseManager.addListener(taskId, (msg: SSEMessage) => {
          if (msg.type === "status") {
            send("status_changed", msg.data as Record<string, unknown>);
          }
        });

        // Heartbeat to keep connection alive
        const heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
          catch { cleanup?.(); }
        }, 15_000);

        cleanup = () => {
          removeSlotListener();
          removeTerminationListener();
          removeSseListener();
          clearInterval(heartbeat);
          try { controller.close(); } catch { /* already closed */ }
        };

        // Check for already-pending slots (in case one was created before the SSE connected)
        const existing = getTaskSlots(taskId);
        if (existing.length > 0) {
          send("slot_created", { stageName: existing[0].stageName, nonce: existing[0].nonce });
        }
      },
      cancel() {
        cleanup?.();
      },
    });

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");
    return c.body(stream);
  });

  return route;
}
