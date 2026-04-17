type WriteDeclaration = string | { key: string; [k: string]: unknown };

interface StageConfig {
  name: string;
  type: string;
  runtime?: {
    engine?: string;
    writes?: WriteDeclaration[];
    reads?: Record<string, string>;
    [k: string]: unknown;
  };
  outputs?: Record<string, unknown>;
  [k: string]: unknown;
}

interface ParallelGroup {
  parallel: { name: string; stages: StageConfig[] };
}

type StageEntry = StageConfig | ParallelGroup;

function isParallel(e: StageEntry): e is ParallelGroup {
  return "parallel" in e;
}

function flatStages(entries: StageEntry[]): StageConfig[] {
  const result: StageConfig[] = [];
  for (const e of entries) {
    if (isParallel(e)) result.push(...e.parallel.stages);
    else result.push(e);
  }
  return result;
}

function wKey(w: WriteDeclaration): string {
  return typeof w === "string" ? w : w.key;
}

/**
 * Apply deterministic fixes to a pipeline object.
 * Returns array of fix descriptions (empty = nothing fixed).
 */
export function autofixPipeline(pipeline: {
  stages?: StageEntry[];
  store_schema?: Record<string, { produced_by: string; [k: string]: unknown }>;
}): string[] {
  if (!pipeline.stages) return [];
  const fixes: string[] = [];

  // Fix 1: Missing outputs for writes keys (only when NOT using store_schema)
  if (!pipeline.store_schema) {
    for (const stage of flatStages(pipeline.stages)) {
      if ((stage.type !== "agent" && stage.type !== "script") || !stage.runtime?.writes?.length) continue;
      const writeKeys = stage.runtime.writes.map(wKey);
      if (!stage.outputs) {
        stage.outputs = {};
      }
      const outputKeys = new Set(Object.keys(stage.outputs));
      for (const k of writeKeys) {
        if (!outputKeys.has(k)) {
          stage.outputs[k] = { type: "object", fields: [] };
          fixes.push(`auto-fix: added missing outputs entry "${k}" for stage "${stage.name}"`);
        }
      }
    }
  }

  // Fix 2: Auto-populate reads from store_schema for agent stages with empty reads
  if (pipeline.store_schema) {
    // Build ordered list preserving parallel group boundaries.
    // Stages within a parallel group share the same "order" — they cannot read
    // from siblings within the same group (since they execute concurrently).
    const stageOrder = new Map<string, number>();
    let orderIdx = 0;
    for (const entry of pipeline.stages) {
      if (isParallel(entry)) {
        for (const s of entry.parallel.stages) {
          stageOrder.set(s.name, orderIdx);
        }
        orderIdx++; // entire group shares one order slot
      } else {
        stageOrder.set(entry.name, orderIdx);
        orderIdx++;
      }
    }

    // Map store keys to the order index of their producer
    const producerOrder = new Map<string, number>();
    for (const [key, entry] of Object.entries(pipeline.store_schema)) {
      const order = stageOrder.get(entry.produced_by);
      if (order !== undefined) producerOrder.set(key, order);
    }

    for (const stage of flatStages(pipeline.stages)) {
      if (stage.type !== "agent" || !stage.runtime) continue;
      if (stage.runtime.reads && Object.keys(stage.runtime.reads).length > 0) continue;
      const myOrder = stageOrder.get(stage.name);
      if (myOrder === undefined) continue;
      // Only include keys produced by stages with strictly earlier order
      const availableReads: Record<string, string> = {};
      for (const [key, prodOrder] of producerOrder) {
        if (prodOrder < myOrder) {
          availableReads[key] = key;
        }
      }
      if (Object.keys(availableReads).length > 0) {
        stage.runtime.reads = availableReads;
        fixes.push(
          `auto-fix: populated reads for stage "${stage.name}" from store_schema: [${Object.keys(availableReads).join(", ")}]`,
        );
      }
    }
  }

  return fixes;
}
