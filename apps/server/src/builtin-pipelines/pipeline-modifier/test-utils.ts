// Test helper for pipeline-modifier e2e tests.
//
// The IR includes a real script stage (`validatePatch`, the Bug 8b
// kernel guard). e2e tests still mock all agent stages via
// StageHandlerMap, but the script stage must run for real so the
// guard is exercised end-to-end. CompositeStageExecutor routes by
// stage type: agent → MockStageExecutor, script → ScriptStageExecutor
// against the real BUILTIN_SCRIPT_MODULES registry.

import { MockStageExecutor } from "../../kernel-next/runtime/mock-executor.js";
import { ScriptStageExecutor } from "../../kernel-next/runtime/script-executor.js";
import { TrivialScriptModuleResolver } from "../../kernel-next/runtime/script-module-resolver.js";
import { BUILTIN_SCRIPT_MODULES } from "../../kernel-next/builtin-scripts/index.js";
import { CompositeStageExecutor } from "../../kernel-next/runtime/composite-executor.js";
import type { StageHandlerMap } from "../../kernel-next/runtime/executor.js";

export function buildModifierTestExecutor(handlers: StageHandlerMap): CompositeStageExecutor {
  return new CompositeStageExecutor({
    agent: new MockStageExecutor({ handlers }),
    script: new ScriptStageExecutor({
      resolver: new TrivialScriptModuleResolver({ modules: { ...BUILTIN_SCRIPT_MODULES } }),
    }),
  });
}
