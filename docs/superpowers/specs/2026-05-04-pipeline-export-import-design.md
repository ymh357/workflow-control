# Pipeline Export / Import (Cross-User Sharing v1)

**Status**: design ready, not implemented
**Date**: 2026-05-04
**Continuation**: c12+ (post YAML-registry retirement, roadmap §修订历史 1.27)
**Roadmap reference**: §4 Slimming list "Registry / 发布系统" — recovered as
file-based export/import after the YAML chain was retired.

---

## Problem

After 2026-05-04 (roadmap 1.27) we retired the YAML registry chain
because YAML packages were structurally incompatible with the kernel-next
runtime — the runtime only loads pipelines from the `pipeline_versions`
SQLite table, so the 38 YAML packages from the public registry never
actually appeared in any user's dashboard.

The whitepaper §1.2 promises "execution is single-user; sharing happens
by exporting/importing IR JSON" — but no UI or HTTP path actually
implements that promise. The only ways to get a pipeline IR off one
machine and onto another today are:

1. Copy the SQLite `pipeline_versions` row by hand (DB-level, error-prone).
2. Hit `GET /api/kernel/pipelines/:versionHash` with `curl`, manually
   compose `{ ir, prompts }` into a request to `submit_pipeline` MCP on
   the target machine (technically possible, ergonomically broken).

Neither qualifies as "sharing." This spec adds first-class export and
import, surfaced both in the HTTP API and the web UI, with no new MCP
tool surface and no agent involvement.

## Goal

A user (single-user, local kernel-next instance) can:

- Click **Export** on any pipeline detail page and receive a self-contained
  JSON file capturing IR + prompts + provenance metadata.
- Click **Import** on the pipelines list page, upload such a file, and
  see the pipeline appear as a new version in their local instance,
  ready to run via the existing launcher.

The exported file is portable across machines without any path,
username, or environment-value leakage. Import goes through the same
validator stack as `submit_pipeline` — no validation bypass.

## Non-goals

- **No MCP tool**. Export/import is human-driven; agents already have
  `submit_pipeline` for programmatic submission. Adding `export_pipeline`
  / `import_pipeline` MCP tools would double the surface for zero gain
  (the agent already has the IR in-memory when it would call export).
- **No multi-pipeline bundles** (a "pack" of N pipelines). One pipeline
  per file. If the user wants three pipelines, they export three files.
  Bundles add a manifest / dependency-ordering question that has no
  current driver.
- **No sub-pipeline graph following**. Static sub-pipeline references
  by name do not exist in the current IR schema (sub-pipelines are
  emitted at runtime by `submit_pipeline_passthrough`, e.g. by
  `pipeline-generator`). The static-graph case is empty; revisit if
  the IR ever gains a static sub-ref field.
- **No remote registry / index / discovery**. File-based sharing only.
  Users can put files in a git repo, gist, S3 bucket, or email
  attachment — not our concern.
- **No envKey value transport**. Secrets stay on each machine, set via
  process env or `run_pipeline`'s `envValues`. The exporting machine's
  `process.env` MUST NOT enter the file.
- **No envKeys redundancy header**. The IR already declares envKeys
  per stage; surfacing a top-level `requiredEnvKeys` array would drift
  on every hot-update that touches mcpServers. The single source of
  truth is the IR; the import dialog can post-import-time call the
  existing `/api/kernel/pipelines/env-probe` to show the user what's
  missing.

## Design

### File envelope

```jsonc
{
  "format": "wfctl-pipeline-export/v1",
  "exportedAt": 1714824000000,
  "source": {
    "pipelineName": "tech-research-collector",
    "versionHash": "abc123…",
    "parentHash": "def456…",
    "createdAt": 1714820000000
  },
  "ir": { /* PipelineIR JSON */ },
  "prompts": { "<promptRef>": "<content>", ... }
}
```

Field semantics:

- `format` (literal `"wfctl-pipeline-export/v1"`): version locks the
  envelope schema. Any future breaking change bumps to `…/v2` and
  parsers reject unknown literals so users get a clear error rather
  than silent drift.
- `exportedAt` (ms epoch, server time at export): provenance only.
  Imports do not consume it.
- `source` (provenance): records what the file came from. None of these
  fields participate in validation or hashing — they exist purely so a
  user inspecting the file can answer "where did this come from?"
- `ir`: the canonical PipelineIR JSON, validated by `PipelineIRSchema`
  on import.
- `prompts`: promptRef → content map, exactly as `submit_pipeline`
  expects. Empty `{}` is allowed (pipeline with no AgentStage prompts).

The envelope is parsed with `.strict()` so unknown top-level fields are
rejected on import — this prevents future ambiguity ("did the export
include this field on purpose, or is it junk?").

### HTTP endpoints

Both live in `apps/server/src/routes/kernel-pipelines.ts` (same module
as the existing list / detail / env-probe handlers).

#### `GET /api/kernel/pipelines/:versionHash/export`

- Lookup `getPipelineIR(db, hash)` and `getPromptsByVersion(db, hash)`.
- 404 with `VERSION_NOT_FOUND` if hash missing.
- Build envelope; serialize as JSON.
- Response headers:
  - `Content-Type: application/json`
  - `Content-Disposition: attachment; filename="<pipelineName>-<shortHash>.wfctl.json"`
  - `<shortHash>` = `versionHash.slice(0, 8)`
  - `<pipelineName>` is sanitized: only `[a-z0-9-]`, lowercase, with
    runs of other characters collapsed to `-`. This keeps filenames
    safe across OSes.

#### `POST /api/kernel/pipelines/import`

- Request body: envelope JSON.
- Body size limit: **10 MB** (typical envelopes are < 100 KB; 10 MB
  leaves headroom for unusually large prompts and is still well below
  hono's default request limits).
- Steps:
  1. Read body → JSON parse. Bad JSON → 400 `INVALID_JSON_BODY`.
  2. Parse with envelope zod schema. Schema fail → 400
     `INVALID_ENVELOPE` with the zod issue array under `diagnostics`.
  3. Wrong `format` literal → 400 `UNSUPPORTED_FORMAT`.
  4. Call `KernelService.submit(envelope.ir, { prompts: envelope.prompts })`.
     This routes through the full validator (PipelineIRSchema, DAG
     validation, store-schema validation, Layer 3 inline-script
     validation, prompt-ref completeness).
  5. On `submit` failure: 400 with `{ ok: false, diagnostics }` —
     verbatim from the kernel.
  6. On success: 200 with
     ```jsonc
     {
       "ok": true,
       "versionHash": "<hash>",
       "pipelineName": "<ir.name>",
       "alreadyExisted": true | false
     }
     ```
     where `alreadyExisted` is true iff the returned hash already had a
     row in `pipeline_versions` before this request (idempotent re-import
     of the same envelope).

### Web UI

#### Detail page `/kernel-next/pipelines/[name]`

Add an **Export** button to the existing actions area (next to Launch).
Implementation: a plain `<a>` with `href` set to the export endpoint
and `download` attribute set, so the browser handles the download
natively without any client-side state machine.

```tsx
<a
  href={`${API_BASE}/api/kernel/pipelines/${detail.latestVersion}/export`}
  download
  className="<existing button styles>"
>Export</a>
```

#### List page `/kernel-next/pipelines`

Add an **Import** button to the page header. Clicking opens a new
dialog component `ImportPipelineDialog`:

- File input (`<input type="file" accept=".json,.wfctl.json,application/json">`).
- Textarea fallback for paste-as-JSON (when files are awkward, e.g.
  copy-paste from a chat client).
- Submit button: posts envelope to `/api/kernel/pipelines/import`.
- On success: close dialog, refetch pipelines list, navigate to
  `/kernel-next/pipelines/<pipelineName>`.
- On failure: render the diagnostics array inline; do not close the
  dialog. User can edit (only meaningful for the textarea path) and
  retry.

The dialog reuses the existing dialog primitives (no new design
language).

### Module organization

```
apps/server/src/kernel-next/ir/
  export-envelope.ts          # NEW: pure data — schema + build/parse
  export-envelope.test.ts     # NEW: round-trip + strict-schema tests

apps/server/src/routes/
  kernel-pipelines.ts         # ADD: 2 handlers (export, import)
  kernel-pipelines.test.ts    # ADD: handler-level tests for both

apps/web/src/components/
  import-pipeline-dialog.tsx        # NEW
  import-pipeline-dialog.test.tsx   # NEW

apps/web/src/app/kernel-next/pipelines/
  page.tsx                    # ADD: Import button + dialog mount
  [name]/page.tsx             # ADD: Export <a download>
```

`export-envelope.ts` is intentionally pure (no DB, no HTTP, no
filesystem). It exports:

```ts
export const PipelineExportEnvelopeSchema = z.object({...}).strict();
export type PipelineExportEnvelope = z.infer<typeof PipelineExportEnvelopeSchema>;

export function buildEnvelope(args: {
  pipelineName: string;
  versionHash: string;
  parentHash: string | null;
  createdAt: number;
  ir: PipelineIR;
  prompts: Record<string, string>;
  now?: number;  // injectable for tests
}): PipelineExportEnvelope;

export function parseEnvelope(raw: unknown):
  | { ok: true; envelope: PipelineExportEnvelope }
  | { ok: false; diagnostics: Diagnostic[] };
```

This isolation lets every layer above (route handlers, UI tests) work
against a stable contract without standing up a DB or HTTP harness.

### Error handling

| Failure | HTTP | code | notes |
|---|---|---|---|
| Export hash not found | 404 | `VERSION_NOT_FOUND` | unchanged from existing detail handler |
| Import body not JSON | 400 | `INVALID_JSON_BODY` | matches env-probe handler |
| Import body too large | 413 | `BODY_TOO_LARGE` | hono middleware |
| Envelope schema fail | 400 | `INVALID_ENVELOPE` | diagnostics carry zod issue paths |
| Wrong format literal | 400 | `UNSUPPORTED_FORMAT` | tells user "this export came from a newer (or older) wfctl" |
| Submit validator fail | 400 | (from submit) | diagnostics passed through verbatim |
| Submit success, new hash | 200 | — | `alreadyExisted: false` |
| Submit success, dup hash | 200 | — | `alreadyExisted: true` |

All error responses share the `{ ok: false, diagnostics: [{ code, message, context? }, ...] }`
shape used elsewhere in kernel-next routes.

### Security

- The export file contains **only** what was already in
  `pipeline_versions` (IR + prompts) plus three integer / string fields
  read from the same row. `process.env` is never read in the export
  handler. envKey **names** appear in the IR (because they're part of
  the pipeline definition); envKey **values** never do.
- Import goes through the full submit pipeline — no validator bypass.
- The 10 MB body limit prevents trivial DoS via giant uploads on a
  single-user local server. (We are not pretending to defend against a
  real attacker; this is local-only.)
- Filename sanitization on the export Content-Disposition header
  prevents header-injection / path-traversal hilarity if a user ever
  named their pipeline `"../../etc/passwd"`.

### Idempotence

`KernelService.submit` already de-duplicates on canonical content hash:
two submits of the same `{ ir, prompts }` return the same `versionHash`
without inserting a duplicate row. The import handler relies on this —
re-importing the same file returns `{ alreadyExisted: true, versionHash }`
without side effects. The web dialog can show "this version already
exists in your database" rather than treating it as an error.

`alreadyExisted` is detected by checking `pipeline_versions` for the
incoming `source.versionHash` *before* calling `submit`. (Even if the
submitting machine's hash differs from the source's hash because of an
schema-version drift, the post-submit hash is what `pipeline_versions`
keys on, and the response carries that one.)

### Testing

#### `export-envelope.test.ts`

- buildEnvelope produces a literal `format: "wfctl-pipeline-export/v1"`.
- buildEnvelope round-trips through parseEnvelope without loss.
- parseEnvelope rejects unknown top-level fields (`.strict()`).
- parseEnvelope rejects wrong format literal (`UNSUPPORTED_FORMAT`).
- parseEnvelope accepts empty prompts `{}`.
- parseEnvelope rejects non-string prompt values.
- parseEnvelope rejects `ir` of wrong shape (catches it via PipelineIRSchema).

#### `kernel-pipelines.test.ts` (additions)

GET export:
- Existing versionHash → 200 + valid envelope + correct
  Content-Disposition filename.
- Missing versionHash → 404 + `VERSION_NOT_FOUND`.
- Filename sanitization for an awkward pipeline name.

POST import:
- Valid envelope, never seen before → 200 + new versionHash +
  `alreadyExisted: false`. Row appears in `pipeline_versions`.
- Same envelope re-imported → 200 + same versionHash +
  `alreadyExisted: true`. No new row inserted.
- Bad JSON body → 400 `INVALID_JSON_BODY`.
- Wrong format string → 400 `UNSUPPORTED_FORMAT`.
- Missing prompts for AgentStage promptRef → 400 +
  `PROMPT_REF_MISSING` (passed through from submit).
- Malformed IR (cycle in DAG) → 400 with the validator's diagnostic.
- Body > 10 MB → 413.

#### `import-pipeline-dialog.test.tsx`

- Renders file input + textarea + submit button.
- Selecting a valid JSON file POSTs to import endpoint and on success
  triggers the success callback with the new versionHash.
- Failure response renders diagnostics inline; dialog stays open.

#### Manual smoke (unautomated)

Export from one running server instance, copy file to a fresh DB,
import via the dialog, click **Run**, verify the pipeline executes
end-to-end. (The unit tests above cover all programmatic surfaces; this
just confirms the human flow.)

## Documentation updates

- Whitepaper §1.2 (en + zh): change "未来若要恢复" / "in the future" to
  the present tense — export/import is now the supported sharing path.
- `docs/product-roadmap.md`: add row 1.28 to the revision history.
- Whitepaper visuals: §1 topology diagram already lacks a registry node
  (since 1.27); no diagram changes needed because export/import is a
  client-driven feature, not a topology change.

## Out of scope (future work)

- **Bundle export** (multiple pipelines + dependency ordering): wait
  until a real driver appears.
- **Static sub-pipeline references** in IR: a separate spec; this one
  ships first.
- **Cross-version migration on import**: if a future kernel-next IR
  schema breaks compatibility with an old `v1` envelope, the answer is
  "import fails with `INVALID_ENVELOPE` and the user upgrades the
  source machine." We don't ship a translation layer.
- **Signed exports**: provenance is informational only; we do not
  cryptographically attest that "user X authored this pipeline."
  Single-user local kernel-next does not have an identity system to
  attach a signature to.
