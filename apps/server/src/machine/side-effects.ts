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

interface EmittingActor {
  on: <T extends WorkflowEmittedEvent["type"]>(
    type: T,
    handler: (event: Extract<WorkflowEmittedEvent, { type: T }>) => void,
  ) => { unsubscribe(): void };
}

export function registerSideEffects(actor: EmittingActor): void {
  actor.on("wf.status", (event: Extract<WorkflowEmittedEvent, { type: "wf.status" }>) => {
    sseManager.pushMessage(event.taskId, {
      type: "status",
      taskId: event.taskId,
      timestamp: new Date().toISOString(),
      data: { status: event.status, message: event.message },
    });
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
  });

  actor.on("wf.streamClose", (event: Extract<WorkflowEmittedEvent, { type: "wf.streamClose" }>) => {
    sseManager.closeStream(event.taskId);
    notifyTaskTerminated(event.taskId, "completed or error");
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
  });

  actor.on("wf.cancelQuestions", (event: Extract<WorkflowEmittedEvent, { type: "wf.cancelQuestions" }>) => {
    questionManager.cancelForTask(event.taskId);
  });

  actor.on("wf.worktreeCleanup", (event: Extract<WorkflowEmittedEvent, { type: "wf.worktreeCleanup" }>) => {
    if (!event.worktreePath) return;
    import("node:child_process").then(({ execFile }) => {
      execFile("git", ["worktree", "remove", "--force", event.worktreePath], { timeout: 30_000 }, (err) => {
        if (err) taskLogger(event.taskId).warn({ err, worktreePath: event.worktreePath }, "worktree cleanup failed");
      });
    }).catch((err) => { taskLogger(event.taskId).warn({ err }, "worktree cleanup: failed to import child_process"); });
  });
}
