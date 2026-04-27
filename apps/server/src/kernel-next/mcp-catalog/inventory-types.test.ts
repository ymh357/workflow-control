import { describe, it, expect } from "vitest";
import {
  InventoryStatusSchema,
  InventoryRowSchema,
  INVENTORY_DIAGNOSTIC_CODES,
  type InventoryStatus,
  type InventoryRow,
  type InventoryDiagnosticCode,
} from "./inventory-types.js";
import { DiagnosticSchema } from "../ir/schema.js";

describe("inventory-types", () => {
  it("InventoryStatusSchema accepts the four canonical states", () => {
    for (const s of ["not-equipped", "pending-secret", "equipped", "unhealthy"] as const) {
      expect(InventoryStatusSchema.parse(s)).toBe(s);
    }
  });

  it("InventoryStatusSchema rejects unknown states", () => {
    expect(() => InventoryStatusSchema.parse("verifying")).toThrow();
    expect(() => InventoryStatusSchema.parse("")).toThrow();
  });

  it("InventoryRowSchema accepts a minimal equipped row", () => {
    const row: InventoryRow = {
      entryId: "etherscan",
      status: "equipped",
      lastStatusChangeAt: 1700000000000,
    };
    expect(InventoryRowSchema.parse(row)).toEqual(row);
  });

  it("InventoryRowSchema accepts unhealthy row with reason", () => {
    const row: InventoryRow = {
      entryId: "etherscan",
      status: "unhealthy",
      lastStatusChangeAt: 1700000000000,
      lastUnhealthyAt: 1700000000000,
      lastUnhealthyReason: "package-not-found",
    };
    expect(InventoryRowSchema.parse(row)).toEqual(row);
  });

  it("INVENTORY_DIAGNOSTIC_CODES are all subsets of the global Diagnostic enum", () => {
    for (const code of INVENTORY_DIAGNOSTIC_CODES) {
      expect(() =>
        DiagnosticSchema.parse({ code, message: "x" }),
      ).not.toThrow();
    }
  });
});
