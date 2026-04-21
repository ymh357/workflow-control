// Types for the legacy YAML → kernel-next IR converter.
// See docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md §5.1.

import type { PipelineIR } from "../ir/schema.js";

export type ConverterErrorCode =
  | "YAML_PARSE_ERROR"
  | "LEGACY_SCHEMA_INVALID"
  | "UNSUPPORTED_FEATURE"
  | "UNSUPPORTED_FIELD_TYPE"
  | "STORE_ENTRY_PRODUCER_MISSING"
  | "STAGE_READS_UNKNOWN_KEY"
  | "INJECTED_CONTEXT_NAME_INVALID"
  | "DUPLICATE_EXTERNAL_INPUT_NAME"
  | "EXTERNAL_INPUT_COLLIDES_WITH_STAGE"
  | "NESTED_PARALLEL_UNSUPPORTED"
  | "PARALLEL_EMPTY"
  | "PARALLEL_NAME_COLLISION"
  | "HUMAN_CONFIRM_AT_END"
  | "HUMAN_CONFIRM_NO_REJECT_TARGET"
  | "RETRY_BACK_TO_UNKNOWN"
  | "SUB_AGENT_INVALID";

export interface ConverterDiagnostic {
  code: ConverterErrorCode;
  message: string;
  context?: Record<string, unknown>;
}

export type WarningCode =
  | "LEGACY_TYPE_DOWNGRADED"
  | "INJECTED_CONTEXT_UNTYPED"
  | "EXTERNAL_INPUT_TYPE_UNKNOWN"
  | "LEGACY_FIELD_IGNORED"
  | "DISPLAY_FIELDS_IGNORED"
  | "USE_CASES_IGNORED"
  | "RETRY_BACK_TO_REDIRECTED";

export interface ConverterWarning {
  code: WarningCode;
  message: string;
  context?: Record<string, unknown>;
}

export interface ConvertOptions {
  // Absolute path of the YAML file on disk, if known. When provided,
  // ConversionResult.promptRoot is derived from it (<dir>/prompts).
  yamlFilePath?: string;
}

export type ConversionResult =
  | { ok: true; ir: PipelineIR; promptRoot?: string; warnings: ConverterWarning[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };
