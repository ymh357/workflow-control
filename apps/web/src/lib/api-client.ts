// Centralized API client for kernel-next REST endpoints. Returns the
// standard {ok:true,...} | {ok:false,diagnostics:[]} envelope shape so
// callers branch on the same field across the whole app instead of
// duplicating fetch error handling everywhere.
//
// 2026-04-27 B5/B9: replaces ad-hoc fetch+JSON.parse blocks in pages
// with one helper that:
//   - injects API_BASE
//   - parses JSON safely
//   - normalizes network errors and non-2xx responses into the same
//     diagnostic shape so a unified <ErrorBanner> can render them
//   - never throws (callers don't have to wrap in try/catch).

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface ApiDiagnostic {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; diagnostics: ApiDiagnostic[] };

interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export const apiFetch = async <T = unknown>(
  path: string,
  options: ApiOptions = {},
): Promise<ApiResult<T>> => {
  const { method = "GET", body, signal, headers } = options;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 0, diagnostics: [{ code: "ABORTED", message: "request aborted" }] };
    }
    return {
      ok: false,
      status: 0,
      diagnostics: [{
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      }],
    };
  }

  // Try to parse the body even on error; the kernel-next envelope always
  // sends JSON for both 2xx and 4xx/5xx responses.
  let parsed: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try { parsed = JSON.parse(text); }
    catch {
      return {
        ok: false,
        status: res.status,
        diagnostics: [{
          code: "INVALID_RESPONSE",
          message: `non-JSON response (HTTP ${res.status})`,
          context: { preview: text.slice(0, 200) },
        }],
      };
    }
  }

  // Normalize the envelope. Successful endpoints sometimes omit `ok` and
  // return raw data (e.g. /kernel/tasks/:id/status), so we treat 2xx as
  // ok regardless and 4xx/5xx as failed unless the body says otherwise.
  if (res.ok) {
    if (parsed !== null && typeof parsed === "object" && "ok" in parsed && (parsed as { ok: boolean }).ok === false) {
      return {
        ok: false,
        status: res.status,
        diagnostics: ((parsed as { diagnostics?: ApiDiagnostic[] }).diagnostics ?? [{
          code: "UNKNOWN_ERROR",
          message: `HTTP ${res.status} but body says ok:false`,
        }]),
      };
    }
    return { ok: true, status: res.status, data: parsed as T };
  }

  // Non-2xx — extract diagnostics if present, else synthesize one.
  if (
    parsed !== null
    && typeof parsed === "object"
    && "diagnostics" in parsed
    && Array.isArray((parsed as { diagnostics?: unknown[] }).diagnostics)
  ) {
    return {
      ok: false,
      status: res.status,
      diagnostics: (parsed as { diagnostics: ApiDiagnostic[] }).diagnostics,
    };
  }
  return {
    ok: false,
    status: res.status,
    diagnostics: [{
      code: `HTTP_${res.status}`,
      message: `HTTP ${res.status}`,
      context: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined,
    }],
  };
};

/**
 * Map well-known diagnostic codes to actionable hints. Used by
 * <ErrorBanner> so users see "next step" guidance instead of bare
 * codes like NO_PENDING_SECRET_GATE. Keep this list updated when new
 * codes are added in apps/server/src/kernel-next/ir/schema.ts.
 */
export const diagnosticHint = (code: string): string | null => {
  switch (code) {
    case "TASK_NOT_FOUND":
      return "This task does not exist or was archived. Refresh the task list.";
    case "TASK_ALREADY_TERMINAL":
      return "The task already finished — cancel/retry has no effect.";
    case "NO_PENDING_SECRET_GATE":
      return "There is no pending secret-gate for this task. The task may have already resumed.";
    case "SECRET_KEY_NOT_REQUIRED":
      return "Check the key spelling against the pipeline's required envKeys, or the value is empty.";
    case "MIGRATION_IN_PROGRESS":
      return "Another migrate is already running. Wait a few seconds and try again.";
    case "PROPOSAL_NOT_FOUND":
      return "The proposal was deleted or its base version no longer exists.";
    case "PROPOSAL_ALREADY_RESOLVED":
      return "This proposal was already approved or rejected.";
    case "GATE_ALREADY_ANSWERED":
      return "Someone else (another tab or MCP) already answered this gate.";
    case "GATE_ANSWER_INVALID":
      return "The answer must match one of the gate's declared options.";
    case "WIRE_TYPE_MISMATCH":
      return "Open the attempt detail and look for the type-checker stderr to find the offending wire.";
    case "MCP_ENV_MISSING":
      return "Provide the missing secrets via the secret-gate panel on the task detail page.";
    case "PATCH_APPLY_ERROR":
      return "The pipeline IR may have been deleted. Re-submit the proposal against the current latest version.";
    case "VERSION_NOT_IN_HISTORY":
      return "This task never migrated through the requested version. Choose a version from its actual history.";
    case "NETWORK_ERROR":
      return "Check that the kernel-next server is running on the configured port.";
    default:
      return null;
  }
};
