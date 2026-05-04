// CRUD for pipeline_embeddings — descriptor-level embeddings keyed by
// version_hash. Stale on hot-update (different version_hash); fresh
// embedding is computed on demand by the matcher when a hash is seen
// for the first time.

import type { DatabaseSync } from "node:sqlite";
import { f32ToBlob, blobToF32 } from "./clusters.js";

export interface PipelineEmbeddingRow {
  versionHash: string;
  pipelineName: string;
  descriptorText: string;
  embedding: Float32Array;
  embeddingModel: string;
  embeddingDim: number;
  createdAt: number;
}

export function upsertPipelineEmbedding(db: DatabaseSync, row: PipelineEmbeddingRow): void {
  db.prepare(
    `INSERT INTO pipeline_embeddings
       (version_hash, pipeline_name, descriptor_text, embedding, embedding_model, embedding_dim, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_hash) DO UPDATE SET
       descriptor_text = excluded.descriptor_text,
       embedding       = excluded.embedding,
       embedding_model = excluded.embedding_model,
       embedding_dim   = excluded.embedding_dim,
       created_at      = excluded.created_at`,
  ).run(
    row.versionHash, row.pipelineName, row.descriptorText,
    f32ToBlob(row.embedding), row.embeddingModel, row.embeddingDim, row.createdAt,
  );
}

function rowToEmbedding(r: Record<string, unknown>): PipelineEmbeddingRow {
  return {
    versionHash: r.version_hash as string,
    pipelineName: r.pipeline_name as string,
    descriptorText: r.descriptor_text as string,
    embedding: blobToF32(r.embedding as Buffer),
    embeddingModel: r.embedding_model as string,
    embeddingDim: r.embedding_dim as number,
    createdAt: r.created_at as number,
  };
}

export function getPipelineEmbedding(db: DatabaseSync, versionHash: string): PipelineEmbeddingRow | null {
  const r = db.prepare(`SELECT * FROM pipeline_embeddings WHERE version_hash = ?`).get(versionHash) as
    Record<string, unknown> | undefined;
  return r ? rowToEmbedding(r) : null;
}

export function listPipelineEmbeddings(db: DatabaseSync, model: string): PipelineEmbeddingRow[] {
  const rows = db.prepare(
    `SELECT * FROM pipeline_embeddings WHERE embedding_model = ?`,
  ).all(model) as Array<Record<string, unknown>>;
  return rows.map(rowToEmbedding);
}

export function deletePipelineEmbeddingsByName(db: DatabaseSync, pipelineName: string): void {
  db.prepare(`DELETE FROM pipeline_embeddings WHERE pipeline_name = ?`).run(pipelineName);
}
