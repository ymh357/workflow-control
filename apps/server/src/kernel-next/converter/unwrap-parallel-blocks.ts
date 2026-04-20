// Flatten legacy `parallel: { name, stages }` blocks into a linear
// stage array. Each block's outer name is recorded in blockMap so
// later passes (rewriteRetryBackTo, mapHumanConfirmGates) can resolve
// references to it.
//
// Rules:
//   - Nested parallel blocks are rejected.
//   - Empty parallel.stages are rejected.
//   - Stage names must be globally unique across inner + outer.

import type { ConverterDiagnostic } from "./types.js";

interface LegacyStage {
  name?: string;
  [k: string]: unknown;
}
interface ParallelBlock {
  parallel: { name: string; stages: LegacyStage[] };
}
type TopLevel = LegacyStage | ParallelBlock;

export type UnwrapResult =
  | { ok: true;
      flat: LegacyStage[];
      blockMap: Map<string, string>;
      blockMembers: Map<string, string[]>;
    }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

function isParallelBlock(s: unknown): s is ParallelBlock {
  return typeof s === "object" && s !== null && "parallel" in s;
}

export function unwrapParallelBlocks(legacy: { stages?: TopLevel[] }): UnwrapResult {
  const flat: LegacyStage[] = [];
  const blockMap = new Map<string, string>();
  const blockMembers = new Map<string, string[]>();
  const seenNames = new Set<string>();
  const diagnostics: ConverterDiagnostic[] = [];

  for (const el of legacy.stages ?? []) {
    if (isParallelBlock(el)) {
      const block = el.parallel;
      if (block.stages.length === 0) {
        diagnostics.push({
          code: "PARALLEL_EMPTY",
          message: `parallel block '${block.name}' has no stages`,
          context: { block: block.name },
        });
        continue;
      }
      const members: string[] = [];
      for (const inner of block.stages) {
        if (isParallelBlock(inner)) {
          diagnostics.push({
            code: "NESTED_PARALLEL_UNSUPPORTED",
            message: `parallel block '${block.name}' contains a nested parallel block`,
            context: { outer: block.name },
          });
          continue;
        }
        const innerName = inner.name;
        if (typeof innerName === "string") {
          if (seenNames.has(innerName)) {
            diagnostics.push({
              code: "PARALLEL_NAME_COLLISION",
              message: `stage '${innerName}' in parallel block '${block.name}' duplicates an earlier stage name`,
              context: { stage: innerName, block: block.name },
            });
            continue;
          }
          seenNames.add(innerName);
          members.push(innerName);
        }
        flat.push(inner);
      }
      const first = block.stages[0];
      if (first && typeof first.name === "string") {
        blockMap.set(block.name, first.name);
      }
      if (members.length > 0) {
        blockMembers.set(block.name, members);
      }
    } else {
      const stage = el;
      const name = stage.name;
      if (typeof name === "string") {
        if (seenNames.has(name)) {
          diagnostics.push({
            code: "PARALLEL_NAME_COLLISION",
            message: `stage '${name}' duplicates an earlier stage name`,
            context: { stage: name },
          });
          continue;
        }
        seenNames.add(name);
      }
      flat.push(stage);
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, flat, blockMap, blockMembers };
}
