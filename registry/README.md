# Workflow Control Registry

Curated, shareable assets for workflow-control instances.

## Current state (2026-04-24)

This registry holds two kinds of content:

1. **Knowledge fragments** (`type: fragment`) — portable markdown snippets
   that can be composed into prompts. Installed via the `wfctl` CLI into
   `apps/server/config/prompts/fragments/`. Still fully supported.
2. **Skills & hooks** — sourced from `apps/server/config/{skills,hooks}/`
   and mirrored here for cross-machine install via `wfctl`.

**Pipelines are no longer hosted as legacy YAML packages.** The five
legacy YAML pipelines (`linear-dev-cycle`, `pipeline-generator`,
`plan-then-execute`, `systematic-debugging-pipeline`, `tech-research-phased`)
were deleted on 2026-04-24 when kernel-next replaced the YAML-driven
engine. kernel-next consumes `pipeline.ir.json` — the canonical
content-hashed IR — not legacy YAML DSL.

## Sharing an IR-native pipeline

kernel-next pipelines are represented as `pipeline.ir.json`. To share a
pipeline between machines:

1. **Source machine** — submit the IR locally so kernel-next validates
   and stores it:

   ```bash
   curl -X POST http://localhost:3001/api/kernel/proposals \
     -H 'Content-Type: application/json' \
     -d '{"ir": {...}, "prompts": {...}}'
   ```

   Alternatively use the `submit_pipeline` MCP tool, which is what
   agents should reach for when authoring a new pipeline.

2. **Export** — dump the IR + prompts for the chosen version hash:

   ```bash
   curl http://localhost:3001/api/kernel/pipelines/<versionHash> > pipeline.json
   ```

3. **Target machine** — submit the exported JSON:

   ```bash
   curl -X POST http://localhost:3001/api/kernel/proposals \
     -H 'Content-Type: application/json' \
     -d @pipeline.json
   ```

## Authoring new pipelines

Use the `pipeline-generator` builtin (seeded at every kernel-next boot
from `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json`).
It emits a validated `pipeline.ir.json` from a natural-language
description. See `docs/kernel-next-terminal-design.md` for the full
authoring flow.

## Roadmap

A future task will repopulate this registry with a small curated set of
IR-native pipelines once enough real-world pipelines have accumulated to
be worth sharing.
