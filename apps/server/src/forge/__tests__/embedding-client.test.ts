import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildEmbeddingClient, embedLocalHash } from "../similarity/embedding-client.js";

describe("embedLocalHash", () => {
  it("returns a Float32Array of length 256", () => {
    const v = embedLocalHash("hello world");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(256);
  });

  it("returns L2-normalized vectors (norm ≈ 1)", () => {
    const v = embedLocalHash("debugging the test runner timeout issue");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
    expect(Math.sqrt(n)).toBeCloseTo(1, 5);
  });

  it("returns zero vector for empty input", () => {
    const v = embedLocalHash("");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
    expect(n).toBe(0);
  });

  it("is deterministic", () => {
    const v1 = embedLocalHash("write a changelog from recent commits");
    const v2 = embedLocalHash("write a changelog from recent commits");
    for (let i = 0; i < v1.length; i++) {
      expect(v1[i]).toBe(v2[i]);
    }
  });

  it("similar texts produce more similar vectors than dissimilar texts", () => {
    function cos(a: Float32Array, b: Float32Array): number {
      let d = 0; for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
      return d;
    }
    const a = embedLocalHash("write a changelog from recent commits");
    const b = embedLocalHash("write a changelog from recent commits in main");
    const c = embedLocalHash("rebuild a docker image and push it to the registry");
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
  });

  it("different texts produce different vectors", () => {
    const v1 = embedLocalHash("hello world");
    const v2 = embedLocalHash("goodbye sky");
    let same = true;
    for (let i = 0; i < v1.length; i++) if (v1[i] !== v2[i]) { same = false; break; }
    expect(same).toBe(false);
  });
});

describe("buildEmbeddingClient", () => {
  beforeEach(() => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("default provider is local-hash, no key required", async () => {
    const c = buildEmbeddingClient();
    expect(c.model).toBe("local-hash-v1");
    expect(c.dim).toBe(256);
    const v = await c.embed(["hello"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toBeInstanceOf(Float32Array);
  });

  it("explicit local-hash works", async () => {
    const c = buildEmbeddingClient({ provider: "local-hash" });
    const v = await c.embed(["a", "b"]);
    expect(v).toHaveLength(2);
  });

  it("voyage missing key throws EMBEDDING_NOT_CONFIGURED", () => {
    expect(() => buildEmbeddingClient({ provider: "voyage" })).toThrow(/EMBEDDING_NOT_CONFIGURED/);
  });

  it("openai missing key throws EMBEDDING_NOT_CONFIGURED", () => {
    expect(() => buildEmbeddingClient({ provider: "openai" })).toThrow(/EMBEDDING_NOT_CONFIGURED/);
  });

  it("voyage with key calls api and parses response", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      async json() { return { data: [{ embedding: [0.1, 0.2, 0.3] }] }; },
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const c = buildEmbeddingClient({ provider: "voyage", apiKey: "test-key" });
      const v = await c.embed(["hello"]);
      expect(v).toHaveLength(1);
      expect(v[0]!.length).toBe(3);
      expect(v[0]![0]).toBeCloseTo(0.1);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      const callArgs = fakeFetch.mock.calls[0]!;
      expect(callArgs[0]).toBe("https://api.voyageai.com/v1/embeddings");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("voyage HTTP error throws", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const c = buildEmbeddingClient({ provider: "voyage", apiKey: "test-key" });
      await expect(c.embed(["x"])).rejects.toThrow(/voyage HTTP 500/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
