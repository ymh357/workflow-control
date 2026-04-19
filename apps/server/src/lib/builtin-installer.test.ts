import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBuiltinPipelines } from "./builtin-installer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "builtin-installer-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverBuiltinPipelines", () => {
  it("returns [] when source dir missing", () => {
    expect(discoverBuiltinPipelines(join(root, "nope"))).toEqual([]);
  });

  it("returns [] when source dir exists but empty", () => {
    expect(discoverBuiltinPipelines(root)).toEqual([]);
  });

  it("picks up directories that contain pipeline.yaml", () => {
    mkdirSync(join(root, "alpha"), { recursive: true });
    writeFileSync(join(root, "alpha", "pipeline.yaml"), "name: alpha\n");
    mkdirSync(join(root, "beta"), { recursive: true });
    writeFileSync(join(root, "beta", "pipeline.yaml"), "name: beta\n");
    expect(discoverBuiltinPipelines(root)).toEqual(["alpha", "beta"]);
  });

  it("skips directories without pipeline.yaml", () => {
    mkdirSync(join(root, "empty"), { recursive: true });
    mkdirSync(join(root, "ok"), { recursive: true });
    writeFileSync(join(root, "ok", "pipeline.yaml"), "name: ok\n");
    expect(discoverBuiltinPipelines(root)).toEqual(["ok"]);
  });

  it("skips loose files at the top level", () => {
    writeFileSync(join(root, "loose.yaml"), "not a pipeline\n");
    mkdirSync(join(root, "ok"), { recursive: true });
    writeFileSync(join(root, "ok", "pipeline.yaml"), "name: ok\n");
    expect(discoverBuiltinPipelines(root)).toEqual(["ok"]);
  });

  it("returns names sorted alphabetically for deterministic install order", () => {
    for (const n of ["zebra", "apple", "mango"]) {
      mkdirSync(join(root, n), { recursive: true });
      writeFileSync(join(root, n, "pipeline.yaml"), `name: ${n}\n`);
    }
    expect(discoverBuiltinPipelines(root)).toEqual(["apple", "mango", "zebra"]);
  });
});
