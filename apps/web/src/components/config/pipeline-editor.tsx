"use client";

import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import StageCard, { ParallelGroupCard, isParallelGroup, flattenStageEntries } from "./stage-card";
import type { StageEntry, ParallelGroup } from "./stage-card";
import StageDetail from "./stage-detail";
import GlobalEditor from "./global-editor";
import ValidationBar from "./validation-bar";
import PipelineVisualizer from "./pipeline-visualizer";
import type { PipelineFlowGraphHandle } from "./pipeline-visualizer";
import CodeEditor from "@/components/code-editor";
import type { FragmentMeta, StageOutputSchema, PipelineStageEntry } from "@/lib/pipeline-types";
import type { Stage } from "./stage-card";
import { validatePipeline, getStageIssues } from "@/lib/pipeline-validator";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

// --- Types ---

interface PipelineMeta {
  description?: string;
  use_cases?: string[];
  default_execution_mode?: "auto" | "edge";
  hooks?: string[];
  skills?: string[];
  claude_md?: { global?: string };
  display?: { title_path?: string; completion_summary_path?: string };
  integrations?: { notion_page_id_path?: string };
}

interface ScriptMetadata {
  id: string;
  name: string;
  description: string;
  helpMd: string;
}

type LeftSelection =
  | { type: "stage"; index: number }
  | { type: "parallelChild"; groupIndex: number; childIndex: number }
  | { type: "constraints" }
  | { type: "claudeMd" }
  | { type: "geminiMd" }
  | { type: "codexMd" }
  | { type: "fragments" }
  | { type: "yaml" }
  | { type: "visualizer" };

interface PipelineEditorConfig {
  pipelineName?: string;
  pipeline: { stages: StageEntry[]; engine?: string; [key: string]: unknown };
  prompts: {
    system: Record<string, string>;
    fragments: Record<string, string>;
    fragmentMeta?: Record<string, FragmentMeta>;
    globalConstraints: string;
    globalClaudeMd: string;
    globalGeminiMd?: string;
    globalCodexMd?: string;
  };
  _deletedFragments?: string[];
  _deletedPrompts?: string[];
}

export interface AvailableMcp {
  name: string;
  description: string;
  available: boolean;
}

export interface PipelineEditorProps {
  config: PipelineEditorConfig;
  readOnly?: boolean;
  onSave: (config: PipelineEditorConfig) => Promise<void>;
  availableMcps?: AvailableMcp[];
}

const RUNTIME_TEMPLATES = [
  {
    label: "AI Agent",
    type: "agent" as const,
    defaults: { max_turns: 30, max_budget_usd: 2, runtime: { engine: "llm" as const, system_prompt: "", writes: [], reads: {} } },
  },
  {
    label: "Automation Script",
    type: "script" as const,
    defaults: { runtime: { engine: "script" as const, script_id: "", writes: [], reads: {} } },
  },
  {
    label: "Human Gate",
    type: "human_confirm" as const,
    defaults: { runtime: { engine: "human_gate" as const, on_reject_to: "error" } },
  },
  {
    label: "Parallel Group",
    type: "parallel" as const,
    defaults: {},
  },
  {
    label: "Condition",
    type: "condition" as const,
    defaults: {
      runtime: {
        engine: "condition" as const,
        branches: [
          { when: "store.value == true", to: "" },
          { default: true, to: "" },
        ],
      },
    },
  },
  {
    label: "Pipeline Call",
    type: "pipeline" as const,
    defaults: {
      runtime: {
        engine: "pipeline" as const,
        pipeline_name: "",
        reads: {},
        writes: [],
        timeout_sec: 300,
      },
    },
  },
  {
    label: "Foreach",
    type: "foreach" as const,
    defaults: {
      runtime: {
        engine: "foreach" as const,
        items: "store.items",
        item_var: "current_item",
        pipeline_name: "",
        max_concurrency: 1,
        collect_to: "results",
        item_writes: [],
        on_item_error: "fail_fast" as const,
      },
    },
  },
];

function normalizePromptKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function getPromptKeyForStage(stage: Stage): string {
  return (stage.runtime?.system_prompt as string) || stage.name;
}

function findPromptContent(prompts: Record<string, string>, promptRef: string): string | null {
  const normalized = normalizePromptKey(promptRef);
  for (const [k, v] of Object.entries(prompts)) {
    if (normalizePromptKey(k) === normalized) return v;
  }
  return null;
}

function findPromptKey(prompts: Record<string, string>, promptRef: string): string | null {
  const normalized = normalizePromptKey(promptRef);
  for (const k of Object.keys(prompts)) {
    if (normalizePromptKey(k) === normalized) return k;
  }
  return null;
}

// --- Parallel Group Detail ---

const ParallelGroupDetail = ({
  group,
  issues,
  onNameChange,
  onDissolve,
  readOnly,
}: {
  group: ParallelGroup;
  issues: import("@/lib/pipeline-validator").ValidationIssue[];
  onNameChange: (name: string) => void;
  onDissolve: () => void;
  readOnly?: boolean;
}) => {
  const t = useTranslations("Config");
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-bold text-zinc-100">{t("parallelGroup")}</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          {t("parallelGroupDesc")}
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-[11px] font-medium text-zinc-500 block">{t("groupName")}</label>
        <input
          value={group.parallel.name}
          onChange={(e) => onNameChange(e.target.value)}
          readOnly={readOnly}
          className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-blue-600"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-medium text-zinc-500 block">{t("childStages")} ({group.parallel.stages.length})</label>
        <div className="rounded border border-zinc-800 bg-zinc-950/50 p-2 space-y-1">
          {group.parallel.stages.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="text-zinc-600 font-mono w-4 text-right">{i + 1}</span>
              <span className="font-medium text-zinc-200">{s.name}</span>
              <span className="text-zinc-600">({s.type})</span>
              {s.runtime?.writes?.length ? (
                <span className="text-zinc-600 ml-auto truncate max-w-[150px]">writes: {(s.runtime.writes as string[]).join(", ")}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {issues.length > 0 && (
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-red-400 block">Issues</label>
          {issues.map((iss, i) => (
            <div key={i} className={`text-xs px-2 py-1 rounded ${
              iss.severity === "error" ? "bg-red-900/20 text-red-400" : "bg-amber-900/20 text-amber-400"
            }`}>
              {iss.message}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <button
          type="button"
          onClick={onDissolve}
          className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
        >
          {t("dissolveGroup")}
        </button>
      )}
    </div>
  );
};

// --- Component ---

const PipelineEditor = ({ config: initialConfig, readOnly = false, onSave, availableMcps = [] }: PipelineEditorProps) => {
  const t = useTranslations("Config");
  const tc = useTranslations("Common");
  const [draft, setDraft] = useState(() => structuredClone(initialConfig));
  const [savedSnapshot, setSavedSnapshot] = useState(() => structuredClone(initialConfig));
  const [selection, setSelection] = useState<LeftSelection>({ type: "stage", index: 0 });
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [showPipelineSettings, setShowPipelineSettings] = useState(false);
  const [showVisualizer, setShowVisualizer] = useState(false);
  const visualizerRef = useRef<PipelineFlowGraphHandle>(null);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [scripts, setScripts] = useState<ScriptMetadata[]>([]);
  const [availablePipelines, setAvailablePipelines] = useState<Array<{ id: string; name: string; description?: string; stageCount?: number }>>([]);

  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  useEffect(() => {
    fetch(`${API_BASE}/api/config/scripts`)
      .then((r) => r.json())
      .then((d) => setScripts(d))
      .catch(() => {});
    fetch(`${API_BASE}/api/config/pipelines-list`)
      .then((r) => r.json())
      .then((d) => setAvailablePipelines(d))
      .catch(() => {});
  }, [API_BASE]);

  // Sync when external config changes
  useEffect(() => {
    setDraft(structuredClone(initialConfig));
    setSavedSnapshot(structuredClone(initialConfig));
    setIsDirty(false);
  }, [initialConfig]);

  // Validation
  const knownMcpSet = useMemo(
    () => availableMcps.length > 0 ? new Set(availableMcps.map(m => m.name)) : undefined,
    [availableMcps]
  );
  const issues = useMemo(
    () => validatePipeline({ pipeline: draft.pipeline as any, prompts: draft.prompts.system }, knownMcpSet),
    [draft.pipeline, draft.prompts.system, knownMcpSet]
  );

  // Dirty flag (set on edit, cleared on save/discard/external config change)
  const [isDirty, setIsDirty] = useState(false);

  // --- Updaters ---

  const updateDraft = useCallback((updater: (prev: PipelineEditorConfig) => PipelineEditorConfig) => {
    if (readOnly) return;
    setDraft(updater);
    setIsDirty(true);
  }, [readOnly]);

  const updateStage = useCallback((index: number, updates: Partial<Stage>) => {
    updateDraft((prev) => {
      const next = structuredClone(prev);
      const entry = (next.pipeline.stages as StageEntry[])[index];
      if (isParallelGroup(entry)) return next; // Parallel groups don't use this path
      const oldName = (entry as Stage).name;
      (next.pipeline.stages as StageEntry[])[index] = { ...(entry as Stage), ...updates } as Stage;
      // Migrate prompt key on stage rename
      if (updates.name && updates.name !== oldName) {
        const oldKey = normalizePromptKey(oldName);
        const newKey = normalizePromptKey(updates.name);
        if (oldKey !== newKey && next.prompts.system[oldKey] !== undefined) {
          next.prompts.system[newKey] = next.prompts.system[oldKey];
          delete next.prompts.system[oldKey];
          if (!next._deletedPrompts) next._deletedPrompts = [];
          next._deletedPrompts.push(oldKey);
        }
      }
      return next;
    });
  }, [updateDraft]);

  const updateRuntime = useCallback((index: number, updates: Record<string, unknown>) => {
    updateDraft((prev) => {
      const next = structuredClone(prev);
      const entry = (next.pipeline.stages as StageEntry[])[index];
      if (isParallelGroup(entry)) return next; // Parallel groups don't use this path
      const stage = entry as Stage;
      stage.runtime = { ...(stage.runtime as Record<string, unknown>), ...updates } as Stage["runtime"];
      return next;
    });
  }, [updateDraft]);

  const moveStage = useCallback((index: number, direction: "up" | "down") => {
    updateDraft((prev) => {
      const next = structuredClone(prev);
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= next.pipeline.stages.length) return next;
      [next.pipeline.stages[index], next.pipeline.stages[target]] = [next.pipeline.stages[target], next.pipeline.stages[index]];
      return next;
    });
    if (selection.type === "stage" && selection.index === index) {
      const newIdx = direction === "up" ? index - 1 : index + 1;
      if (newIdx >= 0 && newIdx < draft.pipeline.stages.length) {
        setSelection({ type: "stage", index: newIdx });
      }
    } else if (selection.type === "parallelChild" && selection.groupIndex === index) {
      const newIdx = direction === "up" ? index - 1 : index + 1;
      if (newIdx >= 0 && newIdx < draft.pipeline.stages.length) {
        setSelection({ type: "parallelChild", groupIndex: newIdx, childIndex: selection.childIndex });
      }
    }
  }, [updateDraft, selection, draft.pipeline.stages.length]);

  const moveChildStage = useCallback((groupIndex: number, childIndex: number, direction: "up" | "down") => {
    updateDraft((prev) => {
      const next = structuredClone(prev);
      const g = (next.pipeline.stages as StageEntry[])[groupIndex] as ParallelGroup;
      const target = direction === "up" ? childIndex - 1 : childIndex + 1;
      if (target < 0 || target >= g.parallel.stages.length) return next;
      [g.parallel.stages[childIndex], g.parallel.stages[target]] = [g.parallel.stages[target], g.parallel.stages[childIndex]];
      return next;
    });
    if (selection.type === "parallelChild" && selection.groupIndex === groupIndex && selection.childIndex === childIndex) {
      const newIdx = direction === "up" ? childIndex - 1 : childIndex + 1;
      setSelection({ type: "parallelChild", groupIndex, childIndex: newIdx });
    }
  }, [updateDraft, selection]);

  const dissolveGroup = useCallback((groupIndex: number) => {
    updateDraft((prev) => {
      const next = structuredClone(prev);
      const entries = next.pipeline.stages as StageEntry[];
      const group = entries[groupIndex] as ParallelGroup;
      entries.splice(groupIndex, 1, ...group.parallel.stages as unknown as StageEntry[]);
      return next;
    });
    setSelection({ type: "stage", index: groupIndex });
  }, [updateDraft]);

  const removeStage = useCallback((index: number) => {
    const entry = draft.pipeline.stages[index] as StageEntry;
    const entryName = isParallelGroup(entry) ? entry.parallel.name : (entry as Stage).name;
    if (!confirm(`Delete ${isParallelGroup(entry) ? "parallel group" : "stage"} "${entryName}"?`)) return;

    updateDraft((prev) => {
      const next = structuredClone(prev);
      const removed = (next.pipeline.stages as StageEntry[])[index];
      // Collect prompt keys to delete
      const promptsToDelete: string[] = [];
      if (isParallelGroup(removed)) {
        for (const s of removed.parallel.stages) {
          promptsToDelete.push(normalizePromptKey(s.name));
        }
      } else {
        promptsToDelete.push(normalizePromptKey((removed as Stage).name));
      }
      (next.pipeline.stages as StageEntry[]).splice(index, 1);
      for (const key of promptsToDelete) {
        if (next.prompts.system[key] !== undefined) {
          delete next.prompts.system[key];
          if (!next._deletedPrompts) next._deletedPrompts = [];
          next._deletedPrompts.push(key);
        }
      }
      return next;
    });
    // Reset selection
    if (selection.type === "stage" || (selection.type === "parallelChild" && selection.groupIndex === index)) {
      const newIdx = Math.min(index, draft.pipeline.stages.length - 2);
      setSelection({ type: "stage", index: Math.max(0, newIdx) });
    }
  }, [updateDraft, draft.pipeline.stages, selection]);

  const addStage = useCallback((template: typeof RUNTIME_TEMPLATES[0]) => {
    if (template.type === "parallel") {
      updateDraft((prev) => {
        const next = structuredClone(prev);
        const idx = next.pipeline.stages.length + 1;
        const group: ParallelGroup = {
          parallel: {
            name: `parallel_${idx}`,
            stages: [
              { name: `agent_${idx}a`, type: "agent", max_turns: 30, max_budget_usd: 2, runtime: { engine: "llm", system_prompt: "", writes: [], reads: {} } },
              { name: `agent_${idx}b`, type: "agent", max_turns: 30, max_budget_usd: 2, runtime: { engine: "llm", system_prompt: "", writes: [], reads: {} } },
            ],
          },
        };
        (next.pipeline.stages as StageEntry[]).push(group);
        return next;
      });
      setShowTemplateMenu(false);
      setSelection({ type: "stage", index: draft.pipeline.stages.length });
      return;
    }
    updateDraft((prev) => {
      const next = structuredClone(prev);
      const name = `${template.type}_${next.pipeline.stages.length + 1}`;
      (next.pipeline.stages as StageEntry[]).push({ name, type: template.type, ...template.defaults } as Stage);
      return next;
    });
    setShowTemplateMenu(false);
    setSelection({ type: "stage", index: draft.pipeline.stages.length });
  }, [updateDraft, draft.pipeline.stages.length]);

  // Pipeline meta
  const pipelineMeta: PipelineMeta = useMemo(() => {
    const { stages: _, ...meta } = draft.pipeline;
    return meta as PipelineMeta;
  }, [draft.pipeline]);

  const updatePipelineMeta = useCallback((updates: Partial<PipelineMeta>) => {
    updateDraft((prev) => {
      const next = structuredClone(prev);
      Object.assign(next.pipeline, updates);
      return next;
    });
  }, [updateDraft]);

  // Engine — pipeline-level config
  const engine = (draft.pipeline.engine as string) || "claude";

  // Save / Discard
  const handleSave = async () => {
    setSaveStatus("saving");
    try {
      await onSave(draft);
      setSavedSnapshot(structuredClone(draft));
      setIsDirty(false);
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const handleDiscard = () => {
    setDraft(structuredClone(savedSnapshot));
    setIsDirty(false);
    setDiscardConfirm(false);
  };

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !readOnly) handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, readOnly, handleSave]);

  // --- Derived ---
  const stageEntries = draft.pipeline.stages as StageEntry[];
  const stages = flattenStageEntries(stageEntries);
  const systemPromptKeys = Object.keys(draft.prompts.system);

  const selectedStage: Stage | null = (() => {
    if (selection.type === "stage") {
      const entry = stageEntries[selection.index];
      return entry && !isParallelGroup(entry) ? entry as Stage : null;
    }
    if (selection.type === "parallelChild") {
      const entry = stageEntries[selection.groupIndex];
      if (entry && isParallelGroup(entry)) {
        return entry.parallel.stages[selection.childIndex] ?? null;
      }
    }
    return null;
  })();
  const selectedPromptRef = selectedStage ? getPromptKeyForStage(selectedStage) : null;
  const selectedPromptContent = selectedPromptRef ? findPromptContent(draft.prompts.system, selectedPromptRef) : null;
  const selectedPromptKey = selectedPromptRef ? (findPromptKey(draft.prompts.system, selectedPromptRef) || selectedPromptRef) : "";

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] min-h-[500px] rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0 gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-sm font-bold text-zinc-100 truncate">
            {(draft.pipeline as Record<string, unknown>).name as string || draft.pipelineName || t("pipelineLabel")}
          </h3>
          <span className={`text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${
            engine === "claude" ? "text-blue-400 bg-blue-900/20 border-blue-800/50"
              : engine === "gemini" ? "text-purple-400 bg-purple-900/20 border-purple-800/50"
              : engine === "codex" ? "text-green-400 bg-green-900/20 border-green-800/50"
              : "text-emerald-400 bg-emerald-900/20 border-emerald-800/50"
          }`}>
            {engine}
          </span>
          <span className="text-xs text-zinc-600">{stageEntries.length} stages</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {saveStatus === "success" && <span className="text-xs text-green-400 font-medium">{t("saved")}</span>}
          {saveStatus === "error" && <span className="text-xs text-red-400 font-medium">{t("savingFailed")}</span>}
          {!isDirty && saveStatus === "idle" && !readOnly && <span className="text-xs text-zinc-600">{t("autoSaved")}</span>}
          {isDirty && !readOnly && (
            discardConfirm ? (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-zinc-400">{t("discardConfirm")}</span>
                <button onClick={handleDiscard} className="text-red-400 hover:text-red-300 font-medium">{tc("yes")}</button>
                <button onClick={() => setDiscardConfirm(false)} className="text-zinc-500 hover:text-zinc-300">{tc("no")}</button>
              </div>
            ) : (
              <button
                onClick={() => setDiscardConfirm(true)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {t("discard")}
              </button>
            )
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || readOnly || saveStatus === "saving"}
            className={`rounded px-4 py-1.5 text-xs font-medium transition-all ${
              !isDirty || readOnly
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-500 active:scale-95"
            }`}
          >
            {saveStatus === "saving" ? t("saving") : tc("save")}
          </button>
        </div>
      </div>

      {/* Main content: master-detail */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left column: stage list + globals + runtime */}
        <div className="w-[320px] shrink-0 flex flex-col border-r border-zinc-800 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
            {/* Pipeline Settings (collapsible) */}
            <button
              type="button"
              onClick={() => setShowPipelineSettings(!showPipelineSettings)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <span>{t("pipelineSettings")}</span>
              <svg className={`w-3 h-3 transition-transform ${showPipelineSettings ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showPipelineSettings && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3 space-y-2 mb-2">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-600 block">{t("engine")}</label>
                  <div className="flex gap-1.5">
                    {(["claude", "gemini", "codex", "mixed"] as const).map((eng) => (
                      <button
                        key={eng}
                        type="button"
                        disabled={readOnly}
                        onClick={() => updateDraft((prev) => {
                          const next = structuredClone(prev);
                          next.pipeline.engine = eng;
                          return next;
                        })}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${
                          engine === eng
                            ? eng === "claude"
                              ? "bg-blue-900/30 text-blue-400 border border-blue-800/50"
                              : eng === "gemini"
                                ? "bg-purple-900/30 text-purple-400 border border-purple-800/50"
                                : eng === "codex"
                                  ? "bg-green-900/30 text-green-400 border border-green-800/50"
                                  : "bg-emerald-900/30 text-emerald-400 border border-emerald-800/50"
                            : "text-zinc-600 border border-zinc-800 hover:text-zinc-400"
                        }`}
                      >
                        {eng}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-600 block">{t("pipelineDescription")}</label>
                  <textarea
                    value={(draft.pipeline as Record<string, unknown>).description as string || ""}
                    onChange={(e) => updateDraft((prev) => {
                      const next = structuredClone(prev);
                      (next.pipeline as Record<string, unknown>).description = e.target.value || undefined;
                      return next;
                    })}
                    readOnly={readOnly}
                    rows={2}
                    className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-600 resize-none"
                    placeholder={t("pipelineDescriptionPlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-600 block">{t("useCases")}</label>
                  <input
                    value={pipelineMeta.use_cases?.join(", ") || ""}
                    onChange={(e) => updatePipelineMeta({ use_cases: e.target.value ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined })}
                    readOnly={readOnly}
                    className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-600"
                    placeholder={t("useCasesPlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-600 block">{t("defaultExecutionMode")}</label>
                  <div className="flex gap-1.5">
                    {(["auto", "edge"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        disabled={readOnly}
                        onClick={() => updatePipelineMeta({ default_execution_mode: mode })}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${
                          (pipelineMeta.default_execution_mode || "auto") === mode
                            ? "bg-blue-900/30 text-blue-400 border border-blue-800/50"
                            : "text-zinc-600 border border-zinc-800 hover:text-zinc-400"
                        }`}
                      >
                        {t(`executionMode${mode.charAt(0).toUpperCase() + mode.slice(1)}` as "executionModeAuto" | "executionModeEdge")}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-600 block">{t("hooks")}</label>
                  <input
                    value={pipelineMeta.hooks?.join(", ") || ""}
                    onChange={(e) => updatePipelineMeta({ hooks: e.target.value ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined })}
                    className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-600"
                    placeholder="format-on-write..."
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-600 block">{t("skills")}</label>
                  <input
                    value={pipelineMeta.skills?.join(", ") || ""}
                    onChange={(e) => updatePipelineMeta({ skills: e.target.value ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined })}
                    className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-600"
                    placeholder="security-review..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-zinc-600 block">{t("titlePath")}</label>
                    <input
                      value={pipelineMeta.display?.title_path || ""}
                      onChange={(e) => updatePipelineMeta({ display: { ...pipelineMeta.display, title_path: e.target.value || undefined } })}
                      className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-600"
                      placeholder="analysis.title"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-zinc-600 block">{t("completionPath")}</label>
                    <input
                      value={pipelineMeta.display?.completion_summary_path || ""}
                      onChange={(e) => updatePipelineMeta({ display: { ...pipelineMeta.display, completion_summary_path: e.target.value || undefined } })}
                      className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-600"
                      placeholder="prUrl"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-600 block">{t("claudeMdFile")}</label>
                  <input
                    value={pipelineMeta.claude_md?.global || ""}
                    onChange={(e) => updatePipelineMeta({ claude_md: e.target.value ? { global: e.target.value } : undefined })}
                    className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-600"
                    placeholder="global.md"
                  />
                </div>
              </div>
            )}

            {/* Stage list */}
            <div className="space-y-1.5">
              {stageEntries.map((entry, i) => (
                <React.Fragment key={`${i}-${isParallelGroup(entry) ? entry.parallel.name : (entry as Stage).name}`}>
                  {isParallelGroup(entry) ? (
                    <ParallelGroupCard
                      index={i}
                      group={entry}
                      isSelected={
                        (selection.type === "stage" && selection.index === i) ||
                        (selection.type === "parallelChild" && selection.groupIndex === i)
                      }
                      selectedChildIndex={selection.type === "parallelChild" && selection.groupIndex === i ? selection.childIndex : undefined}
                      issues={getStageIssues(issues, i)}
                      onSelectGroup={() => setSelection({ type: "stage", index: i })}
                      onSelectChild={(ci) => setSelection({ type: "parallelChild", groupIndex: i, childIndex: ci })}
                      onMoveUp={() => moveStage(i, "up")}
                      onMoveDown={() => moveStage(i, "down")}
                      onRemove={() => removeStage(i)}
                      onRemoveChild={(ci) => {
                        if (entry.parallel.stages.length <= 2) return;
                        updateDraft((prev) => {
                          const next = structuredClone(prev);
                          const g = (next.pipeline.stages as StageEntry[])[i] as ParallelGroup;
                          g.parallel.stages.splice(ci, 1);
                          return next;
                        });
                      }}
                      onAddChild={() => {
                        updateDraft((prev) => {
                          const next = structuredClone(prev);
                          const g = (next.pipeline.stages as StageEntry[])[i] as ParallelGroup;
                          const idx = g.parallel.stages.length + 1;
                          g.parallel.stages.push({
                            name: `agent_${g.parallel.name}_${idx}`,
                            type: "agent",
                            max_turns: 30,
                            max_budget_usd: 2,
                            runtime: { engine: "llm", system_prompt: "", writes: [], reads: {} },
                          } as Stage);
                          return next;
                        });
                      }}
                      onDissolve={() => dissolveGroup(i)}
                      onMoveChildUp={(ci) => moveChildStage(i, ci, "up")}
                      onMoveChildDown={(ci) => moveChildStage(i, ci, "down")}
                      readOnly={readOnly}
                      isFirst={i === 0}
                      isLast={i === stageEntries.length - 1}
                    />
                  ) : (
                    <StageCard
                      index={i}
                      stage={entry as Stage}
                      isSelected={selection.type === "stage" && selection.index === i}
                      issues={getStageIssues(issues, i)}
                      onSelect={() => setSelection({ type: "stage", index: i })}
                      onMoveUp={() => moveStage(i, "up")}
                      onMoveDown={() => moveStage(i, "down")}
                      onRemove={() => removeStage(i)}
                      isFirst={i === 0}
                      isLast={i === stageEntries.length - 1}
                    />
                  )}
                  {/* Connector */}
                  {i < stageEntries.length - 1 && (
                    <div className="flex justify-center">
                      <div className="w-px h-3 bg-zinc-800" />
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>

            {/* Add stage */}
            {!readOnly && (
              <div className="relative pt-2">
                <button
                  type="button"
                  onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                  className="w-full rounded-lg border border-dashed border-zinc-700 py-2 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {t("addStage")}
                </button>
                {showTemplateMenu && (
                  <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-10 overflow-hidden">
                    {RUNTIME_TEMPLATES.map((tmpl) => (
                      <button
                        key={tmpl.type}
                        type="button"
                        onClick={() => addStage(tmpl)}
                        className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
                      >
                        {tmpl.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Divider */}
            <div className="pt-4 pb-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-700 px-2">{t("globals")}</div>
            </div>

            {/* Global entries */}
            {([
              { key: "constraints" as const, label: t("constraints") },
              { key: "claudeMd" as const, label: t("claudeMd") },
              { key: "geminiMd" as const, label: t("geminiMd") },
              { key: "codexMd" as const, label: t("codexMd") },
              { key: "fragments" as const, label: `${t("fragments")} (${Object.keys(draft.prompts.fragments).length})` },
            ] as const).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSelection({ type: item.key })}
                className={`w-full text-left rounded-lg px-3 py-2 text-xs font-medium transition-all ${
                  selection.type === item.key
                    ? "bg-zinc-800 text-zinc-100 border-l-2 border-blue-500"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {item.label}
              </button>
            ))}

            {/* YAML / Visualizer shortcuts */}
            <div className="flex gap-1.5 pt-2">
              <button
                type="button"
                onClick={() => setSelection({ type: "yaml" })}
                className={`flex-1 text-center rounded-lg px-2 py-1.5 text-[11px] font-medium transition-all ${
                  selection.type === "yaml" ? "bg-zinc-800 text-zinc-100" : "text-zinc-600 hover:text-zinc-400"
                }`}
              >
                {t("yamlSource")}
              </button>
              <button
                type="button"
                onClick={() => setShowVisualizer(true)}
                className="flex-1 text-center rounded-lg px-2 py-1.5 text-[11px] font-medium text-zinc-600 hover:text-zinc-400 transition-all"
              >
                {t("previewFlow")}
              </button>
            </div>
          </div>

          {/* Validation bar at bottom of left column */}
          <ValidationBar
            issues={issues}
            stageNames={stages.map((s: Stage) => s.name)}
            onJumpToStage={(i) => setSelection({ type: "stage", index: i })}
          />
        </div>

        {/* Right column: editor panel */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden p-5">
          {/* Parallel group detail when group header selected */}
          {selection.type === "stage" && stageEntries[selection.index] && isParallelGroup(stageEntries[selection.index]) && (
            <ParallelGroupDetail
              group={stageEntries[selection.index] as ParallelGroup}
              issues={getStageIssues(issues, selection.index)}
              onNameChange={(name) => {
                updateDraft((prev) => {
                  const next = structuredClone(prev);
                  (next.pipeline.stages[selection.index] as ParallelGroup).parallel.name = name;
                  return next;
                });
              }}
              onDissolve={() => dissolveGroup(selection.index)}
              readOnly={readOnly}
            />
          )}

          {/* Stage detail for flat stages or parallel child stages */}
          {((selection.type === "stage" && selectedStage) || (selection.type === "parallelChild" && selectedStage)) && (
            <StageDetail
              stage={selectedStage}
              stageIndex={selection.type === "stage" ? selection.index : selection.groupIndex}
              allStages={stages}
              promptContent={selectedPromptContent}
              promptKey={selectedPromptKey}
              issues={selection.type === "stage" ? getStageIssues(issues, selection.index) : []}
              scripts={scripts}
              systemPromptKeys={systemPromptKeys}
              onStageUpdate={(updates) => {
                if (selection.type === "parallelChild") {
                  updateDraft((prev) => {
                    const next = structuredClone(prev);
                    const g = (next.pipeline.stages as StageEntry[])[selection.groupIndex] as ParallelGroup;
                    g.parallel.stages[selection.childIndex] = { ...g.parallel.stages[selection.childIndex], ...updates };
                    return next;
                  });
                } else {
                  updateStage(selection.index, updates);
                }
              }}
              onRuntimeUpdate={(updates) => {
                if (selection.type === "parallelChild") {
                  updateDraft((prev) => {
                    const next = structuredClone(prev);
                    const g = (next.pipeline.stages as StageEntry[])[selection.groupIndex] as ParallelGroup;
                    const child = g.parallel.stages[selection.childIndex];
                    child.runtime = { ...(child.runtime as Record<string, unknown>), ...updates } as Stage["runtime"];
                    return next;
                  });
                } else {
                  updateRuntime(selection.index, updates);
                }
              }}
              onPromptChange={(content) => {
                const actualKey = findPromptKey(draft.prompts.system, selectedPromptKey) || selectedPromptKey;
                updateDraft((prev) => {
                  const next = structuredClone(prev);
                  next.prompts.system[actualKey] = content;
                  return next;
                });
              }}
              onPromptCreate={() => {
                const key = normalizePromptKey(selectedPromptKey);
                updateDraft((prev) => {
                  const next = structuredClone(prev);
                  next.prompts.system[key] = "";
                  return next;
                });
              }}
              availableMcps={availableMcps}
              availablePipelines={availablePipelines}
              readOnly={readOnly}
            />
          )}

          {(selection.type === "constraints" || selection.type === "claudeMd" || selection.type === "geminiMd" || selection.type === "codexMd" || selection.type === "fragments") && (
            <GlobalEditor
              selection={selection}
              constraints={draft.prompts.globalConstraints}
              claudeMd={draft.prompts.globalClaudeMd}
              geminiMd={draft.prompts.globalGeminiMd || ""}
              codexMd={draft.prompts.globalCodexMd || ""}
              fragments={draft.prompts.fragments}
              fragmentMeta={draft.prompts.fragmentMeta || {}}
              onConstraintsChange={(v) => updateDraft((prev) => {
                const next = structuredClone(prev);
                next.prompts.globalConstraints = v;
                return next;
              })}
              onClaudeMdChange={(v) => updateDraft((prev) => {
                const next = structuredClone(prev);
                next.prompts.globalClaudeMd = v;
                return next;
              })}
              onGeminiMdChange={(v) => updateDraft((prev) => {
                const next = structuredClone(prev);
                next.prompts.globalGeminiMd = v;
                return next;
              })}
              onCodexMdChange={(v) => updateDraft((prev) => {
                const next = structuredClone(prev);
                next.prompts.globalCodexMd = v;
                return next;
              })}
              onFragmentChange={(name, content) => updateDraft((prev) => {
                const next = structuredClone(prev);
                next.prompts.fragments[name] = content;
                return next;
              })}
              onFragmentMetaChange={(name, meta) => updateDraft((prev) => {
                const next = structuredClone(prev);
                if (!next.prompts.fragmentMeta) next.prompts.fragmentMeta = {};
                next.prompts.fragmentMeta[name] = meta;
                return next;
              })}
              onFragmentAdd={(name) => updateDraft((prev) => {
                const next = structuredClone(prev);
                next.prompts.fragments[name] = "";
                if (!next.prompts.fragmentMeta) next.prompts.fragmentMeta = {};
                next.prompts.fragmentMeta[name] = { id: name, keywords: [], stages: "*", always: false };
                return next;
              })}
              onFragmentDelete={(name) => updateDraft((prev) => {
                const next = structuredClone(prev);
                delete next.prompts.fragments[name];
                if (next.prompts.fragmentMeta) delete next.prompts.fragmentMeta[name];
                if (!next._deletedFragments) next._deletedFragments = [];
                next._deletedFragments.push(name);
                return next;
              })}
              readOnly={readOnly}
            />
          )}

          {selection.type === "yaml" && (
            <div className="flex flex-col h-full">
              <div className="shrink-0 mb-3">
                <h3 className="text-sm font-bold text-zinc-100">{t("pipelineYaml")}</h3>
                <p className="text-xs text-zinc-500 mt-0.5">{t("pipelineYamlDesc")}</p>
              </div>
              <div className="flex-1 min-h-0">
                <CodeEditor
                  language="yaml"
                  value={stringifyYAML(draft.pipeline)}
                  onChange={(v) => {
                    if (readOnly) return;
                    try {
                      const parsed = parseYAML(v ?? "");
                      if (parsed?.stages) {
                        updateDraft((prev) => ({ ...prev, pipeline: parsed }));
                      }
                    } catch {
                      // Ignore parse errors during editing
                    }
                  }}
                  readOnly={readOnly}
                  height="100%"
                />
              </div>
            </div>
          )}

          {selection.type !== "stage" && selection.type !== "parallelChild" && selection.type !== "constraints" && selection.type !== "claudeMd" && selection.type !== "geminiMd" && selection.type !== "codexMd" && selection.type !== "fragments" && selection.type !== "yaml" && (
            <div className="flex items-center justify-center h-full text-zinc-600 text-sm italic">
              {t("selectStageOrSection")}
            </div>
          )}
        </div>
      </div>

      {/* Visualizer modal */}
      {showVisualizer && (
        <div className="fixed inset-0 z-50 bg-zinc-950 flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
            <h3 className="text-sm font-bold text-zinc-100">{t("pipelineFlow")}</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const svg = visualizerRef.current?.exportSvg();
                  if (!svg) return;
                  const blob = new Blob([svg], { type: "image/svg+xml" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${(draft.pipeline as { name?: string }).name ?? "pipeline"}.svg`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="h-7 px-2.5 flex items-center gap-1.5 rounded bg-zinc-800 text-zinc-400 hover:text-white text-xs border border-zinc-700 hover:border-zinc-600"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                SVG
              </button>
              <button onClick={() => setShowVisualizer(false)} className="h-7 w-7 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-400 hover:text-white text-sm">&times;</button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <PipelineVisualizer
              ref={visualizerRef}
              pipeline={draft.pipeline as unknown as { name: string; stages: PipelineStageEntry[] }}
              selectedStageName={selectedStage?.name}
              onNodeClick={(stageName, entryIndex) => {
                setSelection({ type: "stage", index: entryIndex });
                setShowVisualizer(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default PipelineEditor;
