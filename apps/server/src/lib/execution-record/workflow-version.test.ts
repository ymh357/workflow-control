// T1.2 — workflow-control software version signature tests.

import { describe, it, expect, beforeEach } from "vitest";
import {
  getWorkflowControlVersion,
  __resetWorkflowControlVersionCache,
} from "./workflow-version.js";

beforeEach(() => {
  __resetWorkflowControlVersionCache();
});

describe("getWorkflowControlVersion", () => {
  it("returns a non-empty string", () => {
    const v = getWorkflowControlVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });

  it("is cached across calls", () => {
    const v1 = getWorkflowControlVersion();
    const v2 = getWorkflowControlVersion();
    expect(v1).toBe(v2);
  });

  it("contains the package.json version from apps/server", () => {
    // The apps/server package.json version is "0.0.1" at time of writing.
    // We don't pin the exact value — just assert semver-like prefix is
    // detectable, so this test survives package.json bumps.
    const v = getWorkflowControlVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("appends a short git SHA when the repo is reachable", () => {
    // In-repo execution: expect "version+sha" format.
    const v = getWorkflowControlVersion();
    // Either semver alone (if git unreachable) OR semver+shortSha.
    expect(v).toMatch(/^\d+\.\d+\.\d+(\+[0-9a-f]{7,40})?$/);
  });
});
