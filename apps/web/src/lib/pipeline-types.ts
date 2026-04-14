// Shared pipeline schema types for frontend components

export interface OutputFieldSchema {
  key: string;
  type: "string" | "number" | "boolean" | "string[]" | "object" | "object[]" | "markdown";
  description: string;
  fields?: OutputFieldSchema[];
  display_hint?: "link" | "badge" | "code";
  hidden?: boolean;
}

export interface StageOutputSchema {
  [storeName: string]: {
    type: "object";
    label?: string;
    fields: OutputFieldSchema[];
    hidden?: boolean;
  };
}

export interface PipelineStageSchema {
  name: string;
  type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach" | "llm_decision";
  engine?: string;
  outputs?: StageOutputSchema;
  runtime?: Record<string, any>;
}

export interface ParallelGroupSchema {
  parallel: {
    name: string;
    stages: PipelineStageSchema[];
  };
}

export type PipelineStageEntry = PipelineStageSchema | ParallelGroupSchema;

export function isPipelineParallelGroup(entry: PipelineStageEntry): entry is ParallelGroupSchema {
  return "parallel" in entry;
}

export function flattenPipelineStages(entries: PipelineStageEntry[]): PipelineStageSchema[] {
  const result: PipelineStageSchema[] = [];
  for (const e of entries) {
    if (isPipelineParallelGroup(e)) {
      result.push(...e.parallel.stages);
    } else {
      result.push(e);
    }
  }
  return result;
}

export interface FragmentMeta {
  id: string;
  keywords: string[];
  stages: string[] | "*";
  always: boolean;
}
