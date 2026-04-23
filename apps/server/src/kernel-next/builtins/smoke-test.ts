// Hand-ported kernel-next IR for the legacy smoke-test builtin.
//
// Legacy YAML source: apps/server/src/builtin-pipelines/smoke-test/pipeline.yaml
// Legacy prompts:      apps/server/src/builtin-pipelines/smoke-test/prompts/system/
//
// Mapping choices (A7.4):
//   - store_schema.<entry>.fields.<f> -> kernel-next port with the same
//     name on the stage that produced the entry (`produced_by`).
//   - downstream stage's `runtime.reads.<local>: <entry>` -> one wire
//     PER declared field of <entry>. So reading `greeting` in echoBack
//     becomes two wires (greet.subject -> echoBack.subject, greet.note
//     -> echoBack.note).
//   - promptRef is a path (under a root dir supplied to FsPromptResolver)
//     matching the legacy system/<name>.md layout. The legacy prompts
//     reference "greeting.subject" etc; kernel-next's
//     buildSystemPromptAppend overrides that with explicit port
//     semantics at invocation time, so we reuse the files verbatim.
//
// This is deliberately not a general YAML→IR converter. Full converter
// is future work (A7 follow-up); this file is the minimum concrete
// surface needed to prove tech-research-style builtins can run under
// kernel-next with SSE observability.

import { join } from "node:path";
import type { PipelineIR } from "../ir/schema.js";

export function smokeTestIR(): PipelineIR {
  return {
    name: "smoke-test",
    externalInputs: [
      { name: "task_text", type: "string" },
    ],
    stages: [
      {
        name: "greet",
        type: "agent",
        // P6-4 fix (2026-04-23): greet now consumes the user's task
        // text through an external input port. Pre-fix, greet had
        // inputs: [] and the prompt referenced a task text that was
        // never wired, so the agent fell back to "unknown" every run.
        inputs: [{ name: "task_text", type: "string" }],
        outputs: [
          { name: "subject", type: "string" },
          { name: "note", type: "string" },
        ],
        config: { promptRef: "system/greet" },
      },
      {
        name: "echoBack",
        type: "agent",
        inputs: [
          { name: "subject", type: "string" },
          { name: "note", type: "string" },
        ],
        outputs: [
          // Legacy declares `message: markdown` — kernel-next has no
          // distinct markdown type yet (see design doc §6.1 type
          // system). Treat as string; the prompt asks for a short
          // paragraph which is still textual.
          { name: "message", type: "string" },
        ],
        config: { promptRef: "system/echo-back" },
      },
    ],
    wires: [
      { from: { source: "external", port: "task_text" }, to: { stage: "greet", port: "task_text" } },
      { from: { stage: "greet", port: "subject" }, to: { stage: "echoBack", port: "subject" } },
      { from: { stage: "greet", port: "note" }, to: { stage: "echoBack", port: "note" } },
    ],
  };
}

/**
 * Absolute path to the legacy smoke-test prompts root. Passed to
 * FsPromptResolver when constructing RealStageExecutor for this IR.
 *
 * Resolved against the server's src/ root rather than relative to
 * this file so behaviour is identical whether the code runs from
 * src/ (tsx) or dist/ (compiled). The prompts directory lives under
 * src/builtin-pipelines/ in either case.
 */
export function smokeTestPromptRoot(): string {
  // This module sits at src/kernel-next/builtins/. The prompt
  // directory is three levels up, then into builtin-pipelines/smoke-
  // test/prompts.
  return join(
    new URL(".", import.meta.url).pathname,
    "..", "..", "builtin-pipelines", "smoke-test", "prompts",
  );
}
