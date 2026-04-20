// Filesystem-backed prompt resolver.
//
// Treats `stage.config.promptRef` as a filename (without extension)
// rooted at the configured directory and loads the corresponding
// `<name>.md` file on each resolve. Reads are synchronous and
// uncached — simpler to reason about during spike phase; when
// pipeline-generator MCP surface lands and prompts become authored
// alongside the IR, caching semantics will need review together with
// hot-update.
//
// Misses are hard errors: an AgentStage with a promptRef that does
// not resolve to an existing file is a pipeline-level bug and should
// fail fast, not silently degrade to an empty prompt.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptResolveArgs, PromptResolver } from "./prompt-resolver.js";

export interface FsPromptResolverOptions {
  /**
   * Directory root that promptRef values are resolved against. A
   * promptRef of "greet" maps to `${rootDir}/greet.md`. Callers that
   * organise prompts into subdirectories (e.g. `system/`) include
   * that subdirectory in the promptRef itself, not in rootDir.
   */
  rootDir: string;
  /**
   * File extension to append to the promptRef. Default ".md". Set
   * to empty string if promptRefs include the extension already.
   */
  extension?: string;
}

const DEFAULT_EXT = ".md";

export class FsPromptResolver implements PromptResolver {
  private readonly rootDir: string;
  private readonly extension: string;

  constructor(options: FsPromptResolverOptions) {
    this.rootDir = options.rootDir;
    this.extension = options.extension ?? DEFAULT_EXT;
  }

  resolve(args: PromptResolveArgs): string {
    const { stage } = args;
    const ref = stage.config.promptRef;
    if (!ref || ref.trim().length === 0) {
      throw new Error(
        `FsPromptResolver: stage '${stage.name}' has empty promptRef.`,
      );
    }
    const relPath = ref.endsWith(this.extension) ? ref : ref + this.extension;
    const absPath = join(this.rootDir, relPath);
    try {
      return readFileSync(absPath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `FsPromptResolver: cannot read prompt for stage '${stage.name}' ` +
          `(promptRef='${ref}', resolved='${absPath}'): ${msg}`,
      );
    }
  }
}
