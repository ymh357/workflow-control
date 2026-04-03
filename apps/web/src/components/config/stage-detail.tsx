"use client";

import React, { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import CodeEditor from "@/components/code-editor";
import type { OutputFieldSchema, StageOutputSchema } from "@/lib/pipeline-types";
import type { Stage } from "./stage-card";
import type { ValidationIssue } from "@/lib/pipeline-validator";

interface ScriptMetadata {
  id: string;
  name: string;
  description: string;
  helpMd: string;
}

interface AvailableMcp {
  name: string;
  description: string;
  available: boolean;
}

interface AvailablePipeline {
  id: string;
  name: string;
  description?: string;
  stageCount?: number;
}

interface StageDetailProps {
  stage: Stage;
  stageIndex: number;
  allStages: Stage[];
  promptContent: string | null;
  promptKey: string;
  issues: ValidationIssue[];
  scripts: ScriptMetadata[];
  systemPromptKeys: string[];
  onStageUpdate: (updates: Partial<Stage>) => void;
  onRuntimeUpdate: (updates: Record<string, unknown>) => void;
  onPromptChange: (content: string) => void;
  onPromptCreate: () => void;
  availableMcps?: AvailableMcp[];
  availablePipelines?: AvailablePipeline[];
  readOnly?: boolean;
}

function normalizePromptKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// Compute available store paths from preceding stages
function getAvailablePaths(stages: Stage[], currentIndex: number): string[] {
  const paths: string[] = [];
  for (let j = 0; j < currentIndex; j++) {
    const prev = stages[j];
    if (prev.runtime?.writes) {
      for (const w of prev.runtime.writes) {
        const outputs = prev.outputs as StageOutputSchema | undefined;
        if (outputs?.[w]?.fields) {
          for (const f of outputs[w].fields) {
            paths.push(`${w}.${f.key}`);
          }
        } else {
          paths.push(w);
        }
      }
    }
  }
  return [...new Set(paths)];
}

// --- Sub-components ---

const ReadsEditor = ({
  entries,
  availablePaths,
  onChange,
}: {
  entries: Record<string, string>;
  availablePaths: string[];
  onChange: (entries: Record<string, string>) => void;
}) => {
  const t = useTranslations("Config");
  const pairs = Object.entries(entries);

  const updateKey = (oldKey: string, newKey: string) => {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      result[k === oldKey ? newKey : k] = v;
    }
    onChange(result);
  };

  const updateValue = (currentKey: string, newValue: string) => {
    let newKey = currentKey;
    if (!currentKey || currentKey === entries[currentKey]?.split(".").pop()) {
      newKey = newValue.split(".").pop() || newValue;
    }
    let finalKey = newKey;
    let counter = 1;
    while (finalKey !== currentKey && entries[finalKey] !== undefined) {
      finalKey = `${newKey}_${counter++}`;
    }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (k === currentKey) result[finalKey] = newValue;
      else result[k] = v;
    }
    onChange(result);
  };

  const addEntry = () => {
    const firstPath = availablePaths[0] || "";
    let key = firstPath.split(".").pop() || "data";
    let counter = 1;
    while (entries[key] !== undefined) key = `${firstPath.split(".").pop() || "data"}_${counter++}`;
    onChange({ ...entries, [key]: firstPath });
  };

  const removeEntry = (key: string) => {
    const { [key]: _, ...rest } = entries;
    onChange(rest);
  };

  return (
    <div className="space-y-1.5">
      {pairs.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select
            value={v}
            onChange={(e) => updateValue(k, e.target.value)}
            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none appearance-none cursor-pointer focus:border-blue-600"
          >
            {!availablePaths.includes(v) && v && <option value={v}>{v} (custom)</option>}
            {availablePaths.map((path) => (
              <option key={path} value={path}>{path}</option>
            ))}
            {availablePaths.length === 0 && <option value="">No data available</option>}
          </select>
          <span className="text-blue-500 text-xs font-bold shrink-0">&rarr;</span>
          <input
            value={k}
            onChange={(e) => updateKey(k, e.target.value)}
            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-100 outline-none font-mono focus:border-blue-600"
            placeholder="alias"
          />
          <button type="button" onClick={() => removeEntry(k)} className="text-zinc-600 hover:text-red-400 text-xs px-1 shrink-0">x</button>
        </div>
      ))}
      <button type="button" onClick={addEntry} className="text-[11px] text-blue-400 hover:underline">
        {t("addRead")}
      </button>
    </div>
  );
};

// --- Condition Detail ---

const ConditionDetail = ({
  runtime,
  allStages,
  onChange,
  readOnly,
}: {
  runtime: Record<string, any>;
  allStages: Stage[];
  onChange: (updates: Record<string, unknown>) => void;
  readOnly?: boolean;
}) => {
  const t = useTranslations("Config");
  const branches: Array<{ when?: string; default?: true; to: string }> = runtime.branches ?? [];

  const updateBranch = (idx: number, updates: Partial<{ when?: string; default?: true; to: string }>) => {
    const next = branches.map((b, i) => i === idx ? { ...b, ...updates } : b);
    onChange({ branches: next });
  };

  const addBranch = () => {
    onChange({ branches: [...branches, { when: "store.value == true", to: "" }] });
  };

  const removeBranch = (idx: number) => {
    onChange({ branches: branches.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-3">
      <label className="text-xs font-medium text-zinc-500 block">{t("conditionBranches")}</label>
      {branches.map((branch, idx) => (
        <div key={idx} className="rounded border border-zinc-800 bg-zinc-950/50 p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={!!branch.default}
                onChange={(e) => {
                  if (e.target.checked) {
                    updateBranch(idx, { default: true, when: undefined });
                  } else {
                    const { default: _, ...rest } = branch;
                    onChange({ branches: branches.map((b, i) => i === idx ? { ...rest, when: "" } : b) });
                  }
                }}
                disabled={readOnly}
                className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-950"
              />
              {t("conditionDefault")}
            </label>
            <button
              type="button"
              onClick={() => removeBranch(idx)}
              disabled={readOnly || branches.length <= 2}
              className="ml-auto text-zinc-600 hover:text-red-400 text-xs disabled:opacity-30"
            >
              x
            </button>
          </div>
          {!branch.default && (
            <div>
              <label className="text-[11px] text-zinc-600 block mb-1">{t("conditionWhen")}</label>
              <input
                value={branch.when ?? ""}
                onChange={(e) => updateBranch(idx, { when: e.target.value })}
                readOnly={readOnly}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono outline-none focus:border-blue-600"
                placeholder="store.score > 80"
              />
            </div>
          )}
          <div>
            <label className="text-[11px] text-zinc-600 block mb-1">{t("conditionTo")}</label>
            <select
              value={branch.to}
              onChange={(e) => updateBranch(idx, { to: e.target.value })}
              disabled={readOnly}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none appearance-none cursor-pointer focus:border-blue-600"
            >
              <option value="">— select stage —</option>
              {allStages.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
              <option value="completed">completed</option>
              <option value="error">error</option>
            </select>
          </div>
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          onClick={addBranch}
          className="text-[11px] text-blue-400 hover:underline"
        >
          {t("addBranch")}
        </button>
      )}
    </div>
  );
};

// --- Pipeline Call Detail ---

const PipelineCallDetail = ({
  runtime,
  availablePipelines,
  availablePaths,
  onChange,
  readOnly,
}: {
  runtime: Record<string, any>;
  availablePipelines: AvailablePipeline[];
  availablePaths: string[];
  onChange: (updates: Record<string, unknown>) => void;
  readOnly?: boolean;
}) => {
  const t = useTranslations("Config");
  const selectedPipeline = availablePipelines.find((p) => p.id === runtime.pipeline_name);

  return (
    <div className="space-y-4">
      <Field label={t("pipelineName")}>
        <select
          value={runtime.pipeline_name ?? ""}
          onChange={(e) => onChange({ pipeline_name: e.target.value })}
          disabled={readOnly}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none cursor-pointer"
        >
          <option value="">— select pipeline —</option>
          {availablePipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id}{p.stageCount ? ` (${p.stageCount} stages)` : ""}
            </option>
          ))}
        </select>
        {selectedPipeline?.description && (
          <p className="text-[11px] text-zinc-600 mt-1">{selectedPipeline.description}</p>
        )}
      </Field>

      <Field label={t("pipelineCallReads")}>
        <ReadsEditor
          entries={(runtime.reads as Record<string, string>) || {}}
          availablePaths={availablePaths}
          onChange={(reads) => onChange({ reads })}
        />
      </Field>

      <Field label={t("pipelineCallWrites")}>
        <input
          value={(runtime.writes as string[] | undefined)?.join(", ") ?? ""}
          onChange={(e) => onChange({ writes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          readOnly={readOnly}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600"
          placeholder="review_summary, passed..."
        />
      </Field>

      <Field label={t("pipelineCallTimeout")}>
        <input
          type="number"
          value={(runtime.timeout_sec as number) ?? ""}
          onChange={(e) => onChange({ timeout_sec: e.target.value ? Number(e.target.value) : undefined })}
          readOnly={readOnly}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
          placeholder="300"
        />
      </Field>
    </div>
  );
};

// --- Foreach Detail ---

const ForeachDetail = ({
  runtime,
  availablePipelines,
  onChange,
  readOnly,
}: {
  runtime: Record<string, any>;
  availablePipelines: AvailablePipeline[];
  onChange: (updates: Record<string, unknown>) => void;
  readOnly?: boolean;
}) => {
  const t = useTranslations("Config");

  return (
    <div className="space-y-4">
      <Field label={t("foreachItems")}>
        <input
          value={runtime.items ?? ""}
          onChange={(e) => onChange({ items: e.target.value })}
          readOnly={readOnly}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600"
          placeholder="store.pr_list"
        />
      </Field>

      <Field label={t("foreachItemVar")}>
        <input
          value={runtime.item_var ?? ""}
          onChange={(e) => onChange({ item_var: e.target.value })}
          readOnly={readOnly}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600"
          placeholder="current_item"
        />
      </Field>

      <Field label={t("pipelineName")}>
        <select
          value={runtime.pipeline_name ?? ""}
          onChange={(e) => onChange({ pipeline_name: e.target.value })}
          disabled={readOnly}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none cursor-pointer"
        >
          <option value="">— select pipeline —</option>
          {availablePipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id}{p.stageCount ? ` (${p.stageCount} stages)` : ""}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("foreachMaxConcurrency")}>
          <input
            type="number"
            min={1}
            value={(runtime.max_concurrency as number) ?? ""}
            onChange={(e) => onChange({ max_concurrency: e.target.value ? Number(e.target.value) : undefined })}
            readOnly={readOnly}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
            placeholder="1"
          />
        </Field>

        <Field label={t("foreachOnItemError")}>
          <select
            value={runtime.on_item_error ?? "fail_fast"}
            onChange={(e) => onChange({ on_item_error: e.target.value })}
            disabled={readOnly}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
          >
            <option value="fail_fast">{t("foreachFailFast")}</option>
            <option value="continue">{t("foreachContinue")}</option>
          </select>
        </Field>
      </div>

      <Field label={t("foreachCollectTo")}>
        <input
          value={runtime.collect_to ?? ""}
          onChange={(e) => onChange({ collect_to: e.target.value || undefined })}
          readOnly={readOnly}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600"
          placeholder="results"
        />
      </Field>

      <Field label={t("foreachItemWrites")}>
        <input
          value={(runtime.item_writes as string[] | undefined)?.join(", ") ?? ""}
          onChange={(e) => onChange({ item_writes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          readOnly={readOnly}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600"
          placeholder="review_result, passed..."
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("foreachIsolation")}>
          <select
            value={runtime.isolation ?? "shared"}
            onChange={(e) => onChange({ isolation: e.target.value === "shared" ? undefined : e.target.value })}
            disabled={readOnly}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
          >
            <option value="shared">{t("foreachIsolationShared")}</option>
            <option value="worktree">{t("foreachIsolationWorktree")}</option>
          </select>
        </Field>

        {runtime.isolation === "worktree" && (
          <Field label={t("foreachAutoCommit")}>
            <select
              value={runtime.auto_commit === false ? "false" : "true"}
              onChange={(e) => onChange({ auto_commit: e.target.value === "true" ? undefined : false })}
              disabled={readOnly}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
            >
              <option value="true">{t("foreachAutoCommitOn")}</option>
              <option value="false">{t("foreachAutoCommitOff")}</option>
            </select>
          </Field>
        )}
      </div>
    </div>
  );
};

const OutputSchemaEditor = ({
  outputs,
  onUpdate,
}: {
  outputs: StageOutputSchema;
  onUpdate: (outputs: StageOutputSchema) => void;
}) => {
  const t = useTranslations("Config");
  return (
    <div className="space-y-4">
      {Object.entries(outputs).map(([storeKey, schema]) => (
        <div key={storeKey} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-zinc-300">{storeKey}</span>
            <input
              value={schema.label ?? ""}
              onChange={(e) => {
                const next = JSON.parse(JSON.stringify(outputs));
                next[storeKey].label = e.target.value;
                onUpdate(next);
              }}
              className="flex-1 bg-transparent border-b border-zinc-800 text-xs text-zinc-400 outline-none px-1 focus:border-blue-600"
              placeholder="Label..."
            />
            <label className="flex items-center gap-1 text-[11px] text-zinc-500 shrink-0 cursor-pointer">
              <input
                type="checkbox"
                checked={schema.hidden ?? false}
                onChange={(e) => {
                  const next = JSON.parse(JSON.stringify(outputs));
                  next[storeKey].hidden = e.target.checked;
                  onUpdate(next);
                }}
                className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-950"
              />
              {t("hidden")}
            </label>
          </div>

          {schema.fields.map((field: OutputFieldSchema, fi: number) => (
            <div key={fi} className="grid grid-cols-[1fr_auto] gap-2 p-2 rounded border border-zinc-800/50 bg-zinc-900/30">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    value={field.key}
                    onChange={(e) => {
                      const next = JSON.parse(JSON.stringify(outputs));
                      next[storeKey].fields[fi].key = e.target.value;
                      onUpdate(next);
                    }}
                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 font-mono outline-none focus:border-blue-600"
                    placeholder="key"
                  />
                  <select
                    value={field.type}
                    onChange={(e) => {
                      const next = JSON.parse(JSON.stringify(outputs));
                      next[storeKey].fields[fi].type = e.target.value;
                      onUpdate(next);
                    }}
                    className="w-24 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-400 outline-none"
                  >
                    {["string", "number", "boolean", "string[]", "object", "object[]", "markdown"].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <input
                  value={field.description}
                  onChange={(e) => {
                    const next = JSON.parse(JSON.stringify(outputs));
                    next[storeKey].fields[fi].description = e.target.value;
                    onUpdate(next);
                  }}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-400 outline-none focus:border-blue-600"
                  placeholder="Description"
                />
              </div>
              <div className="flex flex-col items-end gap-1">
                <select
                  value={field.display_hint ?? ""}
                  onChange={(e) => {
                    const next = JSON.parse(JSON.stringify(outputs));
                    next[storeKey].fields[fi].display_hint = e.target.value || undefined;
                    onUpdate(next);
                  }}
                  className="w-20 bg-zinc-950 border border-zinc-800 rounded px-1 py-1 text-[11px] text-zinc-500 outline-none"
                >
                  <option value="">none</option>
                  <option value="link">link</option>
                  <option value="badge">badge</option>
                  <option value="code">code</option>
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const next = JSON.parse(JSON.stringify(outputs));
                    next[storeKey].fields.splice(fi, 1);
                    onUpdate(next);
                  }}
                  className="text-zinc-600 hover:text-red-400 text-[11px]"
                >
                  {t("remove")}
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              const next = JSON.parse(JSON.stringify(outputs));
              next[storeKey].fields.push({ key: "", type: "string", description: "" });
              onUpdate(next);
            }}
            className="text-[11px] text-blue-400 hover:underline"
          >
            {t("addField")}
          </button>
        </div>
      ))}
    </div>
  );
};

// --- Main ---

const StageDetail = ({
  stage,
  stageIndex,
  allStages,
  promptContent,
  promptKey,
  issues,
  scripts,
  systemPromptKeys,
  onStageUpdate,
  onRuntimeUpdate,
  onPromptChange,
  onPromptCreate,
  availableMcps = [],
  availablePipelines = [],
  readOnly = false,
}: StageDetailProps) => {
  const t = useTranslations("Config");
  const defaultTab = stage.type === "agent" ? "prompt" : "config";
  const [activeTab, setActiveTab] = useState<"prompt" | "config" | "outputs">(defaultTab);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const runtime = stage.runtime || {} as NonNullable<Stage["runtime"]>;
  const availablePaths = useMemo(() => getAvailablePaths(allStages, stageIndex), [allStages, stageIndex]);
  const nextStageName = allStages[stageIndex + 1]?.name || "END";

  const fieldIssues = (field: string) => issues.filter((i) => i.field === field);

  const tabs = stage.type === "agent"
    ? [
        { key: "prompt" as const, label: t("prompt") },
        { key: "config" as const, label: t("config") },
        { key: "outputs" as const, label: t("outputs") },
      ]
    : stage.type === "script"
      ? [
          { key: "config" as const, label: t("config") },
          { key: "outputs" as const, label: t("outputs") },
        ]
      : [{ key: "config" as const, label: t("config") }];
  // condition/pipeline/foreach use single config tab (same as human_confirm)

  // Ensure active tab is valid for this stage type
  if (!tabs.some((t) => t.key === activeTab)) {
    // Will be corrected on next render
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header: stage name + tabs */}
      <div className="shrink-0 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-bold text-zinc-100">{stage.name}</span>
          <span className="text-[11px] text-zinc-500">({stage.type})</span>
        </div>
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                activeTab === tab.key
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.label}
              {tab.key === "config" && fieldIssues("reads").length + fieldIssues("writes").length > 0 && (
                <span className="ml-1 text-red-400">*</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === "prompt" && stage.type === "agent" && (
          <div className="flex flex-col h-full">
            {promptContent != null ? (
              <div className="flex-1" style={{ minHeight: 300 }}>
                <CodeEditor
                  language="markdown"
                  value={promptContent}
                  onChange={(v) => onPromptChange(v ?? "")}
                  readOnly={readOnly}
                  height="100%"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500">
                <p className="text-sm">{t("noPromptFile")}"{promptKey}"</p>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={onPromptCreate}
                    className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                  >
                    {t("createPrompt")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "config" && (
          <div className="space-y-5 pr-1">
            {/* Name */}
            <Field label={t("stageName")}>
              <input
                value={stage.name}
                onChange={(e) => onStageUpdate({ name: e.target.value })}
                readOnly={readOnly}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-blue-600"
              />
            </Field>

            {/* Type switcher */}
            <Field label={t("type")}>
              <div className="flex flex-wrap gap-1 rounded-md bg-zinc-950 p-0.5 border border-zinc-800">
                {(["agent", "human_confirm", "script", "condition", "pipeline", "foreach"] as const).map((tp) => (
                  <button
                    key={tp}
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      let newRuntime: Record<string, unknown> = {};
                      if (tp === "agent") newRuntime = { engine: "llm", system_prompt: "", writes: [] };
                      else if (tp === "script") newRuntime = { engine: "script", script_id: "", writes: [], reads: {} };
                      else if (tp === "human_confirm") newRuntime = { engine: "human_gate", on_reject_to: "error" };
                      else if (tp === "condition") newRuntime = { engine: "condition", branches: [{ when: "store.value == true", to: "" }, { default: true, to: "" }] };
                      else if (tp === "pipeline") newRuntime = { engine: "pipeline", pipeline_name: "", reads: {}, writes: [], timeout_sec: 300 };
                      else if (tp === "foreach") newRuntime = { engine: "foreach", items: "store.items", item_var: "current_item", pipeline_name: "", max_concurrency: 1, collect_to: "results", item_writes: [], on_item_error: "fail_fast" };
                      onStageUpdate({ type: tp, runtime: newRuntime as Stage["runtime"] });
                    }}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${
                      stage.type === tp ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {tp === "human_confirm" ? t("gate") : tp === "condition" ? t("condition") : tp === "pipeline" ? t("pipelineCall") : tp === "foreach" ? t("foreach") : tp}
                  </button>
                ))}
              </div>
            </Field>

            {/* Routing */}
            {stage.type === "condition" && (runtime as any)?.branches ? (
              <Field label={t("conditionRouting")}>
                <div className="space-y-1">
                  {((runtime as any).branches as Array<{ when?: string; default?: boolean; to?: string }>).map((b, bi) => (
                    <div key={bi} className="flex items-center gap-2 rounded-lg border border-yellow-900/20 bg-yellow-900/5 px-3 py-1.5 text-xs text-yellow-300/70">
                      <span className="text-yellow-500 font-bold">&rarr;</span>
                      <span className="text-zinc-400 truncate max-w-[160px]">{b.default ? t("branchDefault") : (b.when ?? "?")}</span>
                      <span className="text-zinc-600 mx-0.5">&rarr;</span>
                      <span className="font-medium text-zinc-200">{b.to ?? nextStageName}</span>
                    </div>
                  ))}
                </div>
              </Field>
            ) : (
              <Field label={t("successTarget")}>
                <div className="flex items-center gap-2 rounded-lg border border-emerald-900/20 bg-emerald-900/5 px-3 py-1.5 text-xs text-emerald-300/70">
                  <span className="text-emerald-500 font-bold">&rarr;</span>
                  <span className="font-medium text-zinc-200">{nextStageName}</span>
                </div>
              </Field>
            )}

            {stage.type === "human_confirm" && (
              <>
                <Field label={t("onReject")} issues={fieldIssues("on_reject_to")}>
                  <select
                    value={runtime.on_reject_to || "error"}
                    onChange={(e) => onRuntimeUpdate({ on_reject_to: e.target.value })}
                    disabled={readOnly}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 focus:border-red-600 outline-none appearance-none cursor-pointer"
                  >
                    <option value="error">{t("errorDefault")}</option>
                    {allStages.filter((s) => s.name !== stage.name).map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t("onApproveTo")} issues={fieldIssues("on_approve_to")}>
                  <select
                    value={runtime.on_approve_to || ""}
                    onChange={(e) => onRuntimeUpdate({ on_approve_to: e.target.value || undefined })}
                    disabled={readOnly}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none cursor-pointer"
                  >
                    <option value="">{t("nextStageDefault")}</option>
                    {allStages.filter((s) => s.name !== stage.name).map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </Field>

                <Field label={t("notify")}>
                  <div className="grid grid-cols-[auto_1fr] gap-2">
                    <select
                      value={(runtime.notify as { type?: string; template?: string } | undefined)?.type || "slack"}
                      onChange={(e) => onRuntimeUpdate({ notify: { ...(runtime.notify as Record<string, unknown> || {}), type: e.target.value } })}
                      disabled={readOnly}
                      className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
                    >
                      <option value="slack">slack</option>
                    </select>
                    <input
                      value={(runtime.notify as { type?: string; template?: string } | undefined)?.template || ""}
                      onChange={(e) => onRuntimeUpdate({ notify: { ...(runtime.notify as Record<string, unknown> || {}), type: (runtime.notify as { type?: string } | undefined)?.type || "slack", template: e.target.value || undefined } })}
                      readOnly={readOnly}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                      placeholder={t("notifyTemplatePlaceholder")}
                    />
                  </div>
                </Field>

                <Field label={t("maxFeedbackLoops")}>
                  <input
                    type="number"
                    value={(runtime.max_feedback_loops as number) ?? ""}
                    onChange={(e) => onRuntimeUpdate({ max_feedback_loops: e.target.value ? Number(e.target.value) : undefined })}
                    readOnly={readOnly}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                  />
                </Field>
              </>
            )}

            {stage.type !== "human_confirm" && (
              <Field label={t("retryBackTo")} issues={fieldIssues("retry")}>
                <select
                  value={runtime.retry?.back_to || ""}
                  onChange={(e) => onRuntimeUpdate({ retry: { ...runtime.retry, back_to: e.target.value || undefined } })}
                  disabled={readOnly}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none cursor-pointer"
                >
                  <option value="">{t("noRetry")}</option>
                  {allStages.filter((s) => s.name !== stage.name).map((s) => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </Field>
            )}

            {/* Agent-specific config */}
            {stage.type === "agent" && (
              <>
                <Field label={t("systemPromptId")} issues={fieldIssues("system_prompt")}>
                  <select
                    value={runtime.system_prompt || ""}
                    onChange={(e) => onRuntimeUpdate({ system_prompt: e.target.value })}
                    disabled={readOnly}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
                  >
                    {systemPromptKeys.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                    {runtime.system_prompt && !systemPromptKeys.includes(runtime.system_prompt as string) && (
                      <option value={runtime.system_prompt as string}>{runtime.system_prompt} (custom)</option>
                    )}
                  </select>
                </Field>

                <Field label={t("writes")} issues={fieldIssues("writes")}>
                  <input
                    value={(runtime.writes as string[] | undefined)?.join(", ") ?? ""}
                    onChange={(e) => {
                      const writes = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                      onRuntimeUpdate({ writes });
                    }}
                    readOnly={readOnly}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600"
                    placeholder="analysis, techContext..."
                  />
                </Field>

                <Field label={t("reads")} issues={fieldIssues("reads")}>
                  <ReadsEditor
                    entries={(runtime.reads as Record<string, string>) || {}}
                    availablePaths={availablePaths}
                    onChange={(reads) => onRuntimeUpdate({ reads })}
                  />
                </Field>

                <div className="grid grid-cols-3 gap-3">
                  <Field label={t("maxTurns")}>
                    <input
                      type="number"
                      value={stage.max_turns ?? ""}
                      onChange={(e) => onStageUpdate({ max_turns: e.target.value ? Number(e.target.value) : undefined })}
                      readOnly={readOnly}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                    />
                  </Field>
                  <Field label={t("budgetLabel")}>
                    <input
                      type="number"
                      step="0.5"
                      value={stage.max_budget_usd ?? ""}
                      onChange={(e) => onStageUpdate({ max_budget_usd: e.target.value ? Number(e.target.value) : undefined })}
                      readOnly={readOnly}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                    />
                  </Field>
                  <Field label={t("effort")}>
                    <select
                      value={stage.effort ?? ""}
                      onChange={(e) => onStageUpdate({ effort: (e.target.value || undefined) as Stage["effort"] })}
                      disabled={readOnly}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
                    >
                      <option value="">default</option>
                      {["low", "medium", "high", "max"].map((e) => (
                        <option key={e} value={e}>{e}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field label={t("mcps")}>
                  {availableMcps.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {availableMcps.map((mcp) => {
                        const selected = stage.mcps?.includes(mcp.name) ?? false;
                        return (
                          <button
                            key={mcp.name}
                            type="button"
                            disabled={readOnly}
                            title={mcp.description || mcp.name}
                            onClick={() => {
                              const current = stage.mcps ?? [];
                              const next = selected
                                ? current.filter((m) => m !== mcp.name)
                                : [...current, mcp.name];
                              onStageUpdate({ mcps: next.length > 0 ? next : undefined });
                            }}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                              selected
                                ? "bg-blue-900/40 border-blue-700 text-blue-300"
                                : mcp.available
                                  ? "bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                                  : "bg-zinc-950 border-zinc-800/50 text-zinc-600 hover:border-zinc-700"
                            }`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${
                              selected ? "bg-blue-400" : mcp.available ? "bg-emerald-500" : "bg-zinc-600"
                            }`} />
                            {mcp.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <input
                      value={stage.mcps?.join(", ") ?? ""}
                      onChange={(e) => onStageUpdate({ mcps: e.target.value ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined })}
                      readOnly={readOnly}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                      placeholder="e.g. notion, figma, context7"
                    />
                  )}
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("stageEngine")}>
                    <div className="flex gap-1">
                      {(["claude", "gemini", "inherit"] as const).map((eng) => (
                        <button
                          key={eng}
                          type="button"
                          disabled={readOnly}
                          onClick={() => onStageUpdate({ engine: eng === "inherit" ? undefined : eng })}
                          className={`px-2.5 py-1.5 text-[11px] font-medium rounded transition-all ${
                            (stage.engine as string || "inherit") === (eng === "inherit" ? "inherit" : eng)
                              ? eng === "claude"
                                ? "bg-blue-900/30 text-blue-400 border border-blue-800/50"
                                : eng === "gemini"
                                  ? "bg-purple-900/30 text-purple-400 border border-purple-800/50"
                                  : "bg-zinc-800 text-zinc-300 border border-zinc-700"
                              : "text-zinc-600 border border-zinc-800 hover:text-zinc-400"
                          }`}
                        >
                          {eng === "inherit" ? t("stageEngineInherit") : eng}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label={t("executionMode")}>
                    <div className="flex gap-1">
                      {(["auto", "edge"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          disabled={readOnly}
                          onClick={() => onStageUpdate({ execution_mode: mode })}
                          className={`px-2.5 py-1.5 text-[11px] font-medium rounded transition-all ${
                            (stage.execution_mode as string || "auto") === mode
                              ? "bg-blue-900/30 text-blue-400 border border-blue-800/50"
                              : "text-zinc-600 border border-zinc-800 hover:text-zinc-400"
                          }`}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </Field>
                </div>
                <Field label={t("stageModel")}>
                  <input
                    value={(stage.model as string) || ""}
                    onChange={(e) => onStageUpdate({ model: e.target.value || undefined })}
                    readOnly={readOnly}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                    placeholder={t("stageModelPlaceholder")}
                  />
                </Field>

                {/* Advanced section */}
                <div className="border-t border-zinc-800 pt-3 mt-2">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-600 hover:text-zinc-400 transition-colors"
                  >
                    <svg className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    {t("advanced")}
                  </button>
                  {showAdvanced && (
                    <div className="space-y-4 mt-3">
                      <div className="grid grid-cols-3 gap-3">
                        <Field label={t("thinking")}>
                          <div className="flex gap-1">
                            {(["enabled", "disabled"] as const).map((val) => (
                              <button
                                key={val}
                                type="button"
                                disabled={readOnly}
                                onClick={() => onStageUpdate({ thinking: val === "enabled" ? { type: "enabled" } : undefined })}
                                className={`px-2 py-1 text-[11px] font-medium rounded transition-all ${
                                  (val === "enabled" ? !!(stage.thinking as Record<string, unknown>) : !(stage.thinking as Record<string, unknown>))
                                    ? "bg-blue-900/30 text-blue-400 border border-blue-800/50"
                                    : "text-zinc-600 border border-zinc-800 hover:text-zinc-400"
                                }`}
                              >
                                {t(val === "enabled" ? "thinkingEnabled" : "thinkingDisabled")}
                              </button>
                            ))}
                          </div>
                        </Field>
                        <Field label={t("permissionMode")}>
                          <select
                            value={(stage.permission_mode as string) || "default"}
                            onChange={(e) => onStageUpdate({ permission_mode: e.target.value === "default" ? undefined : e.target.value })}
                            disabled={readOnly}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
                          >
                            {(["default", "bypassPermissions", "acceptEdits", "plan", "dontAsk"] as const).map((pm) => (
                              <option key={pm} value={pm}>{pm}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t("debug")}>
                          <label className="flex items-center gap-2 cursor-pointer py-1">
                            <input
                              type="checkbox"
                              checked={!!(stage.debug as boolean)}
                              onChange={(e) => onStageUpdate({ debug: e.target.checked || undefined })}
                              disabled={readOnly}
                              className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-950"
                            />
                            <span className="text-xs text-zinc-400">{t("debug")}</span>
                          </label>
                        </Field>
                      </div>

                      <Field label={t("disallowedTools")}>
                        <input
                          value={(stage.disallowed_tools as string[] | undefined)?.join(", ") ?? ""}
                          onChange={(e) => onStageUpdate({ disallowed_tools: e.target.value ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined })}
                          readOnly={readOnly}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                          placeholder={t("disallowedToolsPlaceholder")}
                        />
                      </Field>

                      <Field label={t("availableSteps")}>
                        <div className="space-y-1.5">
                          {((stage.available_steps as Array<{ key: string; label: string }>) || []).map((step, si) => (
                            <div key={si} className="flex items-center gap-1.5">
                              <input
                                value={step.key}
                                onChange={(e) => {
                                  const steps = [...((stage.available_steps as Array<{ key: string; label: string }>) || [])];
                                  steps[si] = { ...steps[si], key: e.target.value };
                                  onStageUpdate({ available_steps: steps });
                                }}
                                readOnly={readOnly}
                                className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono outline-none focus:border-blue-600"
                                placeholder={t("stepKey")}
                              />
                              <input
                                value={step.label}
                                onChange={(e) => {
                                  const steps = [...((stage.available_steps as Array<{ key: string; label: string }>) || [])];
                                  steps[si] = { ...steps[si], label: e.target.value };
                                  onStageUpdate({ available_steps: steps });
                                }}
                                readOnly={readOnly}
                                className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                                placeholder={t("stepLabel")}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const steps = [...((stage.available_steps as Array<{ key: string; label: string }>) || [])];
                                  steps.splice(si, 1);
                                  onStageUpdate({ available_steps: steps.length > 0 ? steps : undefined });
                                }}
                                className="text-zinc-600 hover:text-red-400 text-xs px-1 shrink-0"
                              >
                                x
                              </button>
                            </div>
                          ))}
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => {
                                const steps = [...((stage.available_steps as Array<{ key: string; label: string }>) || [])];
                                steps.push({ key: "", label: "" });
                                onStageUpdate({ available_steps: steps });
                              }}
                              className="text-[11px] text-blue-400 hover:underline"
                            >
                              {t("addStep")}
                            </button>
                          )}
                        </div>
                      </Field>

                      <Field label={t("enabledStepsPath")}>
                        <input
                          value={(stage.enabled_steps_path as string) || ""}
                          onChange={(e) => onStageUpdate({ enabled_steps_path: e.target.value || undefined })}
                          readOnly={readOnly}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                          placeholder={t("enabledStepsPathPlaceholder")}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Condition-specific config */}
            {stage.type === "condition" && (
              <ConditionDetail
                runtime={runtime as Record<string, any>}
                allStages={allStages}
                onChange={onRuntimeUpdate}
                readOnly={readOnly}
              />
            )}

            {/* Pipeline Call-specific config */}
            {stage.type === "pipeline" && (
              <PipelineCallDetail
                runtime={runtime as Record<string, any>}
                availablePipelines={availablePipelines}
                availablePaths={availablePaths}
                onChange={onRuntimeUpdate}
                readOnly={readOnly}
              />
            )}

            {/* Foreach-specific config */}
            {stage.type === "foreach" && (
              <ForeachDetail
                runtime={runtime as Record<string, any>}
                availablePipelines={availablePipelines}
                onChange={onRuntimeUpdate}
                readOnly={readOnly}
              />
            )}

            {/* Script-specific config */}
            {stage.type === "script" && (
              <>
                <Field label={t("scriptId")}>
                  <div className="flex gap-2">
                    <select
                      value={(runtime.script_id as string) || ""}
                      onChange={(e) => onRuntimeUpdate({ script_id: e.target.value })}
                      disabled={readOnly}
                      className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 outline-none appearance-none"
                    >
                      {scripts.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                      {runtime.script_id && !scripts.some((s) => s.id === runtime.script_id) && (
                        <option value={runtime.script_id as string}>{runtime.script_id} (custom)</option>
                      )}
                    </select>
                  </div>
                </Field>

                <Field label={t("writes")}>
                  <input
                    value={(runtime.writes as string[] | undefined)?.join(", ") ?? ""}
                    onChange={(e) => {
                      const writes = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                      onRuntimeUpdate({ writes });
                    }}
                    readOnly={readOnly}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600"
                    placeholder="branch, worktreePath..."
                  />
                </Field>

                <Field label={t("reads")} issues={fieldIssues("reads")}>
                  <ReadsEditor
                    entries={(runtime.reads as Record<string, string>) || {}}
                    availablePaths={availablePaths}
                    onChange={(reads) => onRuntimeUpdate({ reads })}
                  />
                </Field>

                <Field label={t("args")}>
                  <textarea
                    value={(() => {
                      const args = runtime.args as Record<string, unknown> | undefined;
                      return args ? JSON.stringify(args, null, 2) : "";
                    })()}
                    onChange={(e) => {
                      try {
                        const parsed = e.target.value ? JSON.parse(e.target.value) : undefined;
                        onRuntimeUpdate({ args: parsed });
                      } catch {
                        // Ignore parse errors during editing
                      }
                    }}
                    readOnly={readOnly}
                    rows={3}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-blue-600 resize-none"
                    placeholder={t("argsPlaceholder")}
                  />
                </Field>

                <Field label={t("timeoutSec")}>
                  <input
                    type="number"
                    value={(runtime.timeout_sec as number) ?? ""}
                    onChange={(e) => onRuntimeUpdate({ timeout_sec: e.target.value ? Number(e.target.value) : undefined })}
                    readOnly={readOnly}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-blue-600"
                  />
                </Field>
              </>
            )}
          </div>
        )}

        {activeTab === "outputs" && (
          <div className="space-y-4 pr-1">
            {stage.outputs && Object.keys(stage.outputs).length > 0 ? (
              <OutputSchemaEditor
                outputs={stage.outputs as StageOutputSchema}
                onUpdate={(outputs) => onStageUpdate({ outputs })}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-zinc-500">
                <p className="text-sm">{t("noOutputSchema")}</p>
                {!readOnly && runtime.writes && (runtime.writes as string[]).length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const outputs: StageOutputSchema = {};
                      for (const w of runtime.writes as string[]) {
                        outputs[w] = {
                          type: "object",
                          label: w,
                          fields: [{ key: "summary", type: "markdown", description: "Summary of results" }],
                        };
                      }
                      onStageUpdate({ outputs });
                    }}
                    className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                  >
                    {t("generateFromWrites")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// --- Helpers ---

const Field = ({
  label,
  children,
  issues,
}: {
  label: string;
  children: React.ReactNode;
  issues?: ValidationIssue[];
}) => (
  <div className="space-y-1">
    <label className="text-xs font-medium text-zinc-500 block">{label}</label>
    {children}
    {issues && issues.length > 0 && (
      <div className="space-y-0.5">
        {issues.map((issue, i) => (
          <p key={i} className={`text-[11px] ${issue.severity === "error" ? "text-red-400" : "text-amber-400"}`}>
            {issue.message}
          </p>
        ))}
      </div>
    )}
  </div>
);

export default StageDetail;
