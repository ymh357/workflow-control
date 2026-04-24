// REST route for per-attempt worktree diff (P6.4 / D27).
//
// GET /api/kernel/attempts/:attemptId/diff
//
// Reads from stage_checkpoints where attempt_id matches. Returns
// { ok: true, diff, before_sha, after_sha, status } on success or
// { ok: false, diagnostics } with HTTP 404 when no checkpoint exists.
//
// diff is "" (empty string) when diff_text is NULL. The `status` field
// lets the UI distinguish "no changes" (status=captured) from "still
// capturing" / "checkpoint disabled" / "not a repo" / "diff too large"
// — previously all 6 status values returned empty diff with no hint.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelDiffRoute = new Hono();

kernelDiffRoute.get("/kernel/attempts/:attemptId/diff", (c) => {
  const attemptId = c.req.param("attemptId");
  const row = getKernelNextDb()
    .prepare(
      "SELECT before_sha, after_sha, diff_text, status FROM stage_checkpoints WHERE attempt_id = ?",
    )
    .get(attemptId) as
    | { before_sha: string | null; after_sha: string | null; diff_text: string | null; status: string }
    | undefined;

  if (!row) {
    return c.json(
      {
        ok: false,
        diagnostics: [
          {
            code: "CHECKPOINT_NOT_FOUND",
            message: `No checkpoint for attempt ${attemptId}`,
          },
        ],
      },
      404,
    );
  }

  return c.json({
    ok: true,
    diff: row.diff_text ?? "",
    before_sha: row.before_sha,
    after_sha: row.after_sha,
    status: row.status,
  });
});
