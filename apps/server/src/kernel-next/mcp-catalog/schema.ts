import { z } from "zod";
import type { Diagnostic as _GlobalDiagnostic } from "../ir/schema.js";

const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// Bug 47 (c12+ review): pre-fix `command` was a free-form string, so
// a hand-crafted custom catalog entry could declare `command: "/bin/sh"`
// (or any other binary) and persist a post-restart RCE path — every
// time the catalog entry was equipped, the kernel would spawn the
// declared command with the entry's args. The catalog is meant to
// boot well-known MCP server runners (npx-published packages, uvx
// modules, etc.) — there is no legitimate reason to point `command`
// at an arbitrary binary.
//
// Allowlist below: package-runner / interpreter binaries that can
// only execute code packaged under their own ecosystems' security
// model. Adding to this list is a deliberate policy decision, not
// a routine catalog change.
const ALLOWED_CATALOG_COMMANDS = [
  "npx",
  "uvx",
  "bunx",
  "pnpx",
  "yarn",      // `yarn dlx <pkg>` is the yarn equivalent of npx
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "uv",
  "pipx",
] as const;
const ALLOWED_CATALOG_COMMANDS_SET = new Set<string>(ALLOWED_CATALOG_COMMANDS);

const CommandSchema = z
  .string()
  .min(1)
  .refine((v) => ALLOWED_CATALOG_COMMANDS_SET.has(v), {
    message: `command must be one of [${ALLOWED_CATALOG_COMMANDS.join(", ")}] (RCE prevention)`,
  });

export const CatalogEntrySchema = z.object({
  id: z.string().min(1).max(64).regex(KEBAB_ID, "id must be kebab-case lowercase"),
  source: z.enum(["builtin", "custom"]),
  schemaVersion: z.literal("1"),

  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  useCases: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)),
  homepage: z.string().url().optional(),

  command: CommandSchema,
  args: z.array(z.string()),
  packageName: z.string().min(1).optional(),

  envKeys: z.array(z.object({
    name: z.string().min(1).max(128),
    required: z.boolean(),
    description: z.string(),
    obtainUrl: z.string().url().optional(),
    obtainSteps: z.string().optional(),
  })),

  healthCheckTimeoutMs: z.number().int().positive(),

  toolsPreview: z.array(z.object({
    name: z.string().min(1),
    brief: z.string().min(1),
  })).optional(),

  deprecatedAt: z.number().int().positive().optional(),
}).strict();

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const RecommendResultSchema = z.object({
  id: z.string().min(1),
  score: z.number().min(0).max(1),
  evidence: z.object({
    matchedTags: z.array(z.string()),
    matchedUseCases: z.array(z.string()),
    matchedDescriptionTerms: z.array(z.string()),
  }),
  llmReason: z.string().optional(),
}).strict();

export type RecommendResult = z.infer<typeof RecommendResultSchema>;

export const CATALOG_DIAGNOSTIC_CODES = [
  "CATALOG_ENTRY_NOT_FOUND",
  "CATALOG_ENTRY_ID_CONFLICT",
  "CATALOG_INVALID_ENTRY",
  "CATALOG_BUILTIN_NOT_WRITABLE",
  "CATALOG_LLM_OVERLAY_UNAVAILABLE",
] as const;

export type CatalogDiagnosticCode = (typeof CATALOG_DIAGNOSTIC_CODES)[number];

// Compile-time check: every catalog code must be a member of the global
// Diagnostic.code enum. If you add a catalog code here, you MUST also add
// it to DiagnosticSchema in ir/schema.ts.
type _AssertCatalogCodesAreGlobal = CatalogDiagnosticCode extends _GlobalDiagnostic["code"]
  ? true
  : "ERROR: A catalog code is not in the global Diagnostic.code enum";
const _catalogCodesCheck: _AssertCatalogCodesAreGlobal = true;
