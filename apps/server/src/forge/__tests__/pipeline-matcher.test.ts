import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { initForgeSchema } from "../db/schema.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { buildEmbeddingClient } from "../similarity/embedding-client.js";
import {
  refreshPipelineEmbeddings,
  matchEpisodeAgainstPipelines,
  buildEpisodeText,
  MATCH_THRESHOLD,
} from "../matching/pipeline-matcher.js";
import { listPipelineEmbeddings, getPipelineEmbedding } from "../db/pipeline-embeddings.js";
import type { PipelineIR } from "../../kernel-next/ir/schema.js";
import type { SessionEpisode } from "../types.js";

let kernelDb: DatabaseSync;
let forgeDb: DatabaseSync;

beforeEach(() => {
  kernelDb = new DatabaseSync(":memory:");
  initKernelNextSchema(kernelDb);
  forgeDb = new DatabaseSync(":memory:");
  initForgeSchema(forgeDb);
});

function pipeline(name: string, words: string[]): PipelineIR {
  return {
    name,
    externalInputs: [{ name: "input", type: "string" }],
    stages: [{
      name: "main",
      type: "agent",
      inputs: [{ name: "input", type: "string" }],
      outputs: [{ name: "output", type: "string" }],
      config: { promptRef: "system/" + words.join("-") },
    }],
    wires: [{
      from: { source: "external", port: "input" },
      to: { stage: "main", port: "input" },
    }],
  };
}

async function submit(ir: PipelineIR): Promise<void> {
  const svc = new KernelService(kernelDb, { skipTypeCheck: true });
  const prompts: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent" && s.config.promptRef) prompts[s.config.promptRef] = "dummy";
  }
  const r = await svc.submit(ir, { prompts });
  if (!r.ok) throw new Error("submit failed: " + JSON.stringify(r.diagnostics));
}

describe("buildEpisodeText", () => {
  it("combines intent + step descriptions", () => {
    const ep: SessionEpisode = {
      episodeId: "e", sessionId: "s", startSeq: 1, endSeq: 5,
      intent: "extract changelog from recent commits",
      outcome: "completed",
      steps: [
        { stageKind: "agent", description: "scan git log", inputs: ["branch"], outputs: ["commits"], toolCalls: ["Bash"] },
        { stageKind: "agent", description: "format markdown", inputs: ["commits"], outputs: ["markdown"] },
      ],
      rationale: "r", pipelineAble: true, createdAt: 1,
    };
    const t = buildEpisodeText(ep);
    expect(t).toContain("extract changelog");
    expect(t).toContain("scan git log");
    expect(t).toContain("inputs branch");
    expect(t).toContain("tools Bash");
  });
});

describe("refreshPipelineEmbeddings", () => {
  it("embeds all known latest pipelines", async () => {
    await submit(pipeline("p-changelog", ["scan", "commits", "format", "changelog"]));
    await submit(pipeline("p-rebuild", ["docker", "build", "push", "registry"]));
    const embedder = buildEmbeddingClient();
    const res = await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder });
    expect(res.refreshed).toBe(2);
    expect(res.reused).toBe(0);
    expect(listPipelineEmbeddings(forgeDb, embedder.model)).toHaveLength(2);
  });

  it("is idempotent — second call reuses cache", async () => {
    await submit(pipeline("p-changelog", ["scan", "commits", "format", "changelog"]));
    const embedder = buildEmbeddingClient();
    await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder });
    const res2 = await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder });
    expect(res2.reused).toBe(1);
    expect(res2.refreshed).toBe(0);
  });

  it("refreshes when embedding_model changes", async () => {
    await submit(pipeline("p-changelog", ["scan", "commits"]));
    const e1 = buildEmbeddingClient();
    await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder: e1 });
    // Simulate a different model by writing one with a fake model name
    const allRows = listPipelineEmbeddings(forgeDb, e1.model);
    expect(allRows).toHaveLength(1);
    forgeDb.prepare(`UPDATE pipeline_embeddings SET embedding_model = 'old-model'`).run();
    const res = await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder: e1 });
    expect(res.refreshed).toBe(1);
  });
});

describe("matchEpisodeAgainstPipelines", () => {
  it("returns null with cosine 0 when no pipelines cached", () => {
    const r = matchEpisodeAgainstPipelines({
      forgeDb,
      episodeEmbedding: new Float32Array(256),
      embeddingModel: "local-hash-v1",
    });
    expect(r.bestPipelineName).toBeNull();
    expect(r.bestCosine).toBe(0);
    expect(r.isMatch).toBe(false);
  });

  it("matches a similar pipeline (intent ↔ pipeline descriptor)", async () => {
    await submit(pipeline("changelog-extractor", ["scan", "commits", "format", "changelog"]));
    await submit(pipeline("docker-rebuild", ["docker", "image", "rebuild", "push", "registry"]));
    const embedder = buildEmbeddingClient();
    await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder });

    const epText = "scan commits and format changelog markdown";
    const [epEmb] = await embedder.embed([epText]);

    const r = matchEpisodeAgainstPipelines({
      forgeDb, episodeEmbedding: epEmb!, embeddingModel: embedder.model,
    });
    expect(r.bestPipelineName).toBe("changelog-extractor");
    expect(r.bestCosine).toBeGreaterThan(0);
    expect(r.ranking[0]!.pipelineName).toBe("changelog-extractor");
    expect(r.ranking).toHaveLength(2);
  });

  it("isMatch flag matches MATCH_THRESHOLD", async () => {
    await submit(pipeline("p", ["unique", "specific", "fingerprint"]));
    const embedder = buildEmbeddingClient();
    await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder });

    // Strongly-related text
    const [related] = await embedder.embed(["unique specific fingerprint task scenario"]);
    const r1 = matchEpisodeAgainstPipelines({
      forgeDb, episodeEmbedding: related!, embeddingModel: embedder.model,
    });
    if (r1.bestCosine >= MATCH_THRESHOLD) expect(r1.isMatch).toBe(true);
    else expect(r1.isMatch).toBe(false);

    // Unrelated text
    const [unrelated] = await embedder.embed(["completely orthogonal topic about cats and dogs"]);
    const r2 = matchEpisodeAgainstPipelines({
      forgeDb, episodeEmbedding: unrelated!, embeddingModel: embedder.model,
    });
    expect(r2.isMatch).toBe(false);
  });

  it("ignores cached embeddings of different dimension", async () => {
    await submit(pipeline("p", ["x"]));
    const embedder = buildEmbeddingClient();
    await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder });

    // Now query with a smaller-dim embedding (should yield no match).
    const r = matchEpisodeAgainstPipelines({
      forgeDb,
      episodeEmbedding: new Float32Array(8),
      embeddingModel: embedder.model,
    });
    expect(r.bestPipelineName).toBeNull();
  });
});

describe("getPipelineEmbedding sanity", () => {
  it("round-trips through upsert", async () => {
    await submit(pipeline("p", ["unique"]));
    const embedder = buildEmbeddingClient();
    await refreshPipelineEmbeddings({ forgeDb, kernelDb, embedder });
    const all = listPipelineEmbeddings(forgeDb, embedder.model);
    const single = getPipelineEmbedding(forgeDb, all[0]!.versionHash);
    expect(single).not.toBeNull();
    expect(single!.pipelineName).toBe("p");
    expect(single!.embedding.length).toBe(embedder.dim);
  });
});
