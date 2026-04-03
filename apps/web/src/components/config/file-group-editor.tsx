"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import CodeEditor from "@/components/code-editor";
import type { FragmentMeta } from "@/lib/pipeline-types";

interface FragmentFrontmatter {
  keywords: string[];
  stages: string[] | "*";
  always: boolean;
}

function parseFrontmatter(raw: string): { frontmatter: FragmentFrontmatter | null; body: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) return { frontmatter: null, body: trimmed };
  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return { frontmatter: null, body: trimmed };

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  try {
    const lines = yamlBlock.split("\n");
    const fm: FragmentFrontmatter = { keywords: [], stages: [], always: false };

    for (const line of lines) {
      const trimLine = line.trim();
      if (!trimLine) continue;

      if (trimLine.startsWith("always:")) {
        fm.always = trimLine.includes("true");
      } else if (trimLine.startsWith("keywords:")) {
        const val = trimLine.slice("keywords:".length).trim();
        if (val.startsWith("[")) {
          fm.keywords = val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
        }
      } else if (trimLine.startsWith("stages:")) {
        const val = trimLine.slice("stages:".length).trim();
        if (val === '"*"' || val === "'*'" || val === "*") {
          fm.stages = "*";
        } else if (val.startsWith("[")) {
          fm.stages = val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
        }
      }
    }
    return { frontmatter: fm, body };
  } catch {
    return { frontmatter: null, body: trimmed };
  }
}

function buildFrontmatter(id: string, fm: FragmentFrontmatter): string {
  const kwStr = fm.keywords.length > 0 ? `[${fm.keywords.join(", ")}]` : "[]";
  const stStr = fm.stages === "*" ? '"*"' : `[${(fm.stages as string[]).join(", ")}]`;
  return `---\nid: ${id}\nkeywords: ${kwStr}\nstages: ${stStr}\nalways: ${fm.always}\n---`;
}

const KNOWN_AGENT_STAGES = ["analyzing", "techPrep", "specGeneration", "implementing", "qualityAssurance"];

interface FileGroupEditorProps {
  files: Record<string, string>;
  fragmentMeta?: Record<string, FragmentMeta>; // New: support external meta (from snapshot)
  title: string;
  description: string;
  onUpdate: (name: string, content: string) => void;
  onUpdateMeta?: (name: string, meta: FragmentMeta) => void; // New: support meta update
  onAdd?: (name: string) => void;
  onDelete?: (name: string) => void;
  language?: "markdown" | "yaml" | "typescript";
  readOnly?: boolean;
  category?: "system" | "fragments";
}

const FileGroupEditor = ({
  files, fragmentMeta, title, description, onUpdate, onUpdateMeta, onAdd, onDelete,
  language = "markdown", readOnly = false, category
}: FileGroupEditorProps) => {
  const t = useTranslations("Config");
  const fileNames = Object.keys(files);
  const [activeFile, setActiveFile] = useState<string>(fileNames[0] || "");
  const [keywordInput, setKeywordInput] = useState("");

  const currentMeta = useMemo(() => {
    if (category !== "fragments" || !activeFile) return null;
    // Prefer external fragmentMeta (from task config), fallback to parsing
    if (fragmentMeta && fragmentMeta[activeFile]) return fragmentMeta[activeFile];
    return parseFrontmatter(files[activeFile] || "").frontmatter;
  }, [category, activeFile, files, fragmentMeta]);

  const handleAdd = () => {
    const name = prompt(`Enter new item name:`);
    if (name && onAdd) onAdd(name);
  };

  const updateMetadata = (update: Partial<FragmentFrontmatter>) => {
    if (!currentMeta || !activeFile) return;
    const newFm = { ...currentMeta, ...update } as FragmentMeta;
    
    // If we have an external meta updater (task mode), use it
    if (onUpdateMeta) {
      onUpdateMeta(activeFile, newFm);
    } else {
      // Global mode: still sync back to file content via frontmatter
      const { body } = parseFrontmatter(files[activeFile] || "");
      const newContent = `${buildFrontmatter(activeFile, newFm)}\n${body}`;
      onUpdate(activeFile, newContent);
    }
  };

  const handleKeywordAdd = () => {
    if (!keywordInput.trim() || !currentMeta) return;
    const newKw = keywordInput.trim().toLowerCase();
    if (!currentMeta.keywords.includes(newKw)) {
      updateMetadata({ keywords: [...currentMeta.keywords, newKw] });
    }
    setKeywordInput("");
  };

  const handleKeywordRemove = (kw: string) => {
    if (!currentMeta) return;
    updateMetadata({ keywords: currentMeta.keywords.filter(k => k !== kw) });
  };

  const handleStageToggle = (stage: string) => {
    if (!currentMeta) return;
    if (currentMeta.stages === "*") {
      updateMetadata({ stages: KNOWN_AGENT_STAGES.filter(s => s !== stage) });
    } else {
      const current = currentMeta.stages as string[];
      const next = current.includes(stage) ? current.filter(s => s !== stage) : [...current, stage];
      updateMetadata({ stages: next });
    }
  };

  const handleAlwaysToggle = () => {
    if (!currentMeta) return;
    updateMetadata({ always: !currentMeta.always });
  };

  const handleAllStagesToggle = () => {
    if (!currentMeta) return;
    updateMetadata({ stages: currentMeta.stages === "*" ? [] : "*" });
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex flex-wrap gap-2 items-center shrink-0">
        {fileNames.map((name) => (
          <div key={name} className="group relative">
            <button
              onClick={() => setActiveFile(name)}
              className={`rounded px-3 py-1 text-xs font-medium transition-all ${
                activeFile === name
                  ? "bg-blue-900/40 text-blue-300 border border-blue-800/50 shadow-sm"
                  : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-400 border border-transparent"
              }`}
            >
              {name}
            </button>
            {!readOnly && onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(name); }}
                className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-red-950 text-[8px] text-red-400 hover:bg-red-900 border border-red-900/50 group-hover:flex shadow-sm"
              >
                &times;
              </button>
            )}
          </div>
        ))}
        {!readOnly && onAdd && (
          <button
            onClick={handleAdd}
            className="rounded border border-dashed border-zinc-700 px-3 py-1 text-[10px] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {t("addNew")}
          </button>
        )}
      </div>

      {/* Frontmatter editor for fragments */}
      {category === "fragments" && currentMeta && !readOnly && (
        <div className="flex flex-wrap gap-4 items-center bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 shrink-0">
          {/* Keywords */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[8px] font-bold uppercase text-zinc-600">Keywords:</span>
            {currentMeta.keywords.map(kw => (
              <span key={kw} className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[9px] text-zinc-300 border border-zinc-700">
                {kw}
                <button onClick={() => handleKeywordRemove(kw)} className="text-zinc-500 hover:text-red-400 text-[8px]">&times;</button>
              </span>
            ))}
            <input
              value={keywordInput}
              onChange={e => setKeywordInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleKeywordAdd()}
              placeholder="add keyword..."
              className="w-24 bg-transparent border-b border-zinc-700 text-[9px] text-zinc-400 px-1 py-0.5 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Stages */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[8px] font-bold uppercase text-zinc-600">Stages:</span>
            <button
              onClick={handleAllStagesToggle}
              className={`rounded px-2 py-0.5 text-[9px] font-medium border transition-all ${currentMeta.stages === "*" ? "bg-purple-900/20 border-purple-500/50 text-purple-300" : "bg-zinc-900 border-zinc-800 text-zinc-600"}`}
            >
              {t("allStages")}
            </button>
            {currentMeta.stages !== "*" && KNOWN_AGENT_STAGES.map(s => (
              <button
                key={s}
                onClick={() => handleStageToggle(s)}
                className={`rounded px-2 py-0.5 text-[9px] font-medium border transition-all ${(currentMeta!.stages as string[]).includes(s) ? "bg-blue-900/20 border-blue-500/50 text-blue-300" : "bg-zinc-900 border-zinc-800 text-zinc-600"}`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Always toggle */}
          <div className="flex items-center gap-2">
            <span className="text-[8px] font-bold uppercase text-zinc-600">{t("always")}</span>
            <button
              onClick={handleAlwaysToggle}
              className={`rounded px-3 py-0.5 text-[9px] font-medium border transition-all ${currentMeta.always ? "bg-green-900/20 border-green-500/50 text-green-300" : "bg-zinc-900 border-zinc-800 text-zinc-600"}`}
            >
              {currentMeta.always ? t("on") : t("off")}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {activeFile ? (
          <CodeEditor
            language={language}
            value={files[activeFile] || ""}
            onChange={(val) => onUpdate(activeFile, val || "")}
            height="100%"
            readOnly={readOnly}
          />
        ) : (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-zinc-800 bg-zinc-950/50 text-zinc-600 text-sm italic">
            {t("noItemsSelected")}
          </div>
        )}
      </div>
    </div>
  );
};

export default FileGroupEditor;
