import type { WorkflowEmittedEvent } from "./events.js";
import { getNotionStatusLabel } from "./helpers.js";
import { sseManager } from "../sse/manager.js";
import { taskListBroadcaster } from "../sse/task-list-broadcaster.js";
import {
  notifyBlocked, notifyStageComplete, notifyCompleted, notifyCancelled, notifyGenericGate,
} from "../lib/slack.js";
import { updateNotionPageStatus } from "../lib/notion.js";
import { writeArtifact } from "../lib/artifacts.js";
import { cancelTask } from "../agent/query-tracker.js";
import { clearTaskSlots, notifyTaskTerminated } from "../edge/registry.js";
import { questionManager } from "../lib/question-manager.js";
import { safeFire } from "../lib/safe-fire.js";
import { taskLogger } from "../lib/logger.js";
import { emitWorkflowEvent, clearEventCounter } from "./event-emitter.js";
import path, { join } from "node:path";
import { loadSystemSettings } from "../lib/config-loader.js";

interface EmittingActor {
  on: <T extends WorkflowEmittedEvent["type"]>(
    type: T,
    handler: (event: Extract<WorkflowEmittedEvent, { type: T }>) => void,
  ) => { unsubscribe(): void };
}

// Serialize pipeline-index updates so concurrent task completions don't
// clobber each other's entries. Read-modify-write without a lock would drop
// updates whenever two tasks complete within the same microtask window.
let indexWriteChain: Promise<void> = Promise.resolve();

async function updatePipelineIndexSerialized(taskId: string, pipelineName: string): Promise<void> {
  try {
    const settings = loadSystemSettings();
    const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
    const indexPath = join(dataDir, "tasks", "_pipeline_index.json");
    const { readFile, writeFile, rename, mkdir } = await import("node:fs/promises");
    await mkdir(join(dataDir, "tasks"), { recursive: true });
    let index: Record<string, { taskId: string; completedAt: string }> = {};
    try {
      const raw = await readFile(indexPath, "utf-8");
      index = JSON.parse(raw);
    } catch { /* no index yet — fine */ }
    index[pipelineName] = { taskId, completedAt: new Date().toISOString() };
    const tmp = `${indexPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, JSON.stringify(index, null, 2));
    await rename(tmp, indexPath);
  } catch { /* non-blocking */ }
}

function updatePipelineIndex(taskId: string, pipelineName: string): void {
  // Chain onto the previous write so reads see completed writes; chain
  // keeps propagating even if one task fails (swallow inside serialized).
  indexWriteChain = indexWriteChain.then(() => updatePipelineIndexSerialized(taskId, pipelineName));
}

const registeredActors = new WeakSet<object>();

export function registerSideEffects(actor: EmittingActor): void {
  if (registeredActors.has(actor)) return;
  registeredActors.add(actor);
  actor.on("wf.status", (event: Extract<WorkflowEmittedEvent, { type: "wf.status" }>) => {
    sseManager.pushMessage(event.taskId, {
      type: "status",
      taskId: event.taskId,
      timestamp: new Date().toISOString(),
      data: { status: event.status, message: event.message },
    });
    if (event.status === "completed") {
      emitWorkflowEvent(event.taskId, "stage_completed", event.status);
    } else if (event.status === "error") {
      emitWorkflowEvent(event.taskId, "stage_failed", event.status, event.message ? { message: event.message } : undefined);
    } else {
      emitWorkflowEvent(event.taskId, "stage_started", event.status);
    }
  });

  actor.on("wf.error", (event: Extract<WorkflowEmittedEvent, { type: "wf.error" }>) => {
    sseManager.pushMessage(event.taskId, {
      type: "error",
      taskId: event.taskId,
      timestamp: new Date().toISOString(),
      data: { error: event.error },
    });
  });

  actor.on("wf.costUpdate", (event: Extract<WorkflowEmittedEvent, { type: "wf.costUpdate" }>) => {
    sseManager.pushMessage(event.taskId, {
      type: "cost_update",
      taskId: event.taskId,
      timestamp: new Date().toISOString(),
      data: { totalCostUsd: event.totalCostUsd, stageCostUsd: event.stageCostUsd, stageTokenUsage: event.stageTokenUsage },
    });
    emitWorkflowEvent(event.taskId, "cost_update", undefined, {
      totalCostUsd: event.totalCostUsd,
      stageCostUsd: event.stageCostUsd,
    });
  });

  actor.on("wf.streamClose", (event: Extract<WorkflowEmittedEvent, { type: "wf.streamClose" }>) => {
    sseManager.closeStream(event.taskId);
    notifyTaskTerminated(event.taskId, "completed or error");
    clearEventCounter(event.taskId);

    // Clean up per-task caches (I1, I2)
    import("../agent/semantic-summary-cache.js").then(({ clearTaskSummaries }) => {
      clearTaskSummaries(event.taskId);
    }).catch(() => {});
    import("../agent/stage-executor.js").then(({ clearAppendPromptCache }) => {
      clearAppendPromptCache(event.taskId);
    }).catch(() => {});
    import("../agent/session-manager-registry.js").then(({ closeSessionManager }) => {
      closeSessionManager(event.taskId);
    }).catch(() => {});

    // Update pipeline index for fast store inheritance (O7)
    import("./actor-registry.js").then(({ getWorkflow }) => {
      const wfActor = getWorkflow(event.taskId);
      const ctx = wfActor?.getSnapshot()?.context;
      if (ctx?.status === "completed" && ctx.config?.pipelineName) {
        updatePipelineIndex(event.taskId, ctx.config.pipelineName);
      }
    }).catch(() => { /* non-blocking */ });
  });

  actor.on("wf.notionSync", (event: Extract<WorkflowEmittedEvent, { type: "wf.notionSync" }>) => {
    if (!event.notionPageId) return;
    const label = getNotionStatusLabel(event.status, event.pipelineStages);
    safeFire(
      updateNotionPageStatus(event.taskId, event.notionPageId, label),
      event.taskId,
      "Failed to update Notion status",
    );
  });

  actor.on("wf.slackBlocked", (event: Extract<WorkflowEmittedEvent, { type: "wf.slackBlocked" }>) => {
    safeFire(notifyBlocked(event.taskId, event.stage, event.error), event.taskId, "notifyBlocked failed");
    notifyTaskTerminated(event.taskId, "blocked");
    emitWorkflowEvent(event.taskId, "stage_failed", event.stage, { error: event.error });
  });

  actor.on("wf.slackStageComplete", (event: Extract<WorkflowEmittedEvent, { type: "wf.slackStageComplete" }>) => {
    safeFire(
      notifyStageComplete(event.taskId, event.title, event.templateName),
      event.taskId,
      "notifyStageComplete failed",
    );
  });

  actor.on("wf.slackCompleted", (event: Extract<WorkflowEmittedEvent, { type: "wf.slackCompleted" }>) => {
    safeFire(notifyCompleted(event.taskId, event.deliverable), event.taskId, "notifyCompleted failed");
  });

  actor.on("wf.slackCancelled", (event: Extract<WorkflowEmittedEvent, { type: "wf.slackCancelled" }>) => {
    safeFire(notifyCancelled(event.taskId), event.taskId, "notifyCancelled failed");
  });

  actor.on("wf.slackGate", (event: Extract<WorkflowEmittedEvent, { type: "wf.slackGate" }>) => {
    safeFire(notifyGenericGate(event.taskId, event.stageName, event.template), event.taskId, "notifyGenericGate failed");
  });

  actor.on("wf.taskListUpdate", (event: Extract<WorkflowEmittedEvent, { type: "wf.taskListUpdate" }>) => {
    taskListBroadcaster.broadcastTaskUpdate(event.taskId);
  });

  actor.on("wf.persistSession", (event: Extract<WorkflowEmittedEvent, { type: "wf.persistSession" }>) => {
    if (!event.worktreePath || !event.sessionId) return;
    safeFire(
      writeArtifact(event.worktreePath, "session.json", JSON.stringify({ sessionId: event.sessionId, updatedAt: new Date().toISOString() })),
      "system",
      "Failed to persist session.json",
    );
  });

  actor.on("wf.cancelAgent", (event: Extract<WorkflowEmittedEvent, { type: "wf.cancelAgent" }>) => {
    cancelTask(event.taskId);
    clearTaskSlots(event.taskId);
    notifyTaskTerminated(event.taskId, "cancelled");
    emitWorkflowEvent(event.taskId, "task_cancelled");
    import("../agent/session-manager-registry.js").then(({ closeSessionManager }) => {
      closeSessionManager(event.taskId);
    }).catch(() => {});
  });

  actor.on("wf.cancelQuestions", (event: Extract<WorkflowEmittedEvent, { type: "wf.cancelQuestions" }>) => {
    questionManager.cancelForTask(event.taskId);
  });

  actor.on("wf.worktreeCleanup", (event: Extract<WorkflowEmittedEvent, { type: "wf.worktreeCleanup" }>) => {
    if (!event.worktreePath || !path.isAbsolute(event.worktreePath) || event.worktreePath.includes("..")) return;
    import("node:child_process").then(({ execFile }) => {
      execFile("git", ["worktree", "remove", "--force", "--", event.worktreePath], { timeout: 30_000 }, (err) => {
        if (err) taskLogger(event.taskId).warn({ err, worktreePath: event.worktreePath }, "worktree cleanup failed");
      });
    }).catch((err) => { taskLogger(event.taskId).warn({ err }, "worktree cleanup: failed to import child_process"); });
  });
}
