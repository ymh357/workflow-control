import type { DatabaseSync } from "node:sqlite";
import { keyFileExists as defaultKeyFileExists } from "./crypto.js";

const ENV_OVERRIDE = "WORKFLOW_CONTROL_SECRET_KEY";

export type KeyRecoveryResult =
  | {
      recovered: false;
      reason: "env-override-active" | "key-file-present" | "no-secrets-stored" | "no-equipped-rows" | "no-tables";
      affectedRows: 0;
    }
  | {
      recovered: true;
      affectedRows: number;
    };

export type KeyRecoveryOptions = {
  /** Test injection. Production: omit and let the default `crypto.keyFileExists` decide. */
  keyFileExists?: () => boolean;
};

/**
 * Detect the "key file lost but inventory non-empty" state at server startup
 * and pre-emptively mark every equipped inventory row `unhealthy` with reason
 * `encryption-key-lost` BEFORE crypto.ts auto-generates a fresh key. After
 * this, the user's first task that needs a secret won't run with the wrong
 * key — the inventory page already shows the rows as unhealthy and prompts a
 * re-equip.
 *
 * MUST be called BEFORE any crypto.encryptValue / decryptValue / loadKey
 * call, because loadKey will silently auto-create a new file if missing.
 *
 * Idempotent: a second invocation with the same DB state is a no-op (no rows
 * are still equipped).
 *
 * Never throws — a recovery failure should not crash the server. Tests
 * verify graceful behavior when tables don't exist.
 */
export function runSecretKeyRecovery(
  db: DatabaseSync,
  opts: KeyRecoveryOptions = {},
): KeyRecoveryResult {
  try {
    if (process.env[ENV_OVERRIDE] && process.env[ENV_OVERRIDE]!.length > 0) {
      return { recovered: false, reason: "env-override-active", affectedRows: 0 };
    }
    const keyExists = (opts.keyFileExists ?? defaultKeyFileExists)();
    if (keyExists) {
      return { recovered: false, reason: "key-file-present", affectedRows: 0 };
    }

    // Need to inspect inventory. Schema may not be initialized in pathological
    // cases (e.g. fresh DB before initInventorySchema has run). Treat that as
    // "nothing to recover".
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name IN ('mcp_inventory','mcp_inventory_secrets')`,
      )
      .all() as { name: string }[];
    if (tables.length < 2) {
      return { recovered: false, reason: "no-tables", affectedRows: 0 };
    }

    const secretCountRow = db.prepare(`SELECT COUNT(*) AS c FROM mcp_inventory_secrets`).get() as {
      c: number;
    };
    if (secretCountRow.c === 0) {
      return { recovered: false, reason: "no-secrets-stored", affectedRows: 0 };
    }

    // Bulk-mark every row that is currently equipped (or pending-secret) as
    // unhealthy. Rows that are already unhealthy or not-equipped stay as-is.
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE mcp_inventory
            SET status                = 'unhealthy',
                last_status_change_at = ?,
                last_unhealthy_at     = ?,
                last_unhealthy_reason = 'encryption-key-lost'
          WHERE status IN ('equipped','pending-secret')`,
      )
      .run(now, now);

    const affected = Number(result.changes ?? 0);
    if (affected === 0) {
      return { recovered: false, reason: "no-equipped-rows", affectedRows: 0 };
    }
    return { recovered: true, affectedRows: affected };
  } catch {
    // Never crash startup. The catch is intentionally empty — any failure
    // here is recovered by the regular Phase 2 decrypt-fails-loud path
    // when an actual task tries to use a secret.
    return { recovered: false, reason: "no-tables", affectedRows: 0 };
  }
}
