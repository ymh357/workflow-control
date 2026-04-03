import type { Context } from "hono";

export const ErrorCode = {
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_STATE: "INVALID_STATE",
  INVALID_PATH: "INVALID_PATH",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  INVALID_CONFIG: "INVALID_CONFIG",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  QUESTION_NOT_FOUND: "QUESTION_NOT_FOUND",
  QUESTION_STALE: "QUESTION_STALE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export function errorResponse(
  c: Context, status: number, code: ErrorCodeValue, message: string, details?: string[],
) {
  return c.json({ error: message, code, ...(details ? { details } : {}) }, status as any);
}
