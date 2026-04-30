"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../lib/api-client";
import { useToast } from "./toast";
import { ErrorBanner } from "./error-banner";
import { StructuredInput } from "./structured-input";
import { parseObjectType } from "../lib/parse-ts-object-type";
import type { ApiDiagnostic } from "../lib/api-client";
import { InventoryBanner } from "./inventory-banner";

interface PortLike {
  name: string;
  type: string;
}

interface LaunchPipelineDialogProps {
  open: boolean;
  onClose: () => void;
  pipeline: {
    name: string;
    latestVersion: string;
    externalInputs: PortLike[];
    envKeys: string[];
  };
}

/**
 * Modal launcher for a single pipeline. Renders a typed input form for
 * every externalInput (string → text, number → number, object/array →
 * JSON textarea), a section for envValues (one password input per
 * envKey), and runtime overrides (model / maxTurns / maxBudgetUsd).
 *
 * On submit:
 *   POST /api/kernel/tasks/run
 *     { pipeline, seedValues, envValues, model?, maxTurns?, maxBudgetUsd? }
 *
 * Successful launch toasts and navigates to /kernel-next/<taskId>.
 * Errors render via <ErrorBanner> with full diagnostic detail.
 *
 * 2026-04-27 B2.
 */
export const LaunchPipelineDialog = ({
  open,
  onClose,
  pipeline,
}: LaunchPipelineDialogProps) => {
  const router = useRouter();
  const toast = useToast();
  const [seedValues, setSeedValues] = useState<Record<string, string>>({});
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [model, setModel] = useState<string>("");
  const [maxTurns, setMaxTurns] = useState<string>("");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostic[]>([]);

  const [envProbe, setEnvProbe] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) {
      setSeedValues({});
      setEnvValues({});
      setModel("");
      setMaxTurns("");
      setMaxBudgetUsd("");
      setSubmitting(false);
      setDiagnostics([]);
      setEnvProbe({});
      // Probe which envKeys are already visible in process.env so the
      // form can mark them "in env" and the user can leave those blank.
      if (pipeline.envKeys.length > 0) {
        void apiFetch<{ status: Record<string, boolean> }>(
          "/api/kernel/pipelines/env-probe",
          { method: "POST", body: { envKeys: pipeline.envKeys } },
        ).then((r) => {
          if (r.ok) setEnvProbe(r.data.status);
        });
      }
    }
  }, [open, pipeline.envKeys]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const parseSeedValue = (type: string, raw: string): unknown => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const t = type.trim();
    if (t === "number") return Number(trimmed);
    if (t === "boolean") return trimmed === "true";
    if (t === "string") return raw;
    // For object / array / unknown — parse as JSON (fallback to string).
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setDiagnostics([]);

    const seed: Record<string, unknown> = {};
    for (const p of pipeline.externalInputs) {
      const raw = seedValues[p.name];
      if (raw === undefined || raw.trim().length === 0) continue;
      seed[p.name] = parseSeedValue(p.type, raw);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envValues)) {
      if (v.length > 0) env[k] = v;
    }

    interface Payload {
      pipeline: string;
      seedValues?: Record<string, unknown>;
      envValues?: Record<string, string>;
      model?: string;
      maxTurns?: number;
      maxBudgetUsd?: number;
    }
    const payload: Payload = { pipeline: pipeline.name };
    if (Object.keys(seed).length > 0) payload.seedValues = seed;
    if (Object.keys(env).length > 0) payload.envValues = env;
    if (model.trim().length > 0) payload.model = model.trim();
    if (maxTurns.trim().length > 0) payload.maxTurns = Number(maxTurns);
    if (maxBudgetUsd.trim().length > 0) payload.maxBudgetUsd = Number(maxBudgetUsd);

    const res = await apiFetch<{
      taskId: string;
      versionHash: string;
      // C10 Bug F2 (2026-04-30): server returns these when stage MCPs
      // declare envKeys not satisfied by envValues + process.env. The
      // task is created either way (secret_pending pauses the affected
      // stages at runtime); surfacing them at launch lets the user
      // supply secrets via the secret-gate panel before any stage
      // wastes turns.
      missingEnvKeys?: string[];
      hint?: string;
    }>(
      "/api/kernel/tasks/run",
      { method: "POST", body: payload },
    );
    setSubmitting(false);
    if (!res.ok) {
      setDiagnostics(res.diagnostics);
      return;
    }
    if (res.data.missingEnvKeys && res.data.missingEnvKeys.length > 0) {
      // Info toast — task is live, user can recover via the secret
      // panel on the task detail page. Not an error: secret_pending
      // pauses gracefully and is resolvable.
      toast.info(
        `Launched ${pipeline.name} — ${res.data.missingEnvKeys.length} envKey(s) missing ` +
        `(${res.data.missingEnvKeys.join(", ")}). Provide via the secret panel on the next page.`,
      );
    } else {
      toast.success(`Launched ${pipeline.name}`);
    }
    onClose();
    router.push(`/kernel-next/${encodeURIComponent(res.data.taskId)}`);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="launch-dialog-title"
      className="fixed inset-0 z-[10000] flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-12"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-strong bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between border-b border-default px-5 py-3">
          <div>
            <h2 id="launch-dialog-title" className="text-base font-semibold text-primary">
              Launch <span className="font-mono text-accent">{pipeline.name}</span>
            </h2>
            <p className="mt-0.5 font-mono text-xs text-muted">
              {pipeline.latestVersion.slice(0, 12)}…
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="rounded text-secondary hover:text-primary disabled:opacity-50"
          >
            ✕
          </button>
        </header>

        <form onSubmit={onSubmit} className="space-y-5 p-5">
          {pipeline.externalInputs.length === 0 ? (
            <p className="text-sm text-muted">
              This pipeline has no external inputs.
            </p>
          ) : (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
                Inputs
              </h3>
              <div className="space-y-3">
                {pipeline.externalInputs.map((p) => {
                  // 2026-04-27: parse the TS-style type and use a structured
                  // form when we recognize the shape; otherwise fall back to
                  // a JSON textarea (StructuredInput handles both internally).
                  const parsed = parseObjectType(p.type);
                  const isStructurable = parsed.kind === "object" || parsed.kind === "primitive-array";
                  const isPrimitive = parsed.kind === "primitive";
                  return (
                    <div key={p.name}>
                      <label className="block text-sm">
                        <span className="font-mono text-primary">{p.name}</span>
                        <span className="ml-2 font-mono text-xs text-muted">{p.type}</span>
                      </label>
                      {isStructurable ? (
                        <StructuredInput
                          typeStr={p.type}
                          value={seedValues[p.name] ?? ""}
                          onChange={(next) =>
                            setSeedValues((prev) => ({ ...prev, [p.name]: next }))
                          }
                        />
                      ) : isPrimitive ? (
                        <input
                          type={p.type === "number" ? "number" : "text"}
                          value={seedValues[p.name] ?? ""}
                          onChange={(e) =>
                            setSeedValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                          }
                          className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-strong focus:outline-none"
                        />
                      ) : (
                        <textarea
                          value={seedValues[p.name] ?? ""}
                          onChange={(e) =>
                            setSeedValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                          }
                          placeholder="JSON value"
                          rows={3}
                          className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 font-mono text-xs text-primary placeholder:text-muted focus:border-strong focus:outline-none"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {pipeline.envKeys.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-secondary">
                Secrets
              </h3>
              <InventoryBanner envKeys={pipeline.envKeys} layout="full" />
              <p className="mb-2 text-xs text-muted">
                Required by this pipeline&rsquo;s MCP servers. Values are
                forwarded to the kernel via <code className="font-mono">envValues</code> and
                never enter the agent prompt context.
              </p>
              <div className="space-y-2">
                {pipeline.envKeys.map((k) => {
                  const inEnv = envProbe[k] === true;
                  return (
                    <label key={k} className="block text-sm">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-xs text-secondary">{k}</span>
                        {inEnv && (
                          <span
                            className="rounded border border-success-border bg-success-bg px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-success-fg"
                            title="Already visible in server process.env — leave blank to use that value"
                          >
                            in env
                          </span>
                        )}
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={envValues[k] ?? ""}
                        onChange={(e) =>
                          setEnvValues((prev) => ({ ...prev, [k]: e.target.value }))
                        }
                        className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 font-mono text-xs text-primary placeholder:text-muted focus:border-strong focus:outline-none"
                        placeholder={inEnv ? "(leave empty — using process.env)" : "(leave empty to use process.env)"}
                      />
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
              Runtime overrides (optional)
            </h3>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <label className="block">
                <span className="text-xs text-secondary">model</span>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="claude-haiku-4-5"
                  className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 font-mono text-xs text-primary focus:border-strong focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-secondary">maxTurns</span>
                <input
                  type="number"
                  min={1}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  placeholder="10"
                  className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 text-xs text-primary focus:border-strong focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-secondary">maxBudgetUsd</span>
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  value={maxBudgetUsd}
                  onChange={(e) => setMaxBudgetUsd(e.target.value)}
                  placeholder="0.20"
                  className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 text-xs text-primary focus:border-strong focus:outline-none"
                />
              </label>
            </div>
          </section>

          {diagnostics.length > 0 && <ErrorBanner diagnostics={diagnostics} />}

          <div className="flex justify-end gap-2 border-t border-default pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded border border-strong bg-elevated px-3 py-1.5 text-sm text-primary hover:border-strong hover:bg-elevated disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {submitting ? "Launching…" : "Launch"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
