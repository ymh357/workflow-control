// Prompt resolver — userland extension point per terminal-design §2.3.
//
// The kernel delegates prompt assembly to userland: it hands the resolver
// a stage + context and expects a plain string back. The kernel does not
// inspect the result; any layering (global constraints, fragments, output
// schema) is the resolver's concern.
//
// For A0.3 we ship a trivial resolver that treats AgentStage.config.promptRef
// as the prompt itself — the same short-circuit semantics the spike has been
// running on. A real registry-backed resolver lands in A2 when AgentMachine
// is built.

import type { AgentStage } from "../ir/schema.js";

/**
 * Arguments passed to a resolver. `taskId` / `attemptId` are provided so
 * resolvers can inject identity into the returned prompt if they need to
 * (e.g. embedding explicit write_port call examples grounded in the
 * actual IDs). The kernel does not require the resolver to use them.
 */
export interface PromptResolveArgs {
  stage: AgentStage;
  taskId: string;
  attemptId: string;
  inputs: Record<string, unknown>;
}

export interface PromptResolver {
  resolve(args: PromptResolveArgs): string;
}

/**
 * Trivial resolver: returns stage.config.promptRef verbatim. Intended as a
 * stop-gap while the userland registry contract (A2) is designed. Does not
 * look up fragments, does not splice task/inputs into the string.
 */
export class TrivialPromptResolver implements PromptResolver {
  resolve({ stage }: PromptResolveArgs): string {
    const p = stage.config.promptRef;
    if (!p || p.trim().length === 0) {
      throw new Error(
        `TrivialPromptResolver: stage '${stage.name}' has empty promptRef; ` +
          `the trivial resolver cannot fabricate a prompt.`,
      );
    }
    return p;
  }
}
