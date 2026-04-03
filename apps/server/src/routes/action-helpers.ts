import type { Context } from "hono";
import type { ActionResult, ActionErrorCode } from "../actions/task-actions.js";
import { errorResponse, ErrorCode, type ErrorCodeValue } from "../lib/error-response.js";

const codeMap: Record<ActionErrorCode, { status: number; code: ErrorCodeValue }> = {
  TASK_NOT_FOUND: { status: 404, code: ErrorCode.TASK_NOT_FOUND },
  INVALID_STATE: { status: 400, code: ErrorCode.INVALID_STATE },
  VALIDATION_FAILED: { status: 400, code: ErrorCode.VALIDATION_FAILED },
  INTERNAL_ERROR: { status: 500, code: ErrorCode.INTERNAL_ERROR },
  QUESTION_NOT_FOUND: { status: 404, code: ErrorCode.QUESTION_NOT_FOUND },
  QUESTION_STALE: { status: 409, code: ErrorCode.QUESTION_STALE },
};

export function actionToResponse(c: Context, result: ActionResult<unknown>): Response {
  if (result.ok) {
    return c.json({ ok: true, ...result.data as Record<string, unknown> }) as unknown as Response;
  }
  const mapped = codeMap[result.code];
  return errorResponse(c, mapped.status, mapped.code, result.message) as unknown as Response;
}
