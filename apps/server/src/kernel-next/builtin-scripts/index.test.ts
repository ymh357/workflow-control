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
  it("includes every key of BUILTIN_SCRIPT_MODULES plus factory script ids", () => {
    // Factory ids (e.g. submit_pipeline_passthrough) live outside
    // BUILTIN_SCRIPT_MODULES because they're bound to per-task state at
    // runtime; the registry SET still exposes them for validator lookups.
    for (const k of Object.keys(BUILTIN_SCRIPT_MODULES)) {
      expect(BUILTIN_SCRIPT_IDS.has(k)).toBe(true);
    }
  });
  it("includes the core I/O atoms", () => {
    for (const id of [
      "http_fetch", "http_request",
      "read_file", "write_file",
      "path_expand", "path_join",
      "json_parse", "json_stringify",
      "env_resolve",
      "classify_source_url",
      "classify_evidence_bundle",
      "noop_terminal",
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

// Bug 6 fix (c12+ review): SSRF allow-list, timeout, body cap.
describe("http_fetch / http_request guard rails (Bug 6)", () => {
  const origFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = origFetch; });

  describe("SSRF allow-list", () => {
    it.each([
      "http://127.0.0.1/",
      "http://127.0.0.1:8080/path",
      "http://localhost/",
      "https://10.0.0.5/",
      "https://192.168.1.1/",
      "https://172.16.5.5/",
      "https://172.31.0.1/",
      "http://169.254.169.254/latest/meta-data/",  // AWS metadata
      "http://metadata.google.internal/",
      "http://[::1]/",
      "http://0.0.0.0/",
    ])("rejects %s", async (url) => {
      await expect(
        BUILTIN_SCRIPT_MODULES.http_fetch!.run({ url }, ctx()),
      ).rejects.toThrow(/private \/ loopback \/ cloud-metadata range/);
    });

    it("allows public hostnames", async () => {
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response("ok", { status: 200 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
      await BUILTIN_SCRIPT_MODULES.http_fetch!.run(
        { url: "https://api.example.com/" },
        ctx(),
      );
      expect(called).toBe(true);
    });

    it("permits private IP when allowPrivate=true (single-user override)", async () => {
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response("ok", { status: 200 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
      await BUILTIN_SCRIPT_MODULES.http_fetch!.run(
        { url: "http://192.168.1.5/", allowPrivate: true },
        ctx(),
      );
      expect(called).toBe(true);
    });

    it("rejects non-http protocols", async () => {
      await expect(
        BUILTIN_SCRIPT_MODULES.http_fetch!.run(
          { url: "file:///etc/passwd" },
          ctx(),
        ),
      ).rejects.toThrow(/protocol .* not allowed/);
    });

    it("rejects malformed URLs cleanly", async () => {
      await expect(
        BUILTIN_SCRIPT_MODULES.http_fetch!.run({ url: "not-a-url" }, ctx()),
      ).rejects.toThrow(/invalid URL/);
    });
  });

  describe("timeout", () => {
    it("aborts with a clear message when fetch exceeds timeoutMs", async () => {
      globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          });
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      await expect(
        BUILTIN_SCRIPT_MODULES.http_fetch!.run(
          { url: "https://api.example.com/slow", timeoutMs: 25 },
          ctx(),
        ),
      ).rejects.toThrow(/timed out after 25ms/);
    });
  });

  describe("body cap", () => {
    it("truncates the body to maxBytes and sets truncated:true", async () => {
      const bigChunk = new Uint8Array(2 * 1024).fill(65); // 2KB of 'A'
      globalThis.fetch = (async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(bigChunk);
            controller.enqueue(bigChunk);
            controller.enqueue(bigChunk);
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const out = await BUILTIN_SCRIPT_MODULES.http_fetch!.run(
        { url: "https://api.example.com/", maxBytes: 1024 },
        ctx(),
      ) as Record<string, unknown>;
      expect(out.truncated).toBe(true);
      expect((out.body as string).length).toBeLessThanOrEqual(1024);
    });

    it("returns the full body when under cap with truncated:false", async () => {
      globalThis.fetch = (async () => {
        return new Response("small body", { status: 200 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const out = await BUILTIN_SCRIPT_MODULES.http_fetch!.run(
        { url: "https://api.example.com/" },
        ctx(),
      ) as Record<string, unknown>;
      expect(out.truncated).toBe(false);
      expect(out.body).toBe("small body");
    });
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

describe("classify_source_url", () => {
  const mod = BUILTIN_SCRIPT_MODULES.classify_source_url!;

  // ---- primary: source repos ----
  it("classifies github.com/owner/repo as primary source_repo", async () => {
    const out = await mod.run(
      { url: "https://github.com/foundry-rs/foundry/blob/master/README.md" },
      ctx(),
    );
    expect(out.type).toBe("primary");
    expect(out.signal).toBe("source_repo:github");
    expect(out.confidence).toBe(1.0);
  });
  it("does NOT classify github.com homepage as primary (path depth < 2)", async () => {
    const out = await mod.run({ url: "https://github.com/" }, ctx());
    expect(out.type).not.toBe("primary");
  });
  it("classifies gitlab project URL as primary", async () => {
    const out = await mod.run({ url: "https://gitlab.com/group/project" }, ctx());
    expect(out.type).toBe("primary");
    expect(out.signal).toBe("source_repo:gitlab");
  });

  // ---- primary: on-chain explorers ----
  it("classifies etherscan tx URL as primary onchain_explorer:evm", async () => {
    const out = await mod.run(
      { url: "https://etherscan.io/tx/0xabc123" },
      ctx(),
    );
    expect(out.type).toBe("primary");
    expect(out.signal).toBe("onchain_explorer:evm");
  });
  it("classifies etherscan address URL as primary", async () => {
    const out = await mod.run(
      { url: "https://etherscan.io/address/0xdeadbeef" },
      ctx(),
    );
    expect(out.type).toBe("primary");
  });
  it("does NOT classify etherscan homepage as primary", async () => {
    const out = await mod.run({ url: "https://etherscan.io/" }, ctx());
    expect(out.type).not.toBe("primary");
  });
  it("classifies arbiscan address URL as primary onchain_explorer:evm", async () => {
    const out = await mod.run(
      { url: "https://arbiscan.io/address/0x1" },
      ctx(),
    );
    expect(out.type).toBe("primary");
  });
  it("classifies solscan tx as primary solana explorer", async () => {
    const out = await mod.run(
      { url: "https://solscan.io/tx/abc" },
      ctx(),
    );
    expect(out.type).toBe("primary");
    expect(out.signal).toBe("onchain_explorer:solana");
  });

  // ---- primary: specs ----
  it("classifies eips.ethereum.org as primary spec:eip", async () => {
    const out = await mod.run(
      { url: "https://eips.ethereum.org/EIPS/eip-1559" },
      ctx(),
    );
    expect(out.type).toBe("primary");
    expect(out.signal).toBe("spec:eip");
  });
  it("classifies IETF rfc as primary spec:ietf_rfc", async () => {
    const out = await mod.run(
      { url: "https://datatracker.ietf.org/doc/html/rfc7519" },
      ctx(),
    );
    expect(out.type).toBe("primary");
  });
  it("classifies w3.org/TR as primary spec:w3c_tr", async () => {
    const out = await mod.run(
      { url: "https://www.w3.org/TR/webrtc/" },
      ctx(),
    );
    expect(out.type).toBe("primary");
  });

  // ---- primary: papers ----
  it("classifies arxiv abs URL as primary paper:arxiv", async () => {
    const out = await mod.run(
      { url: "https://arxiv.org/abs/2104.00031" },
      ctx(),
    );
    expect(out.type).toBe("primary");
    expect(out.signal).toBe("paper:arxiv");
  });
  it("classifies doi.org as primary paper:doi", async () => {
    const out = await mod.run(
      { url: "https://doi.org/10.1145/3477132.3483560" },
      ctx(),
    );
    expect(out.type).toBe("primary");
  });
  it("classifies usenix conference paper as primary", async () => {
    const out = await mod.run(
      { url: "https://www.usenix.org/conference/osdi23/presentation/foo" },
      ctx(),
    );
    expect(out.type).toBe("primary");
  });

  // ---- primary: package registries ----
  it("classifies npm package as primary package_registry:npm", async () => {
    const out = await mod.run(
      { url: "https://www.npmjs.com/package/zod" },
      ctx(),
    );
    expect(out.type).toBe("primary");
    expect(out.signal).toBe("package_registry:npm");
  });
  it("classifies pypi project as primary package_registry:pypi", async () => {
    const out = await mod.run(
      { url: "https://pypi.org/project/torch/" },
      ctx(),
    );
    expect(out.type).toBe("primary");
  });

  // ---- aggregator ----
  it("classifies reddit thread as aggregator", async () => {
    const out = await mod.run(
      { url: "https://www.reddit.com/r/ethereum/comments/abc" },
      ctx(),
    );
    expect(out.type).toBe("aggregator");
  });
  it("classifies hackernews as aggregator", async () => {
    const out = await mod.run(
      { url: "https://news.ycombinator.com/item?id=12345" },
      ctx(),
    );
    expect(out.type).toBe("aggregator");
  });
  it("classifies stackoverflow as aggregator", async () => {
    const out = await mod.run(
      { url: "https://stackoverflow.com/questions/123/foo" },
      ctx(),
    );
    expect(out.type).toBe("aggregator");
  });
  it("classifies zhihu as aggregator", async () => {
    const out = await mod.run(
      { url: "https://www.zhihu.com/question/12345" },
      ctx(),
    );
    expect(out.type).toBe("aggregator");
  });

  // ---- third-party publishers ----
  it("classifies medium.com as third_party regardless of subjectDomain", async () => {
    const out = await mod.run(
      { url: "https://medium.com/0g-labs/post", subjectDomain: "0g.ai" },
      ctx(),
    );
    expect(out.type).toBe("third_party");
    expect(out.signal).toBe("third_party_publisher");
  });
  it("classifies dev.to as third_party", async () => {
    const out = await mod.run({ url: "https://dev.to/foo/bar" }, ctx());
    expect(out.type).toBe("third_party");
  });
  it("classifies coindesk as third_party", async () => {
    const out = await mod.run(
      { url: "https://www.coindesk.com/article/foo" },
      ctx(),
    );
    expect(out.type).toBe("third_party");
  });

  // ---- subject-domain bump ----
  it("upgrades subject-domain host to official_secondary", async () => {
    const out = await mod.run(
      { url: "https://docs.0g.ai/about", subjectDomain: "0g.ai" },
      ctx(),
    );
    expect(out.type).toBe("official_secondary");
    expect(out.signal).toBe("subject_domain_match");
  });
  it("does NOT mark unrelated host with subject_domain_match signal", async () => {
    // docs.* heuristic may still classify as official_secondary, but the
    // SIGNAL must not be subject_domain_match — that signal is what
    // downstream filters trust at higher confidence (0.85). The generic
    // docs subdomain match falls back to confidence 0.6.
    const out = await mod.run(
      { url: "https://random-other-host.io/x", subjectDomain: "0g.ai" },
      ctx(),
    );
    expect(out.signal).not.toBe("subject_domain_match");
  });
  it("strips https:// and trailing path from subjectDomain input", async () => {
    const out = await mod.run(
      { url: "https://0g.ai/blog/post", subjectDomain: "https://0g.ai/" },
      ctx(),
    );
    expect(out.type).toBe("official_secondary");
  });

  // ---- generic blog/docs heuristics ----
  it("classifies blog.foo.com as third_party when no subject hint", async () => {
    const out = await mod.run({ url: "https://blog.example.com/post" }, ctx());
    expect(out.type).toBe("third_party");
    expect(out.signal).toBe("blog_subdomain");
  });
  it("classifies docs.foo.com as official_secondary at lower confidence", async () => {
    const out = await mod.run({ url: "https://docs.example.com/api" }, ctx());
    expect(out.type).toBe("official_secondary");
    expect(out.signal).toBe("docs_subdomain");
    expect(out.confidence).toBe(0.6);
  });

  // ---- fallback / errors ----
  it("returns unknown for an unrecognized host", async () => {
    const out = await mod.run({ url: "https://random.site/page" }, ctx());
    expect(out.type).toBe("unknown");
    expect(out.signal).toBe("no_match");
  });
  it("returns unknown with url_parse_error for a malformed URL", async () => {
    const out = await mod.run({ url: "not a url" }, ctx());
    expect(out.type).toBe("unknown");
    expect(out.signal).toBe("url_parse_error");
    expect(out.confidence).toBe(0);
  });

  // ---- batch forms ----
  it("batch via 'urls' returns one result per input with url preserved", async () => {
    const out = await mod.run(
      {
        urls: [
          "https://github.com/a/b",
          "https://medium.com/x",
          "not a url",
        ],
      },
      ctx(),
    );
    const results = out.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(3);
    expect(results[0]!.type).toBe("primary");
    expect(results[0]!.url).toBe("https://github.com/a/b");
    expect(results[1]!.type).toBe("third_party");
    expect(results[2]!.type).toBe("unknown");
  });
  it("batch via 'citations' preserves passthrough fields and adds classification", async () => {
    const out = await mod.run(
      {
        citations: [
          { url: "https://etherscan.io/tx/0x1", quote: "tx evidence" },
          { url: "https://blog.example.com/p", quote: "blog claim" },
        ],
      },
      ctx(),
    );
    const results = out.results as Array<Record<string, unknown>>;
    expect(results[0]!.type).toBe("primary");
    expect(results[0]!.quote).toBe("tx evidence");
    expect(results[1]!.type).toBe("third_party");
    expect(results[1]!.quote).toBe("blog claim");
  });
  it("batch with subjectDomain applied to every entry", async () => {
    const out = await mod.run(
      {
        urls: ["https://docs.0g.ai/x", "https://docs.example.com/y"],
        subjectDomain: "0g.ai",
      },
      ctx(),
    );
    const results = out.results as Array<Record<string, unknown>>;
    expect(results[0]!.type).toBe("official_secondary");
    expect(results[0]!.signal).toBe("subject_domain_match");
    expect(results[1]!.type).toBe("official_secondary");
    expect(results[1]!.signal).toBe("docs_subdomain");
  });
  it("THROWS when neither url, urls, nor citations is provided", async () => {
    await expect(mod.run({}, ctx())).rejects.toThrow(/provide one of/);
  });
  it("THROWS when urls[i] is not a string", async () => {
    await expect(
      mod.run({ urls: ["https://a/b/c", 42] }, ctx()),
    ).rejects.toThrow(/urls\[1\]/);
  });
  it("THROWS when citations[i].url is not a string", async () => {
    await expect(
      mod.run({ citations: [{ url: 42 }] }, ctx()),
    ).rejects.toThrow(/citations\[0\]\.url/);
  });
});

describe("classify_evidence_bundle", () => {
  const mod = BUILTIN_SCRIPT_MODULES.classify_evidence_bundle!;

  it("classifies a single hypothesis with mixed sources and computes counts", async () => {
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H1",
            verdict: "supported",
            positiveEvidence: [
              {
                kind: "source_code",
                url: "https://github.com/0g-labs/oft/blob/main/Oft.sol",
                quote: "function send(...)",
              },
              {
                kind: "tx",
                url: "https://etherscan.io/tx/0xabc",
                quote: "calldata shows compose call",
              },
              {
                kind: "blog",
                url: "https://medium.com/random/post",
                quote: "claims about latency",
              },
            ],
            negativeEvidence: [],
            rawArtifacts: ["0xabc"],
          },
        ],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    expect(ce.length).toBe(1);
    expect(ce[0]!.hypothesisId).toBe("H1");
    expect(ce[0]!.primaryCount).toBe(2);
    expect(ce[0]!.thirdPartyCount).toBe(1);
    expect(ce[0]!.officialCount).toBe(0);
    expect(ce[0]!.aggregatorCount).toBe(0);
    expect(ce[0]!.unknownCount).toBe(0);
    const pos = ce[0]!.positiveEvidence as Array<Record<string, unknown>>;
    expect(pos[0]!.type).toBe("primary");
    expect(pos[0]!.signal).toBe("source_repo:github");
    expect(pos[0]!.kind).toBe("source_code");
    expect(pos[0]!.quote).toBe("function send(...)");
    expect(pos[2]!.type).toBe("third_party");
  });

  it("treats empty url as unknown/no_url with confidence 0", async () => {
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H1",
            verdict: "supported",
            positiveEvidence: [
              { kind: "local_file", url: "", quote: "see /tmp/notes.md" },
            ],
            negativeEvidence: [],
          },
        ],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    const pos = ce[0]!.positiveEvidence as Array<Record<string, unknown>>;
    expect(pos[0]!.type).toBe("unknown");
    expect(pos[0]!.signal).toBe("no_url");
    expect(pos[0]!.confidence).toBe(0);
    expect(ce[0]!.unknownCount).toBe(1);
    expect(ce[0]!.primaryCount).toBe(0);
  });

  it("counts only positive evidence, not negative", async () => {
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H1",
            verdict: "inconclusive",
            positiveEvidence: [
              { kind: "doc", url: "https://medium.com/x/y", quote: "" },
            ],
            negativeEvidence: [
              { kind: "tried", url: "https://github.com/a/b", quote: "no match" },
            ],
          },
        ],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    expect(ce[0]!.primaryCount).toBe(0); // negative github does NOT count
    expect(ce[0]!.thirdPartyCount).toBe(1);
    const neg = ce[0]!.negativeEvidence as Array<Record<string, unknown>>;
    expect(neg[0]!.type).toBe("primary"); // still classified for transparency
  });

  it("applies subjectDomain to upgrade subject's docs subdomain to official_secondary", async () => {
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H1",
            verdict: "supported",
            positiveEvidence: [
              { kind: "docs", url: "https://docs.0g.ai/about", quote: "..." },
            ],
            negativeEvidence: [],
          },
        ],
        subjectDomain: "0g.ai",
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    const pos = ce[0]!.positiveEvidence as Array<Record<string, unknown>>;
    expect(pos[0]!.type).toBe("official_secondary");
    expect(pos[0]!.signal).toBe("subject_domain_match");
    expect(ce[0]!.officialCount).toBe(1);
  });

  it("preserves passthrough fields (verdict, rawArtifacts, hypothesisId)", async () => {
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H42",
            verdict: "refuted",
            positiveEvidence: [],
            negativeEvidence: [],
            rawArtifacts: ["abc", "def"],
          },
        ],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    expect(ce[0]!.hypothesisId).toBe("H42");
    expect(ce[0]!.verdict).toBe("refuted");
    expect(ce[0]!.rawArtifacts).toEqual(["abc", "def"]);
  });

  it("handles multiple hypotheses independently", async () => {
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H1",
            verdict: "supported",
            positiveEvidence: [
              { kind: "k", url: "https://github.com/a/b", quote: "" },
            ],
            negativeEvidence: [],
          },
          {
            hypothesisId: "H2",
            verdict: "supported",
            positiveEvidence: [
              { kind: "k", url: "https://medium.com/x/y", quote: "" },
              { kind: "k", url: "https://reddit.com/r/x/comments/y", quote: "" },
            ],
            negativeEvidence: [],
          },
        ],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    expect(ce.length).toBe(2);
    expect(ce[0]!.primaryCount).toBe(1);
    expect(ce[1]!.thirdPartyCount).toBe(1);
    expect(ce[1]!.aggregatorCount).toBe(1);
    expect(ce[1]!.primaryCount).toBe(0);
  });

  it("C10: tolerates a stringified-JSON evidence entry (auto-parses)", async () => {
    const entry = {
      hypothesisId: "H_LAT_1",
      verdict: "inconclusive",
      positiveEvidence: [
        { kind: "vendor_docs", url: "https://docs.0g.ai/x", quote: "..." },
      ],
      negativeEvidence: [],
    };
    const out = await mod.run(
      {
        // Mix: index 0 is a stringified entry, index 1 is the raw object.
        // Reproduces dogfood-c10 v8 behavior where one fanout child
        // returned JSON.stringify(obj) while siblings returned obj.
        evidence: [JSON.stringify(entry), entry],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    expect(ce.length).toBe(2);
    expect(ce[0]!.hypothesisId).toBe("H_LAT_1");
    expect(ce[1]!.hypothesisId).toBe("H_LAT_1");
  });

  it("C10: tolerates a stringified-JSON citation inside positiveEvidence list", async () => {
    const cit = { kind: "src", url: "https://github.com/a/b/blob/main/x.sol", quote: "fn f()" };
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H1",
            verdict: "supported",
            positiveEvidence: [JSON.stringify(cit), cit],
            negativeEvidence: [],
          },
        ],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    const pos = ce[0]!.positiveEvidence as Array<Record<string, unknown>>;
    expect(pos.length).toBe(2);
    expect(pos[0]!.url).toBe(cit.url);
    expect(pos[0]!.type).toBe("primary");
  });

  it("THROWS when 'evidence' is not an array", async () => {
    await expect(
      mod.run({ evidence: "nope" }, ctx()),
    ).rejects.toThrow(/'evidence' is required/);
  });

  it("THROWS when evidence[i] is not an object", async () => {
    await expect(
      mod.run({ evidence: ["not-an-object"] }, ctx()),
    ).rejects.toThrow(/evidence\[0\] must be an object/);
  });

  it("THROWS when positiveEvidence is not an array", async () => {
    await expect(
      mod.run(
        {
          evidence: [
            { hypothesisId: "H1", verdict: "supported", positiveEvidence: "no" },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/positiveEvidence must be an array/);
  });

  it("THROWS when a citation url is non-string non-empty", async () => {
    await expect(
      mod.run(
        {
          evidence: [
            {
              hypothesisId: "H1",
              verdict: "supported",
              positiveEvidence: [{ kind: "k", url: 42, quote: "" }],
              negativeEvidence: [],
            },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/positiveEvidence\[0\]\.url must be a string/);
  });

  it("works with empty positiveEvidence and negativeEvidence", async () => {
    const out = await mod.run(
      {
        evidence: [
          {
            hypothesisId: "H1",
            verdict: "inconclusive",
            positiveEvidence: [],
            negativeEvidence: [],
          },
        ],
      },
      ctx(),
    );
    const ce = out.classifiedEvidence as Array<Record<string, unknown>>;
    expect(ce[0]!.primaryCount).toBe(0);
    expect(ce[0]!.unknownCount).toBe(0);
  });
});

describe("noop_terminal", () => {
  const mod = BUILTIN_SCRIPT_MODULES.noop_terminal!;

  it("returns { done: true } regardless of inputs", async () => {
    const out = await mod.run({}, ctx());
    expect(out).toEqual({ done: true });
  });

  it("ignores input keys", async () => {
    const out = await mod.run({ anything: "ignored", arbitrary: 42 }, ctx());
    expect(out).toEqual({ done: true });
  });
});
