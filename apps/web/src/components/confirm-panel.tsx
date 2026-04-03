import { useState } from "react";
import { useTranslations } from "next-intl";
import { humanizeKey } from "@/lib/utils";
import type { OutputFieldSchema, PipelineStageSchema, PipelineStageEntry } from "@/lib/pipeline-types";
import { isPipelineParallelGroup } from "@/lib/pipeline-types";
import MarkdownBlock from "./markdown-block";

interface ConfirmPanelProps {
  stageName: string;
  store?: Record<string, any>;
  pipelineStages?: PipelineStageEntry[];
  worktreePath?: string;
  repoNameOverride: string;
  onRepoNameChange: (v: string) => void;
  feedbackText: string;
  onFeedbackChange: (v: string) => void;
  onConfirm: () => void;
  onReject: (targetStage?: string) => void;
  onRejectWithFeedback: (targetStage?: string) => void;
}

// Render a single field value based on its schema type
const FieldValue = ({ value, schema }: { value: any; schema?: OutputFieldSchema }) => {
  const t = useTranslations("Panels");
  if (value === undefined || value === null) return <span className="text-zinc-600 italic">{t("na")}</span>;
  const type = schema?.type ?? (Array.isArray(value) ? "string[]" : typeof value);

  switch (type) {
    case "string[]":
      if (!Array.isArray(value) || value.length === 0) return <span className="text-zinc-500">none</span>;
      return <span className="text-zinc-200">{value.join(", ")}</span>;
    case "boolean":
      return <span className={value ? "text-green-400" : "text-red-400"}>{value ? "Yes" : "No"}</span>;
    case "number":
      return <span className="text-zinc-200">{value}</span>;
    case "markdown":
      return <div className="mt-1 max-h-60 overflow-auto rounded bg-zinc-900/50 p-3"><MarkdownBlock content={String(value)} /></div>;
    case "object":
      if (schema?.fields?.length) {
        return (
          <div className="ml-2 border-l border-zinc-800 pl-3 space-y-1">
            {schema.fields.map((f) => (
              <div key={f.key} className="text-sm">
                <span className="text-zinc-500">{f.key}:</span>{" "}
                <FieldValue value={value?.[f.key]} schema={f} />
              </div>
            ))}
          </div>
        );
      }
      return <pre className="text-xs text-zinc-400">{JSON.stringify(value, null, 2)}</pre>;
    case "object[]":
      if (!Array.isArray(value) || value.length === 0) return <span className="text-zinc-500">none</span>;
      return (
        <div className="ml-2 space-y-2">
          {value.map((item: any, i: number) => (
            <div key={i} className="border-l border-zinc-800 pl-3 space-y-1">
              <span className="text-[10px] text-zinc-600">[{i}]</span>
              {schema?.fields?.length
                ? schema.fields.map((f) => (
                    <div key={f.key} className="text-sm">
                      <span className="text-zinc-500">{f.key}:</span>{" "}
                      <FieldValue value={item?.[f.key]} schema={f} />
                    </div>
                  ))
                : <pre className="text-xs text-zinc-400">{JSON.stringify(item, null, 2)}</pre>}
            </div>
          ))}
        </div>
      );
    default:
      return <span className="text-zinc-200">{String(value)}</span>;
  }
};

const renderStructuredFields = (outputs: Record<string, { label?: string; fields: OutputFieldSchema[] }>, store: Record<string, any>) => (
  <>
    {Object.entries(outputs).map(([storeKey, schema]) => {
      const data = store[storeKey];
      if (!data) return null;
      return (
        <div key={storeKey} className="space-y-2">
          {schema.label && (
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{schema.label}</h4>
          )}
          <div className="grid gap-1.5 text-sm">
            {schema.fields.filter((f) => f.key !== "summary").map((field) => (
              <div key={field.key}>
                <span className="text-zinc-500">{field.key}:</span>{" "}
                <FieldValue value={data[field.key]} schema={field} />
              </div>
            ))}
          </div>
        </div>
      );
    })}
  </>
);

// Collect agent stages with outputs from the immediately preceding pipeline entry.
// Uses the original PipelineStageEntry[] to correctly identify parallel group boundaries.
function findPrevAgentStages(entries: PipelineStageEntry[], currentStageName: string): PipelineStageSchema[] {
  // Find which top-level entry contains the current stage
  let currentEntryIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (isPipelineParallelGroup(entry)) {
      if (entry.parallel.stages.some((s) => s.name === currentStageName)) {
        currentEntryIdx = i;
        break;
      }
    } else if ((entry as PipelineStageSchema).name === currentStageName) {
      currentEntryIdx = i;
      break;
    }
  }
  if (currentEntryIdx <= 0) return [];

  // Walk backwards from the preceding entry to find agent stages with outputs
  for (let i = currentEntryIdx - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isPipelineParallelGroup(entry)) {
      return entry.parallel.stages.filter((s) => s.type === "agent" && s.outputs);
    }
    const stage = entry as PipelineStageSchema;
    if (stage.type === "agent" && stage.outputs) return [stage];
  }
  return [];
}

// Render store data using the output schema from the previous agent stage(s)
const SchemaRenderer = ({ store, pipelineStages, currentStageName }: {
  store: Record<string, any>;
  pipelineStages: PipelineStageEntry[];
  currentStageName: string;
}) => {
  const t = useTranslations("Panels");
  const prevStages = findPrevAgentStages(pipelineStages, currentStageName);
  if (prevStages.length === 0) return null;

  // Merge outputs from all preceding agent stages
  const mergedOutputs: Record<string, { label?: string; fields: OutputFieldSchema[] }> = {};
  for (const stage of prevStages) {
    if (stage.outputs) {
      for (const [key, schema] of Object.entries(stage.outputs)) {
        mergedOutputs[key] = schema;
      }
    }
  }

  if (Object.keys(mergedOutputs).length === 0) return null;

  // Detect if any output has a summary field
  const summaryEntries: { storeKey: string; summary: string; label?: string }[] = [];
  for (const [storeKey, schema] of Object.entries(mergedOutputs)) {
    const data = store[storeKey];
    if (!data) continue;
    const summaryField = schema.fields?.find((f) => f.key === "summary" && f.type === "markdown");
    if (summaryField && data.summary) {
      summaryEntries.push({ storeKey, summary: data.summary, label: schema.label });
    }
  }

  const hasSummary = summaryEntries.length > 0;

  return (
    <div className="space-y-2">
      {/* Render summaries prominently at top */}
      {summaryEntries.map(({ storeKey, summary, label }) => (
        <div key={`summary-${storeKey}`}>
          {label && <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">{label}</h4>}
          <MarkdownBlock content={summary} />
        </div>
      ))}

      {/* Wrap structured fields in collapsible section if summaries exist */}
      {hasSummary ? (
        <details className="mt-3">
          <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">{t("viewStructuredFields")}</summary>
          <div className="mt-2 space-y-2">
            {renderStructuredFields(mergedOutputs, store)}
          </div>
        </details>
      ) : (
        renderStructuredFields(mergedOutputs, store)
      )}
    </div>
  );
};

// Fallback renderer for pipelines without output schemas (e.g., Gemini)
const RawStorePreview = ({ store }: { store: Record<string, any> }) => {
  // Show meaningful store entries, skip internal ones
  const skipKeys = new Set(["branch", "worktreePath", "notionPageId"]);
  const entries = Object.entries(store).filter(([k]) => !skipKeys.has(k));
  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      {entries.map(([key, value]) => (
        <div key={key}>
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">{humanizeKey(key)}</h4>
          {typeof value === "object" && value !== null ? (
            <div className="grid gap-1 text-sm">
              {Object.entries(value).map(([k, v]) => (
                <div key={k}>
                  <span className="text-zinc-500">{k}:</span>{" "}
                  {Array.isArray(v) ? (
                    <span className="text-zinc-200">{v.join(", ") || "none"}</span>
                  ) : typeof v === "boolean" ? (
                    <span className={v ? "text-green-400" : "text-red-400"}>{v ? "Yes" : "No"}</span>
                  ) : (
                    <span className="text-zinc-200">{String(v)}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <span className="text-sm text-zinc-200">{String(value)}</span>
          )}
        </div>
      ))}
    </div>
  );
};

// Detect if the gate's previous entry is a parallel group and return child stage names
function findPrevParallelChildren(entries: PipelineStageEntry[], currentStageName: string): string[] {
  let idx = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isPipelineParallelGroup(e) && (e as PipelineStageSchema).name === currentStageName) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) return [];
  const prev = entries[idx - 1];
  if (isPipelineParallelGroup(prev)) {
    return prev.parallel.stages.map((s) => s.name);
  }
  return [];
}

const ConfirmPanel = ({
  stageName,
  store,
  pipelineStages,
  worktreePath,
  repoNameOverride,
  onRepoNameChange,
  feedbackText,
  onFeedbackChange,
  onConfirm,
  onReject,
  onRejectWithFeedback,
}: ConfirmPanelProps) => {
  const t = useTranslations("Panels");
  const tc = useTranslations("Common");
  const entries = pipelineStages ?? [];
  const hasStore = store && Object.keys(store).length > 0;
  const hasPrevSchema = hasStore && entries.length > 0 && findPrevAgentStages(entries, stageName).length > 0;

  const parallelChildren = findPrevParallelChildren(entries, stageName);
  const hasParallelChoice = parallelChildren.length >= 2;
  const [selectedRerunTarget, setSelectedRerunTarget] = useState<string>("");

  const handleReject = () => onReject(selectedRerunTarget || undefined);
  const handleRejectWithFeedback = () => onRejectWithFeedback(selectedRerunTarget || undefined);

  return (
    <div className="rounded-md border border-blue-800 bg-blue-900/20 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-blue-300">{humanizeKey(stageName)}</h3>

      {hasPrevSchema && (
        <SchemaRenderer store={store!} pipelineStages={entries} currentStageName={stageName} />
      )}

      {/* Fallback: show raw store data when no output schema is available */}
      {!hasPrevSchema && hasStore && (
        <RawStorePreview store={store!} />
      )}

      {worktreePath && (
        <div className="rounded bg-zinc-900/50 border border-zinc-800 px-3 py-2 text-xs">
          <span className="text-zinc-500">{t("fullSpecFiles")}</span>
          <span className="font-mono text-zinc-400 select-all">{worktreePath}/.workflow/</span>
        </div>
      )}

      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer hover:text-zinc-400">{t("overrideRepo")}</summary>
        <input
          type="text"
          value={repoNameOverride}
          onChange={(e) => onRepoNameChange(e.target.value)}
          placeholder={t("repoPlaceholder")}
          className="mt-2 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
        />
      </details>

      <textarea
        value={feedbackText}
        onChange={(e) => onFeedbackChange(e.target.value)}
        placeholder={t("feedbackPlaceholder")}
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
        rows={2}
      />

      {hasParallelChoice && (
        <div className="space-y-1">
          <label className="text-xs text-zinc-400">{t("rerunTarget")}</label>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedRerunTarget("")}
              className={`rounded border px-2.5 py-1 text-xs ${
                !selectedRerunTarget ? "border-blue-500 bg-blue-900/40 text-blue-200" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {t("rerunAll")}
            </button>
            {parallelChildren.map((child) => (
              <button
                key={child}
                onClick={() => setSelectedRerunTarget(child)}
                className={`rounded border px-2.5 py-1 text-xs ${
                  selectedRerunTarget === child ? "border-blue-500 bg-blue-900/40 text-blue-200" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {humanizeKey(child)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={onConfirm}
          className="rounded bg-green-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-600"
        >
          {tc("confirm")}
        </button>
        {feedbackText.trim() ? (
          <button onClick={handleRejectWithFeedback} className="rounded bg-blue-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600">
            {t("sendFeedbackRerun")}
          </button>
        ) : (
          <button onClick={handleReject} className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-600">
            {t("rerun")}
          </button>
        )}
      </div>
    </div>
  );
};

export default ConfirmPanel;
