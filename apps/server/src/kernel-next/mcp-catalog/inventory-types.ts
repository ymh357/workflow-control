import { z } from "zod";
import type { Diagnostic as _GlobalDiagnostic } from "../ir/schema.js";

export const InventoryStatusSchema = z.enum([
  "not-equipped",
  "pending-secret",
  "equipped",
  "unhealthy",
]);

export type InventoryStatus = z.infer<typeof InventoryStatusSchema>;

export const InventoryRowSchema = z.object({
  entryId: z.string().min(1),
  status: InventoryStatusSchema,
  lastStatusChangeAt: z.number().int().positive(),
  lastUnhealthyAt: z.number().int().positive().optional(),
  lastUnhealthyReason: z.string().optional(),
}).strict();

export type InventoryRow = z.infer<typeof InventoryRowSchema>;

// Per-envKey readout shape returned by GET /inventory and friends.
// `hasValue` is the only externally-visible bit — the value itself
// never leaves the server process.
export const InventorySecretReadoutSchema = z.object({
  envKey: z.string().min(1),
  hasValue: z.boolean(),
  lastUpdatedAt: z.number().int().positive().optional(),
}).strict();

export type InventorySecretReadout = z.infer<typeof InventorySecretReadoutSchema>;

export const INVENTORY_DIAGNOSTIC_CODES = [
  "MCP_PROVISION_ENVKEY_MISSING",
  "MCP_PROVISION_PACKAGE_NOT_FOUND",
  "MCP_PROVISION_HEALTHCHECK_TIMEOUT",
  "MCP_INVENTORY_DECRYPT_FAILED",
] as const;

export type InventoryDiagnosticCode = (typeof INVENTORY_DIAGNOSTIC_CODES)[number];

// Compile-time guard: every inventory code must be in the global enum.
type _AssertInventoryCodesAreGlobal = InventoryDiagnosticCode extends _GlobalDiagnostic["code"]
  ? true
  : "ERROR: An inventory code is not in the global Diagnostic.code enum";
const _inventoryCodesCheck: _AssertInventoryCodesAreGlobal = true;
void _inventoryCodesCheck;
