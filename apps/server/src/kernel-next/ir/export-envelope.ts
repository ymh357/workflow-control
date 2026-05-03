// Pure-data envelope for cross-machine pipeline export/import.
// No DB / HTTP / FS access — see spec §5 (module organization).
//
// File format: a single self-contained JSON file wrapping PipelineIR
// + prompts + provenance metadata. Versioned via the `format` literal
// so future breaking changes can be detected at parse time rather than
// silently mis-deserialized.

import { z } from "zod";

export const EXPORT_FORMAT_V1 = "wfctl-pipeline-export/v1" as const;

// Local diagnostic shape. The kernel's DiagnosticSchema enum is for
// validator/runtime errors; envelope-parsing errors are HTTP-layer
// concerns that never enter the kernel's diagnostic stream, so we use
// a narrower local type rather than bloating the central enum.
export interface EnvelopeDiagnostic {
  code: "INVALID_ENVELOPE" | "UNSUPPORTED_FORMAT";
  message: string;
  context?: Record<string, unknown>;
}

const SourceSchema = z.object({
  pipelineName: z.string().min(1),
  versionHash: z.string().min(1),
  parentHash: z.string().min(1).nullable(),
  createdAt: z.number().int().nonnegative(),
}).strict();

export const PipelineExportEnvelopeSchema = z.object({
  format: z.literal(EXPORT_FORMAT_V1),
  exportedAt: z.number().int().nonnegative(),
  source: SourceSchema,
  // Envelope-level parsing only checks the wrapper shape; full IR
  // semantic validation happens at KernelService.submit time, so
  // imports report identical diagnostics to a direct submit_pipeline
  // call. Keeping ir as `unknown` also lets envelopes round-trip
  // even if PipelineIRSchema later gains required fields.
  ir: z.unknown(),
  prompts: z.record(z.string(), z.string()),
}).strict();

export type PipelineExportEnvelope = z.infer<typeof PipelineExportEnvelopeSchema>;

export interface BuildEnvelopeArgs {
  pipelineName: string;
  versionHash: string;
  parentHash: string | null;
  createdAt: number;
  ir: unknown;
  prompts: Record<string, string>;
  now?: number;
}

export function buildEnvelope(args: BuildEnvelopeArgs): PipelineExportEnvelope {
  return {
    format: EXPORT_FORMAT_V1,
    exportedAt: args.now ?? Date.now(),
    source: {
      pipelineName: args.pipelineName,
      versionHash: args.versionHash,
      parentHash: args.parentHash,
      createdAt: args.createdAt,
    },
    ir: args.ir,
    prompts: args.prompts,
  };
}

export type ParseEnvelopeResult =
  | { ok: true; envelope: PipelineExportEnvelope }
  | { ok: false; diagnostics: EnvelopeDiagnostic[] };

export function parseEnvelope(raw: unknown): ParseEnvelopeResult {
  // Differentiate "right schema, wrong format literal" from generic
  // schema-fail so callers can tell users "this looks like a wfctl
  // export but the wrong version" vs "this isn't an export at all".
  if (
    typeof raw === "object"
    && raw !== null
    && "format" in raw
    && typeof (raw as { format: unknown }).format === "string"
    && (raw as { format: string }).format !== EXPORT_FORMAT_V1
  ) {
    return {
      ok: false,
      diagnostics: [{
        code: "UNSUPPORTED_FORMAT",
        message:
          `unsupported envelope format '${(raw as { format: string }).format}' `
          + `(expected '${EXPORT_FORMAT_V1}')`,
        context: { received: (raw as { format: string }).format },
      }],
    };
  }
  const result = PipelineExportEnvelopeSchema.safeParse(raw);
  if (result.success) return { ok: true, envelope: result.data };
  return {
    ok: false,
    diagnostics: result.error.issues.map((i) => ({
      code: "INVALID_ENVELOPE",
      message: `${i.path.join(".") || "(root)"}: ${i.message}`,
      context: { path: i.path, zodCode: i.code },
    })),
  };
}
