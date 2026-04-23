// REST route for per-attempt worktree diff (P6.4 / D27).
//
// GET /api/kernel/attempts/:attemptId/diff
//
// Reads from stage_checkpoints where attempt_id matches. Returns
// { ok: true, diff, before_sha, after_sha } on success or
// { ok: false, diagnostics } with HTTP 404 when no checkpoint exists.
//
// diff is "" (empty string) when the checkpoint row has diff_text = NULL
// (e.g. stage made no file changes).

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelDiffRoute = new Hono();

kernelDiffRoute.get("/kernel/attempts/:attemptId/diff", (c) => {
  const attemptId = c.req.param("attemptId");
  const row = getKernelNextDb()
    .prepare(
      "SELECT before_sha, after_sha, diff_text FROM stage_checkpoints WHERE attempt_id = ?",
    )
    .get(attemptId) as
    | { before_sha: string | null; after_sha: string | null; diff_text: string | null }
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
  });
});
