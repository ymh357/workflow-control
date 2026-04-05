"use client";

import React, { useState } from "react";
import { useTranslations } from "next-intl";
import CodeEditor from "@/components/code-editor";
import type { FragmentMeta } from "@/lib/pipeline-types";

const KNOWN_AGENT_STAGES = ["analyzing", "techPrep", "specGeneration", "implementing", "qualityAssurance"];

// --- Fragment meta editor (inline) ---

const FragmentMetaBar = ({
  meta,
  onUpdate,
}: {
  meta: FragmentMeta;
  onUpdate: (m: FragmentMeta) => void;
}) => {
  const t = useTranslations("Config");
  const [kwInput, setKwInput] = useState("");

  const addKeyword = () => {
    const kw = kwInput.trim().toLowerCase();
    if (kw && !meta.keywords.includes(kw)) {
      onUpdate({ ...meta, keywords: [...meta.keywords, kw] });
    }
    setKwInput("");
  };

  return (
    <div className="flex flex-wrap gap-3 items-center bg-zinc-900/50 border border-zinc-800 rounded-lg p-2.5 text-xs">
      {/* Keywords */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-medium text-zinc-600">Keywords:</span>
        {meta.keywords.map((kw) => (
          <span key={kw} className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 border border-zinc-700">
            {kw}
            <button onClick={() => onUpdate({ ...meta, keywords: meta.keywords.filter((k) => k !== kw) })} className="text-zinc-500 hover:text-red-400">&times;</button>
          </span>
        ))}
        <input
          value={kwInput}
          onChange={(e) => setKwInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addKeyword()}
          placeholder="add..."
          className="w-20 bg-transparent border-b border-zinc-700 text-[11px] text-zinc-400 px-1 py-0.5 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Stages */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-medium text-zinc-600">Stages:</span>
        <button
          onClick={() => onUpdate({ ...meta, stages: meta.stages === "*" ? [] : "*" })}
          className={`rounded px-2 py-0.5 text-[11px] font-medium border transition-all ${
            meta.stages === "*" ? "bg-purple-900/20 border-purple-500/50 text-purple-300" : "bg-zinc-900 border-zinc-800 text-zinc-600"
          }`}
        >
          ALL
        </button>
        {meta.stages !== "*" &&
          KNOWN_AGENT_STAGES.map((s) => (
            <button
              key={s}
              onClick={() => {
                const cur = meta.stages as string[];
                const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
                onUpdate({ ...meta, stages: next });
              }}
              className={`rounded px-2 py-0.5 text-[11px] font-medium border transition-all ${
                (meta.stages as string[]).includes(s)
                  ? "bg-blue-900/20 border-blue-500/50 text-blue-300"
                  : "bg-zinc-900 border-zinc-800 text-zinc-600"
              }`}
            >
              {s}
            </button>
          ))}
      </div>

      {/* Always */}
      <button
        onClick={() => onUpdate({ ...meta, always: !meta.always })}
        className={`rounded px-2 py-0.5 text-[11px] font-medium border transition-all ${
          meta.always ? "bg-green-900/20 border-green-500/50 text-green-300" : "bg-zinc-900 border-zinc-800 text-zinc-600"
        }`}
      >
        {t("always")} {meta.always ? t("on") : t("off")}
      </button>
    </div>
  );
};

// --- Types ---

type GlobalSelection =
  | { type: "constraints" }
  | { type: "claudeMd" }
  | { type: "geminiMd" }
  | { type: "codexMd" }
  | { type: "fragments" };

interface GlobalEditorProps {
  selection: GlobalSelection;
  constraints: string;
  claudeMd: string;
  geminiMd: string;
  codexMd: string;
  fragments: Record<string, string>;
  fragmentMeta: Record<string, FragmentMeta>;
  onConstraintsChange: (v: string) => void;
  onClaudeMdChange: (v: string) => void;
  onGeminiMdChange: (v: string) => void;
  onCodexMdChange: (v: string) => void;
  onFragmentChange: (name: string, content: string) => void;
  onFragmentMetaChange: (name: string, meta: FragmentMeta) => void;
  onFragmentAdd: (name: string) => void;
  onFragmentDelete: (name: string) => void;
  readOnly?: boolean;
}

const GlobalEditor = ({
  selection,
  constraints,
  claudeMd,
  geminiMd,
  codexMd,
  fragments,
  fragmentMeta,
  onConstraintsChange,
  onClaudeMdChange,
  onGeminiMdChange,
  onCodexMdChange,
  onFragmentChange,
  onFragmentMetaChange,
  onFragmentAdd,
  onFragmentDelete,
  readOnly = false,
}: GlobalEditorProps) => {
  const t = useTranslations("Config");
  const [activeFragment, setActiveFragment] = useState<string>(Object.keys(fragments)[0] || "");
  const [addingFragment, setAddingFragment] = useState(false);
  const [newFragName, setNewFragName] = useState("");

  if (selection.type === "constraints") {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 mb-3">
          <h3 className="text-sm font-bold text-zinc-100">{t("globalConstraints")}</h3>
          <p className="text-xs text-zinc-500 mt-0.5">{t("globalConstraintsDesc")}</p>
        </div>
        <div className="flex-1" style={{ minHeight: 300 }}>
          <CodeEditor language="markdown" value={constraints} onChange={(v) => onConstraintsChange(v ?? "")} readOnly={readOnly} height="100%" />
        </div>
      </div>
    );
  }

  if (selection.type === "claudeMd" || selection.type === "geminiMd" || selection.type === "codexMd") {
    const mdConfigs: Record<string, { title: string; desc: string; value: string; onChange: (v: string) => void }> = {
      claudeMd: { title: t("claudeMd"), desc: t("claudeMdDesc"), value: claudeMd, onChange: (v) => onClaudeMdChange(v) },
      geminiMd: { title: t("geminiMd"), desc: t("geminiMdDesc"), value: geminiMd, onChange: (v) => onGeminiMdChange(v) },
      codexMd: { title: t("codexMd"), desc: t("codexMdDesc"), value: codexMd, onChange: (v) => onCodexMdChange(v) },
    };
    const cfg = mdConfigs[selection.type];
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 mb-3">
          <h3 className="text-sm font-bold text-zinc-100">{cfg.title}</h3>
          <p className="text-xs text-zinc-500 mt-0.5">{cfg.desc}</p>
        </div>
        <div className="flex-1" style={{ minHeight: 300 }}>
          <CodeEditor language="markdown" value={cfg.value} onChange={(v) => cfg.onChange(v ?? "")} readOnly={readOnly} height="100%" />
        </div>
      </div>
    );
  }

  // Fragments
  const fragNames = Object.keys(fragments);
  const currentMeta = activeFragment ? fragmentMeta[activeFragment] : null;

  const handleAdd = () => {
    const name = newFragName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (name && !fragments[name]) {
      onFragmentAdd(name);
      setActiveFragment(name);
    }
    setNewFragName("");
    setAddingFragment(false);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 mb-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">{t("knowledgeFragments")}</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              {t("knowledgeFragmentsDesc")}
            </p>
          </div>
        </div>
      </div>

      {/* Fragment tabs */}
      <div className="flex flex-wrap gap-1.5 items-center shrink-0 mb-2">
        {fragNames.map((name) => (
          <div key={name} className="group relative">
            <button
              onClick={() => setActiveFragment(name)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-all ${
                activeFragment === name
                  ? "bg-blue-900/40 text-blue-300 border border-blue-800/50"
                  : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-400 border border-transparent"
              }`}
            >
              {name}
            </button>
            {!readOnly && (
              <button
                onClick={() => { onFragmentDelete(name); if (activeFragment === name) setActiveFragment(fragNames.filter((n) => n !== name)[0] || ""); }}
                className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-red-950 text-[9px] text-red-400 hover:bg-red-900 border border-red-900/50 group-hover:flex"
              >
                &times;
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          addingFragment ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={newFragName}
                onChange={(e) => setNewFragName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setAddingFragment(false); }}
                onBlur={() => { if (!newFragName.trim()) setAddingFragment(false); }}
                placeholder="fragment-name"
                className="w-32 rounded border border-blue-600 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none"
              />
              <button onClick={handleAdd} className="text-xs text-blue-400 hover:text-blue-300 font-medium">Add</button>
            </div>
          ) : (
            <button
              onClick={() => setAddingFragment(true)}
              className="rounded border border-dashed border-zinc-700 px-2.5 py-1 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
            >
              +
            </button>
          )
        )}
      </div>

      {/* Fragment meta */}
      {currentMeta && !readOnly && (
        <div className="shrink-0 mb-2">
          <FragmentMetaBar meta={currentMeta} onUpdate={(m) => onFragmentMetaChange(activeFragment, m)} />
        </div>
      )}

      {/* Fragment content */}
      <div className="flex-1 min-h-0">
        {activeFragment && fragments[activeFragment] != null ? (
          <CodeEditor
            language="markdown"
            value={fragments[activeFragment]}
            onChange={(v) => onFragmentChange(activeFragment, v ?? "")}
            readOnly={readOnly}
            height="100%"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-zinc-600 text-sm italic">
            {t("selectFragment")}
          </div>
        )}
      </div>
    </div>
  );
};

export default GlobalEditor;
