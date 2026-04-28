// Unit tests for the builtin script module registry. These cover the
// contract the executor relies on (module returns Record<string, unknown>,
// throws on precondition failure). Each test constructs a minimal fake
// ScriptModuleContext since the modules don't need a real runtime.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SCRIPT_MODULES, BUILTIN_SCRIPT_IDS } from "./index.js";
import type { ScriptModuleContext } from "../runtime/script-module-resolver.js";

function ctx(env: Record<string, string> = {}): ScriptModuleContext {
  return {
    taskId: "t",
    stageName: "s",
    attemptId: "a",
    attemptIdx: 0,
    moduleId: "m",
    env,
  };
}

describe("BUILTIN_SCRIPT_IDS registry", () => {
  it("exposes every key of BUILTIN_SCRIPT_MODULES", () => {
    expect([...BUILTIN_SCRIPT_IDS].sort()).toEqual(
      Object.keys(BUILTIN_SCRIPT_MODULES).sort(),
    );
  });
  it("includes the core I/O atoms", () => {
    for (const id of [
      "http_fetch", "http_request",
      "read_file", "write_file",
      "path_expand", "path_join",
      "json_parse", "json_stringify",
      "env_resolve",
    ]) {
      expect(BUILTIN_SCRIPT_IDS.has(id)).toBe(true);
    }
  });
});

describe("path_expand", () => {
  it("expands leading ~ to homedir", async () => {
    const out = await BUILTIN_SCRIPT_MODULES.path_expand!.run({ path: "~/foo" }, ctx());
    expect(out.path).toBe(join(homedir(), "foo"));
  });
  it("handles bare ~", async () => {
    const out = await BUILTIN_SCRIPT_MODULES.path_expand!.run({ path: "~" }, ctx());
    expect(out.path).toBe(homedir());
  });
  it("leaves absolute paths alone modulo resolve()", async () => {
    const out = await BUILTIN_SCRIPT_MODULES.path_expand!.run({ path: "/tmp/x" }, ctx());
    expect(out.path).toBe("/tmp/x");
  });
});

describe("path_join", () => {
  it("joins string segments", async () => {
    const out = await BUILTIN_SCRIPT_MODULES.path_join!.run(
      { segments: ["a", "b", "c.txt"] }, ctx(),
    );
    expect(out.path).toBe("a/b/c.txt");
  });
  it("rejects non-array segments", async () => {
    await expect(
      BUILTIN_SCRIPT_MODULES.path_join!.run({ segments: "a/b" }, ctx()),
    ).rejects.toThrow(/segments/);
  });
});

describe("json_parse / json_stringify", () => {
  it("round-trips an object", async () => {
    const obj = { a: 1, b: [2, 3], c: { nested: true } };
    const s = await BUILTIN_SCRIPT_MODULES.json_stringify!.run({ value: obj }, ctx());
    const p = await BUILTIN_SCRIPT_MODULES.json_parse!.run({ raw: s.raw as string }, ctx());
    expect(p.value).toEqual(obj);
  });
  it("respects indent", async () => {
    const s = await BUILTIN_SCRIPT_MODULES.json_stringify!.run(
      { value: { a: 1 }, indent: 2 }, ctx(),
    );
    expect(s.raw).toBe('{\n  "a": 1\n}');
  });
  it("rejects undefined value", async () => {
    await expect(
      BUILTIN_SCRIPT_MODULES.json_stringify!.run({}, ctx()),
    ).rejects.toThrow(/value/);
  });
});

describe("env_resolve", () => {
  it("returns a value present in ctx.env", async () => {
    const out = await BUILTIN_SCRIPT_MODULES.env_resolve!.run(
      { key: "TOKEN" }, ctx({ TOKEN: "abc" }),
    );
    expect(out.value).toBe("abc");
    expect(out.present).toBe(true);
  });
  it("falls back to default when absent", async () => {
    const out = await BUILTIN_SCRIPT_MODULES.env_resolve!.run(
      { key: "MISSING", default: "fallback" }, ctx(),
    );
    expect(out.value).toBe("fallback");
    expect(out.present).toBe(false);
  });
  it("throws when absent and no default", async () => {
    await expect(
      BUILTIN_SCRIPT_MODULES.env_resolve!.run({ key: "MISSING" }, ctx()),
    ).rejects.toThrow(/MISSING/);
  });
});

describe("read_file / write_file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "builtin-script-test-"));
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("write_file creates the parent dir and returns the absolute path", async () => {
    const target = join(tmp, "nested", "dir", "hello.txt");
    const out = await BUILTIN_SCRIPT_MODULES.write_file!.run(
      { path: target, content: "hi" }, ctx(),
    );
    expect(out.absolutePath).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("hi");
  });

  it("read_file returns written content", async () => {
    const target = join(tmp, "roundtrip.txt");
    await BUILTIN_SCRIPT_MODULES.write_file!.run(
      { path: target, content: "round" }, ctx(),
    );
    const out = await BUILTIN_SCRIPT_MODULES.read_file!.run({ path: target }, ctx());
    expect(out.content).toBe("round");
  });

  it("read_file throws ENOENT-style when file missing", async () => {
    await expect(
      BUILTIN_SCRIPT_MODULES.read_file!.run({ path: join(tmp, "nope.txt") }, ctx()),
    ).rejects.toThrow();
  });
});

describe("http_fetch / http_request placeholder expansion", () => {
  // We don't hit the network in unit tests; instead we stub global fetch
  // for the duration of these tests and inspect the URL / headers the
  // module passed down.
  const origFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = origFetch; });

  it("http_fetch substitutes ${VAR} in url and headers from ctx.env", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return new Response("body", { status: 200, headers: { "x-foo": "bar" } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const out = await BUILTIN_SCRIPT_MODULES.http_fetch!.run(
      {
        url: "https://api.example.com/${PATH}",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      ctx({ PATH: "v1/items", TOKEN: "sekret" }),
    );

    expect(capturedUrl).toBe("https://api.example.com/v1/items");
    expect(capturedHeaders?.Authorization).toBe("Bearer sekret");
    expect(out.status).toBe(200);
    expect(out.ok).toBe(true);
    expect(out.body).toBe("body");
    expect((out.headers as Record<string, string>)["x-foo"]).toBe("bar");
  });

  it("http_request JSON-stringifies object body and sets content-type", async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      capturedBody = init?.body;
      capturedHeaders = init?.headers;
      return new Response("{}", { status: 201 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    await BUILTIN_SCRIPT_MODULES.http_request!.run(
      {
        url: "https://example.com/post",
        method: "POST",
        body: { a: 1 },
      },
      ctx(),
    );

    expect(capturedBody).toBe('{"a":1}');
    expect(capturedHeaders?.["content-type"]).toBe("application/json");
  });

  it("http_request leaves string body untouched", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      capturedBody = init?.body;
      return new Response("", { status: 200 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    await BUILTIN_SCRIPT_MODULES.http_request!.run(
      { url: "https://example.com/put", method: "PUT", body: "raw-text" },
      ctx(),
    );

    expect(capturedBody).toBe("raw-text");
  });
});

describe("validate_patch_vs_intent (Bug 8b kernel guard)", () => {
  const mod = BUILTIN_SCRIPT_MODULES.validate_patch_vs_intent!;

  it("FAILS when intent non-empty AND ops empty AND verdict safe", async () => {
    await expect(
      mod.run(
        {
          gapAnalysis: {
            intendedChanges: [
              { stage: "x", kind: "modify", description: "change y" },
            ],
          },
          patch: { ops: [] },
          dryRunVerdict: "safe",
        },
        ctx(),
      ),
    ).rejects.toThrow(/Bug 8b guard:/);
  });

  it("PASSES when intent empty AND ops empty AND verdict safe (legitimate no-op)", async () => {
    const out = await mod.run(
      {
        gapAnalysis: { intendedChanges: [] },
        patch: { ops: [] },
        dryRunVerdict: "safe",
      },
      ctx(),
    );
    expect(out).toEqual({ patch: { ops: [] }, dryRunVerdict: "safe" });
  });

  it("PASSES when ops non-empty regardless of intent (real patch)", async () => {
    const patch = {
      ops: [{ op: "update_stage_config", stage: "x", configPatch: { promptRef: "y" } }],
    };
    const out = await mod.run(
      {
        gapAnalysis: { intendedChanges: [{ stage: "x", kind: "modify" }] },
        patch,
        dryRunVerdict: "safe",
      },
      ctx(),
    );
    expect(out.patch).toBe(patch);
    expect(out.dryRunVerdict).toBe("safe");
  });

  it("PASSES when verdict 'unsafe' even with empty ops + non-empty intent (agent surfaced failure)", async () => {
    const out = await mod.run(
      {
        gapAnalysis: { intendedChanges: [{ stage: "x", kind: "modify" }] },
        patch: { ops: [] },
        dryRunVerdict: "unsafe",
      },
      ctx(),
    );
    expect(out.dryRunVerdict).toBe("unsafe");
  });

  it("PASSES when verdict 'structural' even with empty ops + non-empty intent", async () => {
    const out = await mod.run(
      {
        gapAnalysis: { intendedChanges: [{ stage: "x", kind: "modify" }] },
        patch: { ops: [] },
        dryRunVerdict: "structural",
      },
      ctx(),
    );
    expect(out.dryRunVerdict).toBe("structural");
  });

  it("PASSES when gapAnalysis is malformed object missing intendedChanges (treat as no-intent)", async () => {
    const out = await mod.run(
      { gapAnalysis: {}, patch: { ops: [] }, dryRunVerdict: "safe" },
      ctx(),
    );
    expect(out.dryRunVerdict).toBe("safe");
  });

  it("THROWS when patch.ops is missing or non-array (input contract)", async () => {
    await expect(
      mod.run(
        { gapAnalysis: { intendedChanges: [] }, patch: { ops: "nope" }, dryRunVerdict: "safe" },
        ctx(),
      ),
    ).rejects.toThrow(/patch\.ops must be an array/);
    await expect(
      mod.run(
        { gapAnalysis: { intendedChanges: [] }, patch: {}, dryRunVerdict: "safe" },
        ctx(),
      ),
    ).rejects.toThrow(/patch\.ops must be an array/);
  });

  it("THROWS when dryRunVerdict is not a string", async () => {
    await expect(
      mod.run(
        { gapAnalysis: { intendedChanges: [] }, patch: { ops: [] }, dryRunVerdict: null },
        ctx(),
      ),
    ).rejects.toThrow(/dryRunVerdict must be a string/);
  });
});
