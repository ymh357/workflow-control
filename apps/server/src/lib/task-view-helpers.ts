import type { WorkflowContext } from "../machine/types.js";

export function deriveCurrentStage(ctx: { status: string; lastStage?: string }): string {
  if (["blocked", "cancelled", "completed", "error"].includes(ctx.status)) {
    return ctx.lastStage ?? ctx.status;
  }
  return ctx.status;
}

export function deriveUpdatedAt(
  ctx: { updatedAt?: string },
  pendingQuestion?: { createdAt: string } | undefined,
): string {
  return pendingQuestion?.createdAt ?? ctx.updatedAt ?? new Date().toISOString();
}

export function isConfigEditable(status: string): boolean {
  return ["idle", "blocked", "cancelled", "completed", "error"].includes(status);
}
