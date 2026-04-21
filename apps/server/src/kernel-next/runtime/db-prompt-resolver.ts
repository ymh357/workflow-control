// DbPromptResolver — SQLite-backed prompt lookup for kernel-next.
// See docs/superpowers/specs/2026-04-24-prompts-in-sqlite-design.md §7.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PromptResolveArgs, PromptResolver } from "./prompt-resolver.js";

export class DbPromptResolver implements PromptResolver {
  private readonly lookupStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly versionHash: string,
  ) {
    this.lookupStmt = db.prepare(`
      SELECT pc.content
      FROM pipeline_prompt_refs ppr
      JOIN prompt_contents pc ON pc.content_hash = ppr.content_hash
      WHERE ppr.version_hash = ? AND ppr.prompt_ref = ?
    `);
  }

  resolve(args: PromptResolveArgs): string {
    const promptRef = args.stage.config.promptRef;
    if (!promptRef || promptRef.trim().length === 0) {
      throw new Error(
        `DbPromptResolver: stage '${args.stage.name}' has empty promptRef`,
      );
    }
    const row = this.lookupStmt.get(this.versionHash, promptRef) as
      | { content: string }
      | undefined;
    if (!row) {
      throw new Error(
        `DbPromptResolver: promptRef '${promptRef}' not found for ` +
          `versionHash='${this.versionHash}' (stage '${args.stage.name}')`,
      );
    }
    return row.content;
  }
}
