import { describe, it, expect } from "vitest";
import {
  checkEnvKeys,
  checkPackage,
  resolvePackageName,
} from "./healthcheck.js";

describe("healthcheck/checkEnvKeys", () => {
  it("ok when all required keys are present", () => {
    const r = checkEnvKeys({
      envKeys: [
        { name: "A", required: true },
        { name: "B", required: false },
      ],
      haveValues: new Set(["A"]),
    });
    expect(r.ok).toBe(true);
  });

  it("ok when there are no required keys", () => {
    const r = checkEnvKeys({
      envKeys: [{ name: "OPT", required: false }],
      haveValues: new Set(),
    });
    expect(r.ok).toBe(true);
  });

  it("fails with MCP_PROVISION_ENVKEY_MISSING when required key absent", () => {
    const r = checkEnvKeys({
      envKeys: [
        { name: "A", required: true },
        { name: "B", required: true },
      ],
      haveValues: new Set(["A"]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.diagnostics[0].code).toBe("MCP_PROVISION_ENVKEY_MISSING");
    expect(r.diagnostics[0].context?.missing).toEqual(["B"]);
  });
});

describe("healthcheck/resolvePackageName", () => {
  it("uses explicit packageName if present", () => {
    expect(resolvePackageName({ packageName: "@scope/mcp", args: ["-y", "x"] })).toBe("@scope/mcp");
  });

  it("falls back to first non-flag arg", () => {
    expect(resolvePackageName({ args: ["-y", "@scope/mcp", "extra"] })).toBe("@scope/mcp");
  });

  it("returns null when only flags", () => {
    expect(resolvePackageName({ args: ["-y", "--silent"] })).toBeNull();
  });

  it("returns null when args empty and no packageName", () => {
    expect(resolvePackageName({ args: [] })).toBeNull();
  });
});

describe("healthcheck/checkPackage", () => {
  it("ok when exec returns code 0", async () => {
    const r = await checkPackage({
      packageName: "@scope/exists",
      timeoutMs: 1000,
      exec: async () => ({ code: 0, stdout: "1.2.3", stderr: "", timedOut: false }),
    });
    expect(r.ok).toBe(true);
  });

  it("MCP_PROVISION_PACKAGE_NOT_FOUND when exec returns non-zero", async () => {
    const r = await checkPackage({
      packageName: "@scope/missing",
      timeoutMs: 1000,
      exec: async () => ({ code: 1, stdout: "", stderr: "404 Not Found", timedOut: false }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.diagnostics[0].code).toBe("MCP_PROVISION_PACKAGE_NOT_FOUND");
    expect(r.diagnostics[0].context?.packageName).toBe("@scope/missing");
  });

  it("MCP_PROVISION_HEALTHCHECK_TIMEOUT when exec timed out", async () => {
    const r = await checkPackage({
      packageName: "@scope/slow",
      timeoutMs: 50,
      exec: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.diagnostics[0].code).toBe("MCP_PROVISION_HEALTHCHECK_TIMEOUT");
  });
});
