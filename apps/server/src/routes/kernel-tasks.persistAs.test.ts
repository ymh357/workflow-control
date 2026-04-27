// Sanity test mirroring the production schema. If this drifts,
// kernel-persistAs.test.ts catches the actual integration regression.
import { describe, it, expect } from "vitest";
import { z } from "zod";

const sample = z.object({
  secrets: z.record(z.string().min(1), z.string().min(1)),
  persistAs: z.record(
    z.string().min(1),
    z.object({ entryId: z.string().min(1) }).strict(),
  ).optional(),
}).strict();

describe("kernel-tasks /secrets persistAs schema sanity", () => {
  it("accepts secrets only", () => {
    expect(sample.safeParse({ secrets: { K: "v" } }).success).toBe(true);
  });
  it("accepts secrets + persistAs", () => {
    expect(sample.safeParse({
      secrets: { K: "v" },
      persistAs: { K: { entryId: "etherscan" } },
    }).success).toBe(true);
  });
  it("rejects extra top-level field", () => {
    expect(sample.safeParse({ secrets: { K: "v" }, foo: 1 }).success).toBe(false);
  });
});
