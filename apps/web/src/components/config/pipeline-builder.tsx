"use client";

import React, { useState, useEffect } from "react";
import type { OutputFieldSchema as OutputField, StageOutputSchema, FragmentMeta } from "@/lib/pipeline-types";

interface ScriptMetadata {
  id: string;
  name: string;
  description: string;
  helpMd: string;
}

interface Stage {
  name: string;
  type: "agent" | "script" | "human_confirm";
  model?: string;
  max_turns?: number;
  max_budget_usd?: number;
  effort?: "low" | "medium" | "high" | "max";
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  debug?: boolean;
  mcps?: string[];
  notion_label?: string;
  on_complete?: { notify?: string };
  runtime?: {
    engine: "llm" | "script" | "human_gate";
    system_prompt?: string;
    writes?: string[];
    reads?: Record<string, string>;
    script_id?: string;
    args?: Record<string, unknown>;
    timeout_sec?: number;
    enabled_steps_path?: string;
    available_steps?: { key: string; label: string }[];
    notify?: { type: "slack"; template: string };
    on_approve_to?: string;
    on_reject_to?: string;
    retry?: { max_retries?: number; back_to?: string };
    [key: string]: unknown;
  };
  outputs?: StageOutputSchema;
  [key: string]: unknown;
}

interface PipelineMeta {
  hooks?: string[];
  skills?: string[];
  claude_md?: { global?: string };
  display?: { title_path?: string; completion_summary_path?: string };
  integrations?: { notion_page_id_path?: string };
}

interface PipelineBuilderProps {
  stages: Stage[];
  pipelineMeta?: PipelineMeta;
  onChange: (stages: Stage[]) => void;
  onPipelineMetaChange?: (meta: PipelineMeta) => void;
  onCustomStageAdd?: (name: string, templatePrompt?: string) => void;
  fragmentRegistry: Record<string, FragmentMeta>;
  systemPromptKeys: string[];
}

const RUNTIME_TEMPLATES = [
  {
    label: "AI Agent", name: "new_agent", type: "agent", engine: "llm",
    defaults: { model: "claude-sonnet-4-20250514", max_turns: 30, max_budget_usd: 2.0, runtime: { engine: "llm", system_prompt: "", writes: [], reads: {} } }
  },
  {
    label: "Automation Script", name: "new_script", type: "script", engine: "script",
    defaults: { runtime: { engine: "script", script_id: "", writes: [], reads: {} } }
  },
  {
    label: "Human Gate", name: "new_gate", type: "human_confirm", engine: "human_gate",
    defaults: { runtime: { engine: "human_gate", on_reject_to: "error" } }
  },
];

const KeyValueEditor = ({ entries, onChange, keyPlaceholder, valuePlaceholder }: {
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) => {
  const pairs = Object.entries(entries);
  const updateKey = (oldKey: string, newKey: string) => {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      result[k === oldKey ? newKey : k] = v;
    }
    onChange(result);
  };
  const updateValue = (key: string, value: string) => {
    onChange({ ...entries, [key]: value });
  };
  const addEntry = () => {
    onChange({ ...entries, "": "" });
  };
  const removeEntry = (key: string) => {
    const { [key]: _, ...rest } = entries;
    onChange(rest);
  };

  return (
    <div className="space-y-1">
      {pairs.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={k}
            onChange={(e) => updateKey(k, e.target.value)}
            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-300 outline-none font-mono"
            placeholder={keyPlaceholder || "key"}
          />
          <span className="text-zinc-600 text-[9px] shrink-0">&rarr;</span>
          <input
            value={v}
            onChange={(e) => updateValue(k, e.target.value)}
            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-300 outline-none font-mono"
            placeholder={valuePlaceholder || "value"}
          />
          <button type="button" onClick={() => removeEntry(k)} className="text-zinc-600 hover:text-red-400 text-[10px] px-1 shrink-0">x</button>
        </div>
      ))}
      <button type="button" onClick={addEntry} className="text-[8px] text-blue-400 hover:underline">+ Add</button>
    </div>
  );
};

const ReadsEditor = ({ entries, onChange, availablePaths }: {
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
  availablePaths: string[];
}) => {
  const pairs = Object.entries(entries);
  
  // Update the mapping logic to handle swapped UI correctly
  const updateKey = (oldKey: string, newKey: string) => {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      result[k === oldKey ? newKey : k] = v;
    }
    onChange(result);
  };
  
  const updateValue = (oldValue: string, newValue: string, currentKey: string) => {
    // If the alias (key) was auto-generated from the old value, update it to the new value's tail
    let newKey = currentKey;
    if (!currentKey || currentKey === oldValue.split(".").pop()) {
      newKey = newValue.split(".").pop() || newValue;
    }
    // Deduplicate key
    let finalKey = newKey;
    let counter = 1;
    while (finalKey !== currentKey && entries[finalKey]) {
      finalKey = `${newKey}_${counter++}`;
    }

    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (k === currentKey) {
        result[finalKey] = newValue;
      } else {
        result[k] = v;
      }
    }
    onChange(result);
  };

  const addEntry = () => {
    const firstPath = availablePaths[0] || "";
    const defaultKey = firstPath.split(".").pop() || "data";
    // Check if key already exists to avoid collisions
    let finalKey = defaultKey;
    let counter = 1;
    while (entries[finalKey]) {
      finalKey = `${defaultKey}_${counter++}`;
    }
    onChange({ ...entries, [finalKey]: firstPath });
  };

  const removeEntry = (key: string) => {
    const { [key]: _, ...rest } = entries;
    onChange(rest);
  };

  return (
    <div className="space-y-2">
      {pairs.length > 0 && (
        <div className="flex items-center gap-1.5 px-1">
          <span className="flex-1 text-[8px] font-bold text-zinc-600 uppercase tracking-tighter">1. Select Source</span>
          <span className="w-4" />
          <span className="flex-1 text-[8px] font-bold text-zinc-600 uppercase tracking-tighter">2. Inject As (label seen by AI)</span>
          <span className="w-4" />
        </div>
      )}
      <div className="space-y-1">
        {pairs.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1.5">
            {/* 1. Source on left */}
            <select
              value={v}
              onChange={(e) => updateValue(v, e.target.value, k)}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-300 outline-none appearance-none cursor-pointer focus:border-blue-500/50"
            >
              {!availablePaths.includes(v) && v && <option value={v}>{v} (custom)</option>}
              {availablePaths.map(path => (
                <option key={path} value={path}>{path}</option>
              ))}
              {availablePaths.length === 0 && <option value="">No data available</option>}
            </select>
            
            <div className="flex flex-col items-center shrink-0">
              <span className="text-blue-500 text-[10px] font-bold leading-none">&rarr;</span>
              <span className="text-[6px] text-zinc-600 font-bold uppercase mt-0.5">inject</span>
            </div>

            {/* 2. Alias on right */}
            <input
              value={k}
              onChange={(e) => updateKey(k, e.target.value)}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-100 outline-none font-mono focus:border-blue-500/50"
              placeholder="e.g. ticket_info"
            />
            
            <button type="button" onClick={() => removeEntry(k)} className="text-zinc-600 hover:text-red-400 text-[10px] px-1 shrink-0">x</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={addEntry} className="text-[8px] text-blue-400 hover:underline flex items-center gap-1">
        <span>+</span> Add Data Dependency
      </button>
    </div>
  );
};

const PipelineBuilder = ({ stages, pipelineMeta, onChange, onPipelineMetaChange, onCustomStageAdd, fragmentRegistry, systemPromptKeys }: PipelineBuilderProps) => {
  const [showPipelineSettings, setShowPipelineSettings] = useState(false);
  const [editingCustomName, setEditingCustomName] = useState<{index: number, name: string} | null>(null);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [scripts, setScripts] = useState<ScriptMetadata[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [expandedAdvanced, setExpandedAdvanced] = useState<Record<number, boolean>>({});

  useEffect(() => {
    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    fetch(`${API_BASE}/api/config/scripts`)
      .then(res => res.json())
      .then(data => setScripts(data))
      .catch(err => console.error("Failed to fetch scripts", err));
  }, []);

  const updateStage = (index: number, updates: Partial<Stage>) => {
    const newStages = JSON.parse(JSON.stringify(stages));
    newStages[index] = { ...newStages[index], ...updates };
    onChange(newStages);
  };

  const updateRuntime = (index: number, updates: any) => {
    const stage = stages[index];
    updateStage(index, { runtime: { ...(stage.runtime as any), ...updates } });
  };

  const handleTypeChange = (index: number, type: Stage["type"]) => {
    const defaultName = `${type}_${stages.length + 1}`;
    let runtime: any = {};
    if (type === "agent") runtime = { engine: "llm", system_prompt: "", writes: [] };
    else if (type === "script") {
      if (scripts.length === 0) return;
      runtime = { engine: "script", script_id: scripts[0].id, writes: [], reads: {} };
    }
    else if (type === "human_confirm") runtime = { engine: "human_gate", on_reject_to: "error" };

    updateStage(index, { type, name: defaultName, runtime });
  };

  const addFromTemplate = (template: typeof RUNTIME_TEMPLATES[0]) => {
    const name = `${template.name}_${stages.length + 1}`;
    const newStage: Stage = {
      name,
      type: template.type as Stage["type"],
      ...template.defaults,
      runtime: { ...template.defaults.runtime, engine: template.defaults.runtime.engine as Stage["runtime"] extends { engine: infer E } ? E : never },
    } as Stage;
    onChange([...stages, newStage]);
    setShowTemplateMenu(false);
  };

  const removeStage = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete stage "${stages[index].name}"?`)) return;
    onChange(stages.filter((_, i) => i !== index));
  };

  const moveStage = (e: React.MouseEvent, index: number, direction: "up" | "down") => {
    e.preventDefault();
    e.stopPropagation();
    const newStages = JSON.parse(JSON.stringify(stages));
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= stages.length) return;
    [newStages[index], newStages[targetIndex]] = [newStages[targetIndex], newStages[index]];
    onChange(newStages);
  };

  const selectedScript = scripts.find(s => s.id === selectedScriptId);

  return (
    <div className="flex gap-6 h-full min-h-0 overflow-hidden relative">
      {/* Help Drawer */}
      {selectedScript && (
        <div className="fixed inset-y-0 right-0 w-[400px] bg-zinc-900 border-l border-zinc-800 shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-300">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
            <h3 className="font-bold text-zinc-100 flex items-center gap-2">
              <span className="text-emerald-500">📜</span> {selectedScript.name}
            </h3>
            <button onClick={() => setSelectedScriptId(null)} className="text-zinc-500 hover:text-white">&times;</button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 prose prose-invert prose-xs">
            <div className="text-[11px] text-zinc-400 leading-relaxed whitespace-pre-wrap font-mono bg-zinc-950 p-4 rounded-lg border border-zinc-800">
              {selectedScript.helpMd}
            </div>
            <div className="mt-6 pt-6 border-t border-zinc-800">
              <p className="text-[10px] text-zinc-500 italic">
                Need to extend this script? Modify the logic in <code>apps/server/src/scripts/{selectedScript.id}.ts</code>
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-2 max-h-full pb-10 scrollbar-thin scrollbar-thumb-zinc-800">
        {/* Pipeline Settings */}
        {pipelineMeta && onPipelineMetaChange && (
          <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/20">
            <button
              type="button"
              onClick={() => setShowPipelineSettings(!showPipelineSettings)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <span>Pipeline Settings</span>
              <svg className={`w-3 h-3 transition-transform ${showPipelineSettings ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {showPipelineSettings && (
              <div className="px-4 pb-4 space-y-3 border-t border-zinc-800/50">
                <div className="grid grid-cols-2 gap-3 pt-3">
                  <div className="space-y-0.5">
                    <label className="text-[8px] font-bold uppercase text-zinc-600 block">Hooks</label>
                    <input
                      value={pipelineMeta.hooks?.join(", ") || ""}
                      onChange={(e) => onPipelineMetaChange({ ...pipelineMeta, hooks: e.target.value ? e.target.value.split(",").map(s => s.trim()).filter(Boolean) : undefined })}
                      className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                      placeholder="format-on-write, lint-check..."
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-[8px] font-bold uppercase text-zinc-600 block">Skills</label>
                    <input
                      value={pipelineMeta.skills?.join(", ") || ""}
                      onChange={(e) => onPipelineMetaChange({ ...pipelineMeta, skills: e.target.value ? e.target.value.split(",").map(s => s.trim()).filter(Boolean) : undefined })}
                      className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                      placeholder="security-review, performance-audit..."
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-0.5">
                    <label className="text-[8px] font-bold uppercase text-zinc-600 block">Title Path</label>
                    <input
                      value={pipelineMeta.display?.title_path || ""}
                      onChange={(e) => onPipelineMetaChange({ ...pipelineMeta, display: { ...pipelineMeta.display, title_path: e.target.value || undefined } })}
                      className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                      placeholder="analysis.title"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-[8px] font-bold uppercase text-zinc-600 block">Completion Path</label>
                    <input
                      value={pipelineMeta.display?.completion_summary_path || ""}
                      onChange={(e) => onPipelineMetaChange({ ...pipelineMeta, display: { ...pipelineMeta.display, completion_summary_path: e.target.value || undefined } })}
                      className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                      placeholder="prUrl"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-[8px] font-bold uppercase text-zinc-600 block">Notion ID Path</label>
                    <input
                      value={pipelineMeta.integrations?.notion_page_id_path || ""}
                      onChange={(e) => onPipelineMetaChange({ ...pipelineMeta, integrations: { ...pipelineMeta.integrations, notion_page_id_path: e.target.value || undefined } })}
                      className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                      placeholder="notionPageId"
                    />
                  </div>
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] font-bold uppercase text-zinc-600 block">Global CLAUDE.md File</label>
                  <input
                    value={pipelineMeta.claude_md?.global || ""}
                    onChange={(e) => onPipelineMetaChange({ ...pipelineMeta, claude_md: e.target.value ? { global: e.target.value } : undefined })}
                    className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                    placeholder="global.md"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {stages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-zinc-800 rounded-2xl bg-zinc-900/10">
            <p className="text-zinc-500 text-sm italic">No stages in this pipeline.</p>
            <button onClick={() => setShowTemplateMenu(true)} className="mt-4 text-blue-400 hover:text-blue-300 text-sm font-bold underline">
              Start from a template
            </button>
          </div>
        )}

        {stages.map((stage, index) => {
          const nextStageName = stages[index + 1]?.name || "END";
          const runtime = stage.runtime || { engine: stage.type === "agent" ? "llm" : stage.type === "script" ? "script" : "human_gate" } as any;

          // Calculate available store paths for 'reads' dropdown (all writes from previous stages)
          const availablePaths: string[] = [];
          for (let j = 0; j < index; j++) {
            const prevStage = stages[j];
            if (prevStage.runtime?.writes) {
              for (const raw of (prevStage.runtime.writes as Array<string | { key: string }>)) {
                const w = typeof raw === "string" ? raw : raw.key;
                // If the previous stage has specific output fields defined, list them too
                if (prevStage.outputs?.[w]?.fields) {
                  for (const f of prevStage.outputs[w].fields) {
                    availablePaths.push(`${w}.${f.key}`);
                  }
                } else {
                  availablePaths.push(w);
                }
              }
            }
          }
          // Remove duplicates
          const uniquePaths = Array.from(new Set(availablePaths));

          const normalize = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/\.md$/, "");
          const promptKey = runtime.system_prompt || stage.name;
          const stageKey = normalize(promptKey);
          const hasMissingPrompt = stage.type === "agent" && !systemPromptKeys.some(k => normalize(k) === stageKey);
          const isAdvancedOpen = expandedAdvanced[index] ?? false;

          return (
            <div
              key={`${index}-${stage.name}`}
              className={`group relative flex flex-col gap-4 rounded-xl border bg-zinc-900/20 p-4 shadow-sm transition-all duration-200 ${hasMissingPrompt ? "border-amber-900/40 bg-amber-900/5 hover:border-amber-700" : "border-zinc-800 hover:border-zinc-700"}`}
            >
              {/* Header: Identity & Actions */}
              <div className="flex items-center justify-between gap-4 pb-3 border-b border-zinc-800/50">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${hasMissingPrompt ? "bg-amber-600 text-white" : "bg-zinc-800 text-zinc-400"}`}>
                    {index + 1}
                  </div>

                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {editingCustomName?.index === index ? (
                      <input
                        autoFocus
                        value={editingCustomName.name}
                        onChange={(e) => setEditingCustomName({ ...editingCustomName, name: e.target.value })}
                        onBlur={() => {
                          if (editingCustomName.name && editingCustomName.name !== stage.name) {
                            updateStage(index, { name: editingCustomName.name });
                          }
                          setEditingCustomName(null);
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        className="bg-zinc-950 border border-blue-500 text-sm font-bold text-zinc-100 rounded px-2 py-0.5 outline-none"
                      />
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          onClick={() => setEditingCustomName({ index, name: stage.name })}
                          className="text-sm font-bold text-zinc-100 hover:text-blue-400 truncate"
                        >
                          {stage.name}
                        </button>
                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider ${stage.type === 'agent' ? 'bg-blue-900/30 text-blue-400 border border-blue-800/50' : stage.type === 'human_confirm' ? 'bg-purple-900/30 text-purple-400 border border-purple-800/50' : 'bg-zinc-800 text-zinc-500 border border-zinc-700'}`}>
                          {runtime.engine}
                        </span>
                      </div>
                    )}
                    {hasMissingPrompt && (
                      <span className="flex items-center gap-1 text-[9px] font-bold text-amber-500 uppercase tracking-tighter bg-amber-900/20 px-1.5 py-0.5 rounded border border-amber-800/50 animate-pulse">
                        No Prompt
                      </span>
                    )}
                  </div>

                  <div className="flex rounded-md bg-zinc-950 p-0.5 border border-zinc-800 shrink-0">
                    {(["agent", "human_confirm", "script"] as const).map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => handleTypeChange(index, t)}
                        className={`px-2 py-0.5 text-[8px] font-bold uppercase rounded transition-all ${
                          stage.type === t
                            ? "bg-zinc-700 text-white shadow-sm"
                            : "text-zinc-600 hover:text-zinc-400"
                        }`}
                      >
                        {t === "human_confirm" ? "Gate" : t}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="flex rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
                    <button type="button" onClick={(e) => moveStage(e, index, "up")} disabled={index === 0} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-10">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                    </button>
                    <button type="button" onClick={(e) => moveStage(e, index, "down")} disabled={index === stages.length - 1} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-10">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    </button>
                  </div>
                  <button type="button" onClick={(e) => removeStage(e, index)} className="p-1 text-zinc-600 hover:text-red-500 hover:bg-red-900/20 rounded transition-all">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>

              {/* Body: Runtime Configuration */}
              <div className="grid grid-cols-12 gap-6 min-w-0">
                {/* Left Column: Logic & Routing */}
                <div className="col-span-6 space-y-3 min-w-0">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest flex items-center gap-1.5">
                      <span className="h-1 w-1 rounded-full bg-emerald-500" />
                      Success Target
                    </label>
                    <div className="flex items-center gap-2 w-full rounded-lg border border-emerald-900/20 bg-emerald-900/5 px-2.5 py-1.5 text-[11px] text-emerald-200/70 italic">
                      <span className="text-emerald-500 font-bold">&rarr;</span>
                      Proceed to: <span className="font-bold text-zinc-200">{nextStageName}</span>
                    </div>
                  </div>

                  {stage.type === "human_confirm" ? (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest flex items-center gap-1.5">
                          <span className="h-1 w-1 rounded-full bg-red-500" />
                          On Reject
                        </label>
                        <select
                          value={runtime.on_reject_to || "error"}
                          onChange={(e) => updateRuntime(index, { on_reject_to: e.target.value })}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:border-red-500/50 focus:outline-none appearance-none cursor-pointer"
                        >
                          <option value="error">error (Default Failure)</option>
                          {stages.filter(s => s.name !== stage.name).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest flex items-center gap-1.5">
                          <span className="h-1 w-1 rounded-full bg-emerald-500" />
                          On Approve To
                        </label>
                        <select
                          value={runtime.on_approve_to || ""}
                          onChange={(e) => updateRuntime(index, { on_approve_to: e.target.value || undefined })}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:border-emerald-500/50 focus:outline-none appearance-none cursor-pointer"
                        >
                          <option value="">Next Stage (default)</option>
                          {stages.filter(s => s.name !== stage.name).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest flex items-center gap-1.5">
                        <span className="h-1 w-1 rounded-full bg-amber-500" />
                        Retry Policy (Back to)
                      </label>
                      <select
                        value={runtime.retry?.back_to || ""}
                        onChange={(e) => updateRuntime(index, { retry: { ...runtime.retry, back_to: e.target.value || undefined } })}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:border-amber-500/50 focus:outline-none appearance-none cursor-pointer"
                      >
                        <option value="">No Automatic Retry</option>
                        {stages.filter(s => s.name !== stage.name).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                      </select>
                    </div>
                  )}
                </div>

                {/* Right Column: Engine Parameters */}
                <div className="col-span-6 space-y-3 pl-6 border-l border-zinc-800/50 min-w-0">
                  {stage.type === "agent" && (
                    <>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">System Prompt ID</label>
                        <select
                          value={runtime.system_prompt || ""}
                          onChange={(e) => updateRuntime(index, { system_prompt: e.target.value })}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:outline-none appearance-none"
                        >
                          {systemPromptKeys.map(k => <option key={k} value={k}>{k}</option>)}
                          {runtime.system_prompt && !systemPromptKeys.includes(runtime.system_prompt) && <option value={runtime.system_prompt}>{runtime.system_prompt} (custom)</option>}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Writes to Context</label>
                        <input
                          value={runtime.writes ? (runtime.writes as Array<string | { key: string }>).map((w: string | { key: string }) => typeof w === "string" ? w : w.key).join(", ") : ""}
                          onChange={(e) => {
                            const keys = e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean);
                            const existing = (runtime.writes ?? []) as Array<string | { key: string }>;
                            const byKey = new Map(existing.map((w: string | { key: string }) => [typeof w === "string" ? w : w.key, w]));
                            const writes = keys.map((k: string) => byKey.get(k) ?? k);
                            updateRuntime(index, { writes });
                          }}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:outline-none"
                          placeholder="analysis, techContext..."
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Reads from Context</label>
                        <ReadsEditor
                          entries={(runtime.reads as Record<string, string>) || {}}
                          availablePaths={uniquePaths}
                          onChange={(reads) => updateRuntime(index, { reads })}
                        />
                      </div>

                      {/* Step Activation */}
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Enabled Steps Path</label>
                        <input
                          value={runtime.enabled_steps_path || ""}
                          onChange={(e) => updateRuntime(index, { enabled_steps_path: e.target.value || undefined })}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:outline-none"
                          placeholder="analysis.enabledSteps"
                        />
                      </div>
                      {runtime.enabled_steps_path && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest">Available Steps</label>
                            <button
                              type="button"
                              onClick={() => {
                                const steps = [...(runtime.available_steps || []), { key: "", label: "" }];
                                updateRuntime(index, { available_steps: steps });
                              }}
                              className="text-[8px] text-blue-400 hover:underline"
                            >+ Add</button>
                          </div>
                          {(runtime.available_steps || []).map((step: { key: string; label: string }, si: number) => (
                            <div key={si} className="flex gap-1.5 items-center">
                              <input
                                value={step.key}
                                onChange={(e) => {
                                  const steps = [...(runtime.available_steps || [])];
                                  steps[si] = { ...steps[si], key: e.target.value };
                                  updateRuntime(index, { available_steps: steps });
                                }}
                                className="w-1/3 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                                placeholder="key"
                              />
                              <input
                                value={step.label}
                                onChange={(e) => {
                                  const steps = [...(runtime.available_steps || [])];
                                  steps[si] = { ...steps[si], label: e.target.value };
                                  updateRuntime(index, { available_steps: steps });
                                }}
                                className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                                placeholder="Label description"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const steps = (runtime.available_steps || []).filter((_: unknown, i: number) => i !== si);
                                  updateRuntime(index, { available_steps: steps.length ? steps : undefined });
                                }}
                                className="text-zinc-600 hover:text-red-400 text-[10px] px-1"
                              >x</button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Outputs Schema Editor */}
                      {runtime.writes?.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest">Output Schema</label>
                            <button
                              type="button"
                              onClick={() => {
                                const rawWrites = (runtime.writes || []) as Array<string | { key: string }>;
                                const outputs: StageOutputSchema = {};
                                for (const raw of rawWrites) {
                                  const w = typeof raw === "string" ? raw : raw.key;
                                  outputs[w] = { type: "object", label: w, fields: [{ key: "example", type: "string", description: "Description" }] };
                                }
                                updateStage(index, { outputs });
                              }}
                              className="text-[8px] font-bold text-blue-400 hover:underline"
                            >
                              {stage.outputs ? "Reset" : "Generate"}
                            </button>
                          </div>
                          {stage.outputs && Object.entries(stage.outputs).map(([storeKey, schema]) => (
                            <div key={storeKey} className="rounded border border-zinc-800 bg-zinc-950 p-2 space-y-1 min-w-0 overflow-hidden">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-[9px] font-bold text-zinc-400 shrink-0 truncate max-w-[80px]">{storeKey}</span>
                                <input
                                  value={schema.label ?? ""}
                                  onChange={(e) => {
                                    const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                    newOutputs[storeKey].label = e.target.value;
                                    updateStage(index, { outputs: newOutputs });
                                  }}
                                  className="flex-1 min-w-0 bg-transparent border-b border-zinc-800 text-[9px] text-zinc-300 outline-none px-1"
                                  placeholder="Label..."
                                />
                                <label className="flex items-center gap-1 text-[8px] text-zinc-500 shrink-0 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={schema.hidden ?? false}
                                    onChange={(e) => {
                                      const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                      newOutputs[storeKey].hidden = e.target.checked;
                                      updateStage(index, { outputs: newOutputs });
                                    }}
                                    className="w-3 h-3 rounded border-zinc-700 bg-zinc-950"
                                  />
                                  Hidden
                                </label>
                              </div>
                              {schema.fields.map((field: OutputField, fi: number) => (
                                <div key={fi} className="grid grid-cols-[1fr_auto] gap-x-1.5 gap-y-0.5 py-1 border-b border-zinc-800/30 last:border-0 items-center">
                                  <input
                                    value={field.key}
                                    onChange={(e) => {
                                      const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                      newOutputs[storeKey].fields[fi].key = e.target.value;
                                      updateStage(index, { outputs: newOutputs });
                                    }}
                                    className="min-w-0 bg-transparent border-b border-zinc-800 text-[9px] text-zinc-300 outline-none font-mono"
                                    placeholder="key"
                                  />
                                  <div className="flex items-center gap-1">
                                    <select
                                      value={field.type}
                                      onChange={(e) => {
                                        const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                        newOutputs[storeKey].fields[fi].type = e.target.value;
                                        updateStage(index, { outputs: newOutputs });
                                      }}
                                      className="w-[70px] bg-zinc-950 border border-zinc-800 rounded text-[8px] text-zinc-400 outline-none"
                                    >
                                      {["string", "number", "boolean", "string[]", "object", "object[]", "markdown"].map(t => (
                                        <option key={t} value={t}>{t}</option>
                                      ))}
                                    </select>
                                    <select
                                      value={field.display_hint || ""}
                                      onChange={(e) => {
                                        const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                        newOutputs[storeKey].fields[fi].display_hint = e.target.value || undefined;
                                        updateStage(index, { outputs: newOutputs });
                                      }}
                                      className="w-[52px] bg-zinc-950 border border-zinc-800 rounded text-[8px] text-zinc-400 outline-none"
                                    >
                                      <option value="">hint</option>
                                      <option value="badge">badge</option>
                                      <option value="link">link</option>
                                      <option value="code">code</option>
                                    </select>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                        newOutputs[storeKey].fields.splice(fi, 1);
                                        updateStage(index, { outputs: newOutputs });
                                      }}
                                      className="text-zinc-600 hover:text-red-400 text-[10px]"
                                    >x</button>
                                  </div>
                                  <input
                                    value={field.description}
                                    onChange={(e) => {
                                      const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                      newOutputs[storeKey].fields[fi].description = e.target.value;
                                      updateStage(index, { outputs: newOutputs });
                                    }}
                                    className="col-span-2 min-w-0 bg-transparent border-b border-zinc-800/50 text-[9px] text-zinc-500 outline-none pl-1 italic"
                                    placeholder="description..."
                                  />
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() => {
                                  const newOutputs = JSON.parse(JSON.stringify(stage.outputs));
                                  newOutputs[storeKey].fields.push({ key: "", type: "string", description: "" });
                                  updateStage(index, { outputs: newOutputs });
                                }}
                                className="text-[8px] text-blue-400 hover:underline"
                              >
                                + Add Field
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Advanced Agent Settings */}
                      <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setExpandedAdvanced(prev => ({ ...prev, [index]: !prev[index] }))}
                          className="w-full flex items-center justify-between px-3 py-1.5 text-[9px] font-bold uppercase text-zinc-500 tracking-widest hover:bg-zinc-800/20 transition-colors"
                        >
                          <span>Advanced</span>
                          <svg className={`w-3 h-3 transition-transform ${isAdvancedOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        {isAdvancedOpen && (
                          <div className="px-3 pb-3 space-y-2 border-t border-zinc-800/50">
                            <div className="grid grid-cols-2 gap-2 pt-2">
                              <div className="space-y-0.5">
                                <label className="text-[8px] font-bold uppercase text-zinc-600 block">Model</label>
                                <input
                                  value={stage.model || ""}
                                  onChange={(e) => updateStage(index, { model: e.target.value || undefined })}
                                  className="w-full h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 focus:outline-none"
                                  placeholder="claude-sonnet-4-20250514"
                                />
                              </div>
                              <div className="space-y-0.5">
                                <label className="text-[8px] font-bold uppercase text-zinc-600 block">Max Turns</label>
                                <input
                                  type="number"
                                  value={stage.max_turns ?? ""}
                                  onChange={(e) => updateStage(index, { max_turns: e.target.value ? Number(e.target.value) : undefined })}
                                  className="w-full h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 focus:outline-none"
                                  placeholder="30"
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2 items-end">
                              <div>
                                <label className="text-[8px] font-bold uppercase text-zinc-600 block mb-0.5">Budget</label>
                                <input
                                  type="number"
                                  step={0.5}
                                  value={stage.max_budget_usd ?? ""}
                                  onChange={(e) => updateStage(index, { max_budget_usd: e.target.value ? Number(e.target.value) : undefined })}
                                  className="w-full h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  placeholder="2.0"
                                />
                              </div>
                              <div>
                                <label className="text-[8px] font-bold uppercase text-zinc-600 block mb-0.5">Thinking</label>
                                <select
                                  value={(stage as any).thinking?.type || "disabled"}
                                  onChange={(e) => updateStage(index, { thinking: { type: e.target.value } })}
                                  className="w-full h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 focus:outline-none"
                                >
                                  <option value="disabled">Disabled</option>
                                  <option value="enabled">Enabled</option>
                                  <option value="adaptive">Adaptive</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-[8px] font-bold uppercase text-zinc-600 block mb-0.5">Effort</label>
                                <select
                                  value={stage.effort || ""}
                                  onChange={(e) => updateStage(index, { effort: (e.target.value || undefined) as Stage["effort"] })}
                                  className="w-full h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 focus:outline-none"
                                >
                                  <option value="">Default</option>
                                  <option value="low">Low</option>
                                  <option value="medium">Medium</option>
                                  <option value="high">High</option>
                                  <option value="max">Max</option>
                                </select>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 items-end">
                              <div>
                                <label className="text-[8px] font-bold uppercase text-zinc-600 block mb-0.5">Permission Mode</label>
                                <select
                                  value={stage.permission_mode || "bypassPermissions"}
                                  onChange={(e) => updateStage(index, { permission_mode: e.target.value as Stage["permission_mode"] })}
                                  className="w-full h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 focus:outline-none"
                                >
                                  <option value="bypassPermissions">Bypass (default)</option>
                                  <option value="plan">Plan (read-only)</option>
                                  <option value="acceptEdits">Accept Edits</option>
                                  <option value="default">Prompt</option>
                                  <option value="dontAsk">Don't Ask</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-[8px] font-bold uppercase text-zinc-600 block mb-0.5">Notion Label</label>
                                <input
                                  value={stage.notion_label || ""}
                                  onChange={(e) => updateStage(index, { notion_label: e.target.value || undefined })}
                                  className="w-full h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 focus:outline-none"
                                  placeholder="Analyzing"
                                />
                              </div>
                            </div>
                            <div className="space-y-0.5">
                              <label className="text-[8px] font-bold uppercase text-zinc-600 block">MCPs</label>
                              <input
                                value={stage.mcps?.join(", ") || ""}
                                onChange={(e) => updateStage(index, { mcps: e.target.value ? e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined })}
                                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                                placeholder="notion, figma, context7"
                              />
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={stage.debug ?? false}
                                  onChange={(e) => updateStage(index, { debug: e.target.checked || undefined })}
                                  className="w-3 h-3 rounded border-zinc-700 bg-zinc-950 accent-blue-500"
                                />
                                <span className="text-[8px] font-bold uppercase text-zinc-600">Debug Logging</span>
                              </label>
                            </div>
                            <div className="space-y-0.5">
                              <label className="text-[8px] font-bold uppercase text-zinc-600 block">Notify on Complete</label>
                              <input
                                value={stage.on_complete?.notify || ""}
                                onChange={(e) => updateStage(index, { on_complete: e.target.value ? { notify: e.target.value } : undefined })}
                                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                                placeholder="analysis_complete"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {stage.type === "script" && (
                    <>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Automation Script</label>
                          <button
                            onClick={() => setSelectedScriptId(runtime.script_id || null)}
                            className="text-[8px] font-bold text-blue-400 hover:underline"
                          >
                            Show Help
                          </button>
                        </div>
                        <select
                          value={runtime.script_id || ""}
                          onChange={(e) => updateRuntime(index, { script_id: e.target.value })}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:outline-none appearance-none"
                        >
                          {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          {scripts.length === 0 && <option value="">No scripts loaded...</option>}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Writes to Context</label>
                        <input
                          value={runtime.writes ? (runtime.writes as Array<string | { key: string }>).map((w: string | { key: string }) => typeof w === "string" ? w : w.key).join(", ") : ""}
                          onChange={(e) => {
                            const keys = e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean);
                            const existing = (runtime.writes ?? []) as Array<string | { key: string }>;
                            const byKey = new Map(existing.map((w: string | { key: string }) => [typeof w === "string" ? w : w.key, w]));
                            const writes = keys.map((k: string) => byKey.get(k) ?? k);
                            updateRuntime(index, { writes });
                          }}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:outline-none"
                          placeholder="worktreeResult, prUrl..."
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Reads from Context</label>
                        <ReadsEditor
                          entries={(runtime.reads as Record<string, string>) || {}}
                          availablePaths={uniquePaths}
                          onChange={(reads) => updateRuntime(index, { reads })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Static Args</label>
                        <KeyValueEditor
                          entries={Object.fromEntries(Object.entries(runtime.args || {}).map(([k, v]) => [k, String(v)]))}
                          onChange={(args) => updateRuntime(index, { args })}
                          keyPlaceholder="argName"
                          valuePlaceholder="value"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-0.5">
                          <label className="text-[8px] font-bold uppercase text-zinc-600 block">Timeout (sec)</label>
                          <input
                            type="number"
                            value={runtime.timeout_sec ?? ""}
                            onChange={(e) => updateRuntime(index, { timeout_sec: e.target.value ? Number(e.target.value) : undefined })}
                            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                            placeholder="120"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <label className="text-[8px] font-bold uppercase text-zinc-600 block">Notion Label</label>
                          <input
                            value={stage.notion_label || ""}
                            onChange={(e) => updateStage(index, { notion_label: e.target.value || undefined })}
                            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                            placeholder="Building"
                          />
                        </div>
                      </div>
                      <div className="space-y-0.5">
                        <label className="text-[8px] font-bold uppercase text-zinc-600 block">Notify on Complete</label>
                        <input
                          value={stage.on_complete?.notify || ""}
                          onChange={(e) => updateStage(index, { on_complete: e.target.value ? { notify: e.target.value } : undefined })}
                          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                          placeholder="script_done"
                        />
                      </div>
                    </>
                  )}

                  {stage.type === "human_confirm" && (
                    <>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest block">Notification Template</label>
                        <input
                          value={runtime.notify?.template || ""}
                          onChange={(e) => updateRuntime(index, { notify: e.target.value ? { type: "slack", template: e.target.value } : undefined })}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:outline-none"
                          placeholder="design-ready, spec-ready, generic..."
                        />
                      </div>
                      <div className="space-y-0.5">
                        <label className="text-[8px] font-bold uppercase text-zinc-600 block">Notion Label</label>
                        <input
                          value={stage.notion_label || ""}
                          onChange={(e) => updateStage(index, { notion_label: e.target.value || undefined })}
                          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 focus:outline-none"
                          placeholder="Pending Review"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Footer: Knowledge Fragments (read-only, resolved by registry) */}
              {stage.type === "agent" && (
                <div className="pt-3 mt-1 border-t border-zinc-800/30">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="text-[8px] font-bold uppercase text-zinc-600 mt-1 mr-1">Knowledge:</span>
                    {Object.entries(fragmentRegistry).map(([id, meta]) => {
                      const stageMatch = meta.stages === "*" || (meta.stages as string[]).includes(stage.name);
                      if (!stageMatch) return null;
                      const isAlways = meta.always;
                      return (
                        <span
                          key={id}
                          className={`rounded px-2 py-0.5 text-[9px] font-medium border ${isAlways ? "bg-blue-900/20 border-blue-500/50 text-blue-300" : "bg-zinc-900 border-zinc-800 text-zinc-500"}`}
                          title={isAlways ? "always" : `keywords: ${meta.keywords.join(", ")}`}
                        >
                          {id}
                          {isAlways && <span className="ml-1 text-[7px] text-blue-400/70">always</span>}
                          {!isAlways && meta.keywords.length > 0 && <span className="ml-1 text-[7px] text-zinc-600">{meta.keywords.join(",")}</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className="relative pt-2">
          <button
            type="button"
            onClick={() => setShowTemplateMenu(!showTemplateMenu)}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-900/40 py-4 text-xs font-bold text-zinc-500 hover:border-blue-500/50 hover:bg-blue-500/5 hover:text-blue-400 transition-all flex items-center justify-center gap-2 group"
          >
            <span className="text-lg group-hover:scale-125 transition-transform">+</span>
            Add New Stage
          </button>

          {showTemplateMenu && (
            <div className="absolute bottom-full left-0 right-0 mb-4 bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-2xl z-10 grid grid-cols-3 gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="col-span-3 px-1 pb-1 text-[9px] font-bold text-zinc-600 uppercase tracking-widest">Select Stage Type</div>
              {RUNTIME_TEMPLATES.map(t => (
                <button
                  key={t.name}
                  onClick={() => addFromTemplate(t)}
                  className="flex flex-col gap-0.5 p-2.5 rounded-lg border border-zinc-800 hover:border-blue-500/50 hover:bg-blue-500/5 text-left transition-all group"
                >
                  <span className="text-[11px] font-bold text-zinc-200 group-hover:text-blue-400">{t.label}</span>
                  <span className="text-[8px] text-zinc-600 leading-tight italic uppercase">{t.engine} engine</span>
                </button>
              ))}
              <button
                onClick={() => setShowTemplateMenu(false)}
                className="col-span-3 mt-1 py-1.5 text-[9px] text-zinc-600 hover:text-zinc-400 text-center uppercase tracking-widest font-bold border-t border-zinc-800"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PipelineBuilder;
