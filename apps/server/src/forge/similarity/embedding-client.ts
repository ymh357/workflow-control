// Embedding client: text -> Float32Array vector. Pluggable provider.
//
// Default provider: "local-hash" — a fully offline, deterministic
// hash-based embedding. Vector is built from token bigram hashes
// projected into a 256-dim space. Quality is below dense embedding
// models but adequate for clustering coarse-grained "what kind of
// task is this?" intents on a single user's session log.
//
// Optional providers:
//   - "voyage"  (env: VOYAGE_API_KEY)  — voyage-3, 1024 dim
//   - "openai"  (env: OPENAI_API_KEY)  — text-embedding-3-small, 1536 dim
//
// Selection via SystemSettings.forge.embedding.provider; falls through
// to "local-hash" when no key configured.

export interface EmbeddingClient {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type EmbeddingProvider = "local-hash" | "voyage" | "openai";

export function buildEmbeddingClient(opts: {
  provider?: EmbeddingProvider;
  apiKey?: string;
} = {}): EmbeddingClient {
  const provider = opts.provider ?? "local-hash";
  if (provider === "local-hash") return localHashClient();
  if (provider === "voyage") {
    const key = opts.apiKey ?? process.env.VOYAGE_API_KEY;
    if (!key) throw new Error("EMBEDDING_NOT_CONFIGURED: VOYAGE_API_KEY missing");
    return voyageClient(key);
  }
  if (provider === "openai") {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("EMBEDDING_NOT_CONFIGURED: OPENAI_API_KEY missing");
    return openaiClient(key);
  }
  throw new Error(`unknown embedding provider: ${provider as string}`);
}

// ---------------- local-hash ----------------

const LOCAL_DIM = 256;

function localHashClient(): EmbeddingClient {
  return {
    model: "local-hash-v1",
    dim: LOCAL_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => embedLocalHash(t));
    },
  };
}

// Tokenize on word boundaries, lowercase, drop length<2 tokens.
// Build bigrams + unigrams, hash each into LOCAL_DIM bins, accumulate.
// L2-normalize the result so cosine == dot product.
export function embedLocalHash(text: string): Float32Array {
  const v = new Float32Array(LOCAL_DIM);
  if (!text) return v;
  const tokens: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) {
    tokens.push(m[0]);
  }
  for (const t of tokens) {
    v[hashBucket(t)] += 1;
  }
  for (let i = 1; i < tokens.length; i++) {
    v[hashBucket(tokens[i - 1] + " " + tokens[i])] += 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  if (norm === 0) return v;
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

// FNV-1a 32-bit hash, modulo dim.
function hashBucket(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h | 0) % LOCAL_DIM;
}

// ---------------- voyage ----------------

function voyageClient(key: string): EmbeddingClient {
  return {
    model: "voyage-3",
    dim: 1024,
    async embed(texts) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "voyage-3", input: texts }),
      });
      if (!res.ok) throw new Error(`voyage HTTP ${res.status}`);
      const json = await res.json() as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => Float32Array.from(d.embedding));
    },
  };
}

// ---------------- openai ----------------

function openaiClient(key: string): EmbeddingClient {
  return {
    model: "text-embedding-3-small",
    dim: 1536,
    async embed(texts) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
      });
      if (!res.ok) throw new Error(`openai HTTP ${res.status}`);
      const json = await res.json() as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => Float32Array.from(d.embedding));
    },
  };
}
