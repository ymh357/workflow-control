"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import ConfigWorkbench from "@/components/config-workbench";
import RawYamlEditor from "@/components/config/raw-yaml-editor";
import SandboxPanel from "@/components/config/sandbox-panel";
import type { SandboxConfig } from "@/components/config/sandbox-panel";
import { useToast } from "@/components/toast";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import type { FragmentMeta } from "@/lib/pipeline-types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function normalizePromptKey(filename: string): string {
  const base = filename.replace(/\.md$/, "");
  return base.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function rebuildFragmentFile(content: string, meta: FragmentMeta): string {
  const lines = [
    "---",
    `id: ${meta.id}`,
  ];
  if (meta.keywords?.length) lines.push(`keywords: [${meta.keywords.join(", ")}]`);
  if (meta.stages === "*") {
    lines.push(`stages: "*"`);
  } else if (Array.isArray(meta.stages) && meta.stages.length) {
    lines.push(`stages: [${meta.stages.join(", ")}]`);
  }
  if (meta.always) lines.push("always: true");
  lines.push("---", "");
  lines.push(content);
  return lines.join("\n");
}

interface SystemFullView {
  environment: {
    os: string;
    nodeVersion: string;
    preflight: Array<{ name: string; ok: boolean; detail?: string }>;
    effectivePaths: Record<string, string>;
  };
  notifications: {
    slackConfigured: boolean;
    slackSocketMode: boolean;
    channelId?: string;
  };
  capabilities: {
    skills: string[];
    mcps: Array<{ name: string; description: string; available: boolean }>;
  };
  sandbox?: {
    enabled: boolean;
  };
}

interface PipelineManifest {
  id: string;
  name: string;
  description?: string;
  engine: "claude" | "gemini" | "mixed";
  official?: boolean;
  stageCount?: number;
  totalBudget?: number;
  mcps?: string[];
  stageSummary?: string;
}

const ConfigPage = () => {
  const t = useTranslations("Config");
  const tc = useTranslations("Common");
  const toast = useToast();
  const searchParams = useSearchParams();
  const [activeMainTab, setActiveMainTab] = useState<"infrastructure" | "workbench">("infrastructure");
  const [infraSubTab, setInfraSubTab] = useState<"health" | "settings" | "mcps" | "sandbox">("health");

  const [systemView, setSystemView] = useState<SystemFullView | null>(null);
  const [settingsRaw, setSettingsRaw] = useState("");
  const [mcpRaw, setMcpRaw] = useState("");

  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig>({ enabled: false });
  const [sandboxSaving, setSandboxSaving] = useState(false);

  const [workbenchConfig, setWorkbenchConfig] = useState<any>(null);
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [availablePipelines, setAvailablePipelines] = useState<PipelineManifest[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // CRUD modal state
  const [showNewPipelineModal, setShowNewPipelineModal] = useState(false);
  const [newPipelineId, setNewPipelineId] = useState("");
  const [newPipelineCopyFrom, setNewPipelineCopyFrom] = useState("");

  // AI Generate state
  const [showAiGenerateModal, setShowAiGenerateModal] = useState(false);
  const [aiDescription, setAiDescription] = useState("");
  const [aiEngine, setAiEngine] = useState<"auto" | "claude" | "gemini">("auto");
  const [aiPhase, setAiPhase] = useState<"idle" | "generating" | "saving">("idle");
  const [aiResult, setAiResult] = useState<{
    pipelineId: string;
    pipelineFile: string;
    promptFiles: string[];
    scriptFiles: string[];
    warnings: string[];
    capabilityDiscovery?: {
      autoInstalledMcps: string[];
      autoInstalledSkills: string[];
      mcpsNeedingKeys: Array<{ name: string; envVars: string[] }>;
    };
  } | null>(null);
  const [deletingPipeline, setDeletingPipeline] = useState<string | null>(null);

  const loadInfra = useCallback(async () => {
    try {
      const [sysRes, setRes, mcpRes, sandboxRes, pipelinesRes] = await Promise.all([
        fetch(`${API_BASE}/api/config/system`),
        fetch(`${API_BASE}/api/config/settings`),
        fetch(`${API_BASE}/api/config/mcps`),
        fetch(`${API_BASE}/api/config/sandbox`),
        fetch(`${API_BASE}/api/config/pipelines`),
      ]);

      if (sysRes.ok) setSystemView(await sysRes.json());
      if (setRes.ok) {
        const settingsParsed = await setRes.json();
        setSettingsRaw(settingsParsed.raw || "");
      }
      if (sandboxRes.ok) setSandboxConfig(await sandboxRes.json());
      if (mcpRes.ok) setMcpRaw((await mcpRes.json()).raw || "");
      if (pipelinesRes.ok) {
        const data = await pipelinesRes.json();
        setAvailablePipelines(data.pipelines ?? []);
      }
    } catch (err) { console.error("Infra load failed", err); }
  }, []);

  const loadPipelineConfig = useCallback(async (pipelineId: string) => {
    try {
      const [pipeRes, constraintsRes, promptListRes, claudemdRes, settingsRes, sandboxRes] = await Promise.all([
        fetch(`${API_BASE}/api/config/pipelines/${pipelineId}`),
        fetch(`${API_BASE}/api/config/pipelines/${pipelineId}/prompts/constraints`),
        fetch(`${API_BASE}/api/config/pipelines/${pipelineId}/prompts/system`),
        fetch(`${API_BASE}/api/config/claude-md/global/global.md`),
        fetch(`${API_BASE}/api/config/settings`),
        fetch(`${API_BASE}/api/config/sandbox`),
      ]);

      if (!pipeRes.ok) return;
      const pipeData = await pipeRes.json();
      const constraintsData = constraintsRes.ok ? await constraintsRes.json() : { content: "" };
      const promptList = promptListRes.ok ? await promptListRes.json() : { prompts: [] };

      const cmdData = claudemdRes.ok ? await claudemdRes.json() : { content: "" };
      let gmdContent = "";
      try {
        const gmdRes = await fetch(`${API_BASE}/api/config/gemini-md/global/global.md`);
        if (gmdRes.ok) gmdContent = (await gmdRes.json()).content;
      } catch { /* ignore */ }

      const system: Record<string, string> = {};
      await Promise.all((promptList.prompts || []).map(async (name: string) => {
        const r = await fetch(`${API_BASE}/api/config/pipelines/${pipelineId}/prompts/system/${name}`);
        if (r.ok) {
          const normalizedKey = normalizePromptKey(name);
          system[normalizedKey] = (await r.json()).content;
        }
      }));

      const fragments: Record<string, string> = {};
      const fragmentMeta: Record<string, FragmentMeta> = {};
      try {
        const fragRes = await fetch(`${API_BASE}/api/config/fragments/registry`);
        if (fragRes.ok) {
          const fragData = await fragRes.json();
          for (const [id, entry] of Object.entries(fragData.entries as Record<string, { meta: FragmentMeta; content: string }>)) {
            fragments[id] = entry.content;
            fragmentMeta[id] = entry.meta;
          }
        }
      } catch { /* ignore */ }

      const settingsData = settingsRes.ok ? await settingsRes.json() : { settings: {} };
      const sandboxData = sandboxRes.ok ? await sandboxRes.json() : { enabled: false };

      setWorkbenchConfig({
        pipelineName: pipelineId,
        pipeline: parseYAML(pipeData.raw),
        prompts: {
          system,
          fragments,
          fragmentMeta,
          globalConstraints: constraintsData.content || "",
          globalClaudeMd: cmdData.content || "",
          globalGeminiMd: gmdContent,
        },
        agent: settingsData.settings?.agent || {},
        mcps: [],
        skills: [],
        sandbox: sandboxData,
      });
      setActivePipelineId(pipelineId);
    } catch (err) { console.error("Pipeline load failed", err); }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    loadInfra().finally(() => setIsLoading(false));
  }, [loadInfra]);

  // Handle URL query params: ?pipeline=xxx switches to workbench with that pipeline
  useEffect(() => {
    if (isLoading) return;
    const pipelineParam = searchParams.get("pipeline");
    if (pipelineParam) {
      setActiveMainTab("workbench");
      loadPipelineConfig(pipelineParam);
    }
  }, [isLoading, searchParams, loadPipelineConfig]);

  const handleGlobalUpdate = async (newConfig: any) => {
    const pipelineId = newConfig.pipelineName || activePipelineId || "pipeline-generator";
    const put = (url: string, body: unknown) =>
      fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const parallelOps: Array<{ label: string; promise: Promise<Response> }> = [
      { label: "Pipeline YAML", promise: put(`${API_BASE}/api/config/pipelines/${pipelineId}`, { content: stringifyYAML(newConfig.pipeline) }) },
      { label: "Constraints", promise: put(`${API_BASE}/api/config/pipelines/${pipelineId}/prompts/constraints`, { content: newConfig.prompts.globalConstraints }) },
      { label: "CLAUDE.md", promise: put(`${API_BASE}/api/config/claude-md/global/global.md`, { content: newConfig.prompts.globalClaudeMd }) },
      { label: "GEMINI.md", promise: put(`${API_BASE}/api/config/gemini-md/global/global.md`, { content: newConfig.prompts.globalGeminiMd }) },
    ];

    if (newConfig.sandbox && "enabled" in newConfig.sandbox) {
      parallelOps.push({ label: "Sandbox", promise: put(`${API_BASE}/api/config/sandbox`, newConfig.sandbox) });
    }

    for (const [key, content] of Object.entries(newConfig.prompts.system)) {
      const fileName = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      parallelOps.push({
        label: `Prompt: ${fileName}`,
        promise: put(`${API_BASE}/api/config/pipelines/${pipelineId}/prompts/system/${fileName}`, { content }),
      });
    }

    // F1: Save fragments
    if (newConfig.prompts.fragments) {
      const meta: Record<string, FragmentMeta> = newConfig.prompts.fragmentMeta || {};
      for (const [id, content] of Object.entries(newConfig.prompts.fragments as Record<string, string>)) {
        const fragMeta = meta[id] || { id, keywords: [], stages: "*", always: false };
        const fileContent = rebuildFragmentFile(content, fragMeta);
        parallelOps.push({
          label: `Fragment: ${id}`,
          promise: put(`${API_BASE}/api/config/prompts/fragments/${id}`, { content: fileContent }),
        });
      }
    }

    // Delete removed fragments
    if (newConfig._deletedFragments?.length) {
      for (const id of newConfig._deletedFragments as string[]) {
        parallelOps.push({
          label: `Delete Fragment: ${id}`,
          promise: fetch(`${API_BASE}/api/config/prompts/fragments/${id}`, { method: "DELETE" }),
        });
      }
    }

    // Delete removed/renamed system prompts
    if (newConfig._deletedPrompts?.length) {
      for (const key of newConfig._deletedPrompts as string[]) {
        const fileName = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        parallelOps.push({
          label: `Delete Prompt: ${fileName}`,
          promise: fetch(`${API_BASE}/api/config/pipelines/${pipelineId}/prompts/system/${fileName}`, { method: "DELETE" }),
        });
      }
    }

    const results = await Promise.allSettled(parallelOps.map((op) => op.promise));
    const failures: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        failures.push(parallelOps[i].label);
      } else if (!r.value.ok) {
        failures.push(parallelOps[i].label);
      }
    });

    // Settings requires serial: GET then PUT
    if (newConfig.agent) {
      try {
        const settingsRes = await fetch(`${API_BASE}/api/config/settings`);
        if (settingsRes.ok) {
          const { settings } = await settingsRes.json();
          settings.agent = { ...(settings.agent ?? {}), ...newConfig.agent };
          const putRes = await put(`${API_BASE}/api/config/settings`, { content: stringifyYAML(settings) });
          if (!putRes.ok) failures.push("Settings");
        }
      } catch { failures.push("Settings"); }
    }

    if (failures.length > 0) {
      toast.error(t("failedSave", { items: failures.join(", ") }));
      throw new Error("Partial save failure");
    }
  };

  const handleSandboxSave = async (newConfig: SandboxConfig) => {
    setSandboxSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/config/sandbox`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      if (res.ok) {
        setSandboxConfig(newConfig);
        loadInfra();
      }
    } catch { /* ignore */ }
    finally { setSandboxSaving(false); }
  };

  const handleInfraSave = async (type: "settings" | "mcps", content: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/config/${type}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      if (res.ok) {
        loadInfra();
      }
    } catch { toast.error(t("saveFailed")); }
  };

  // F2: Create pipeline
  const handleCreatePipeline = async () => {
    if (!newPipelineId) return;
    try {
      const body: Record<string, string> = { id: newPipelineId };
      if (newPipelineCopyFrom) body.copyFrom = newPipelineCopyFrom;
      const res = await fetch(`${API_BASE}/api/config/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("pipelineCreated", { id: newPipelineId }));
        setShowNewPipelineModal(false);
        setNewPipelineId("");
        setNewPipelineCopyFrom("");
        await loadInfra();
      } else {
        const data = await res.json();
        toast.error(data.error || t("failedCreate"));
      }
    } catch { toast.error(t("failedCreate")); }
  };

  // F2: Delete pipeline
  const handleDeletePipeline = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/config/pipelines/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(t("pipelineDeleted", { id }));
        setDeletingPipeline(null);
        await loadInfra();
      } else {
        const data = await res.json();
        toast.error(data.error || t("failedDelete"));
      }
    } catch { toast.error(t("failedDelete")); }
  };

  // AI Generate pipeline
  const handleAiGenerate = async () => {
    if (!aiDescription || aiDescription.length < 10) return;
    setAiPhase("generating");
    setAiResult(null);
    try {
      const body: Record<string, string> = { description: aiDescription };
      if (aiEngine !== "auto") body.engine = aiEngine;

      const genRes = await fetch(`${API_BASE}/api/config/pipelines/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!genRes.ok) {
        const data = await genRes.json();
        toast.error(data.error || t("aiGenerateFailed"));
        return;
      }

      const result = await genRes.json();
      setAiPhase("saving");

      const pipelineId = (result.parsed.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 36) || "ai-generated") + "-" + Date.now().toString(36).slice(-4);

      const createRes = await fetch(`${API_BASE}/api/config/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pipelineId, content: result.yaml }),
      });

      if (!createRes.ok) {
        const data = await createRes.json();
        toast.error(data.error || t("failedCreate"));
        return;
      }

      const cleanupPipeline = () =>
        fetch(`${API_BASE}/api/config/pipelines/${pipelineId}`, { method: "DELETE" }).catch(() => {});

      const scriptFiles: string[] = [];
      const writtenScriptFiles: { scriptId: string; filename: string }[] = [];

      // Write custom scripts if any
      if (result.scripts?.length > 0) {
        for (const script of result.scripts) {
          const manifestRes = await fetch(`${API_BASE}/api/config/scripts/${script.scriptId}/manifest.yaml`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `name: "${script.manifest.name}"\nversion: "${script.manifest.version}"\ntype: script\nscript_id: ${script.manifest.script_id}\nentry: index.ts\n` }),
          });
          if (!manifestRes.ok) {
            const data = await manifestRes.json().catch(() => ({}));
            toast.error(`Failed to save script manifest for "${script.scriptId}": ${(data as any).error ?? manifestRes.status}`);
            await Promise.all(writtenScriptFiles.map(f =>
              fetch(`${API_BASE}/api/config/scripts/${f.scriptId}/${f.filename}`, { method: "DELETE" }).catch(() => {})
            ));
            await cleanupPipeline();
            return;
          }
          writtenScriptFiles.push({ scriptId: script.scriptId, filename: "manifest.yaml" });

          const codeRes = await fetch(`${API_BASE}/api/config/scripts/${script.scriptId}/index.ts`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: script.code }),
          });
          if (!codeRes.ok) {
            const data = await codeRes.json().catch(() => ({}));
            toast.error(`Failed to save script code for "${script.scriptId}": ${(data as any).error ?? codeRes.status}`);
            await Promise.all(writtenScriptFiles.map(f =>
              fetch(`${API_BASE}/api/config/scripts/${f.scriptId}/${f.filename}`, { method: "DELETE" }).catch(() => {})
            ));
            await cleanupPipeline();
            return;
          }
          writtenScriptFiles.push({ scriptId: script.scriptId, filename: "index.ts" });
          scriptFiles.push(`config/scripts/${script.scriptId}/manifest.yaml`);
          scriptFiles.push(`config/scripts/${script.scriptId}/index.ts`);
        }
      }

      const savedPromptFiles: string[] = [];

      // Create prompt files for agent stages
      if (result.promptFiles?.length > 0) {
        for (const promptFile of result.promptFiles) {
          const fileName = promptFile.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
          const res = await fetch(`${API_BASE}/api/config/pipelines/${pipelineId}/prompts/system/${fileName}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: promptFile.content }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast.error(`Failed to save prompt "${fileName}": ${(data as any).error ?? res.status}`);
            await cleanupPipeline();
            return;
          }
          savedPromptFiles.push(`config/pipelines/${pipelineId}/prompts/system/${fileName}.md`);
        }
      }

      await loadInfra();
      loadPipelineConfig(pipelineId);
      setActiveMainTab("workbench");

      const disc = result.capabilityDiscovery;
      setAiResult({
        pipelineId,
        pipelineFile: `config/pipelines/${pipelineId}/pipeline.yaml`,
        promptFiles: savedPromptFiles,
        scriptFiles,
        warnings: result.warnings ?? [],
        capabilityDiscovery: disc && (disc.autoInstalledMcps.length > 0 || disc.autoInstalledSkills.length > 0 || disc.mcpsNeedingKeys.length > 0)
          ? { autoInstalledMcps: disc.autoInstalledMcps, autoInstalledSkills: disc.autoInstalledSkills, mcpsNeedingKeys: disc.mcpsNeedingKeys }
          : undefined,
      });
    } catch (err) {
      toast.error(t("aiGenerateFailed"));
    } finally {
      setAiPhase("idle");
    }
  };

  const handleAiGenerateClose = () => {
    setShowAiGenerateModal(false);
    setAiDescription("");
    setAiEngine("auto");
    setAiResult(null);
    setAiPhase("idle");
  };

  if (isLoading) {
    return <div className="flex h-96 items-center justify-center text-zinc-500 animate-pulse">{t("loadingConfig")}</div>;
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-4 border-b border-zinc-800 pb-1">
        <button
          onClick={() => setActiveMainTab("infrastructure")}
          className={`px-4 py-2 text-sm font-bold transition-all border-b-2 ${activeMainTab === "infrastructure" ? "text-blue-400 border-blue-500" : "text-zinc-500 border-transparent hover:text-zinc-300"}`}
        >
          {t("infraHealth")}
        </button>
        <button
          onClick={() => setActiveMainTab("workbench")}
          className={`px-4 py-2 text-sm font-bold transition-all border-b-2 ${activeMainTab === "workbench" ? "text-purple-400 border-purple-500" : "text-zinc-500 border-transparent hover:text-zinc-300"}`}
        >
          {t("blueprintIntel")}
        </button>
      </div>

      {activeMainTab === "infrastructure" ? (
        <div className="flex gap-10">
          <aside className="w-48 shrink-0 space-y-4">
            <button onClick={() => setInfraSubTab("health")} className={`block w-full text-left px-3 py-2 rounded text-xs transition-all ${infraSubTab === "health" ? "bg-zinc-800 text-blue-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}>{t("systemHealth")}</button>
            <button onClick={() => setInfraSubTab("settings")} className={`block w-full text-left px-3 py-2 rounded text-xs transition-all ${infraSubTab === "settings" ? "bg-zinc-800 text-blue-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}>{t("systemSettings")}</button>
            <button onClick={() => setInfraSubTab("mcps")} className={`block w-full text-left px-3 py-2 rounded text-xs transition-all ${infraSubTab === "mcps" ? "bg-zinc-800 text-blue-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}>{t("mcpRegistry")}</button>
            <button onClick={() => setInfraSubTab("sandbox")} className={`block w-full text-left px-3 py-2 rounded text-xs transition-all ${infraSubTab === "sandbox" ? "bg-zinc-800 text-blue-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}>{t("sandbox")}</button>
          </aside>

          <main className="flex-1 min-w-0">
            {infraSubTab === "health" && systemView && (
              <div className="space-y-8 animate-in fade-in">
                <div className="grid grid-cols-3 gap-4">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                    <h3 className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-4">{t("hostEnv")}</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex justify-between"><span className="text-zinc-500">{t("os")}</span><span className="text-zinc-300 font-mono text-xs">{systemView.environment.os}</span></div>
                      <div className="flex justify-between"><span className="text-zinc-500">{t("nodeRuntime")}</span><span className="text-zinc-300 font-mono text-xs">{systemView.environment.nodeVersion}</span></div>
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                    <h3 className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-4">{t("availability")}</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex justify-between"><span className="text-zinc-500">{t("mcpServers")}</span><span className="text-purple-400 font-bold">{systemView.capabilities.mcps.filter(m => m.available).length}/{systemView.capabilities.mcps.length} {t("ready")}</span></div>
                      <div className="flex justify-between"><span className="text-zinc-500">{t("sharedSkills")}</span><span className="text-blue-400 font-bold">{systemView.capabilities.skills.length} {t("loaded")}</span></div>
                    </div>
                    {systemView.capabilities.mcps.length > 0 && (
                      <div className="mt-4 space-y-2">
                        {systemView.capabilities.mcps.map((mcp) => (
                          <div key={mcp.name} className="flex items-center gap-2 text-xs">
                            <div className={`h-1.5 w-1.5 rounded-full ${mcp.available ? "bg-emerald-500" : "bg-zinc-600"}`} />
                            <span className="text-zinc-300 font-mono">{mcp.name}</span>
                            {mcp.description && <span className="text-zinc-600 truncate">{mcp.description}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                    <h3 className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest mb-4">{t("slackNotifications")}</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-zinc-500">{t("slackBot")}</span>
                        <span className={systemView.notifications.slackConfigured ? "text-emerald-400 font-bold" : "text-zinc-600"}>
                          {systemView.notifications.slackConfigured ? t("ready") : t("slackNotConfigured")}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">{t("slackSocketMode")}</span>
                        <span className={systemView.notifications.slackSocketMode ? "text-emerald-400 font-bold" : "text-zinc-600"}>
                          {systemView.notifications.slackSocketMode ? t("ready") : t("off")}
                        </span>
                      </div>
                      {systemView.notifications.channelId && (
                        <div className="flex justify-between">
                          <span className="text-zinc-500">{t("slackChannel")}</span>
                          <span className="text-zinc-300 font-mono text-xs">{systemView.notifications.channelId}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest">{t("preflightDiagnostics")}</h3>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 overflow-hidden">
                    {systemView.environment.preflight.map((check, i) => (
                      <div key={i} className={`flex items-center gap-4 px-5 py-3 text-xs ${i !== 0 ? "border-t border-zinc-800/50" : ""}`}>
                        <div className={`h-2 w-2 rounded-full ${check.ok ? "bg-emerald-500 shadow-[0_0_8px_#10b981]" : "bg-red-500 shadow-[0_0_8px_#ef4444]"}`} />
                        <span className="w-40 font-bold text-zinc-200">{check.name}</span>
                        <span className="flex-1 text-zinc-500 italic truncate">{check.detail}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {infraSubTab === "sandbox" && (
              <div className="animate-in fade-in">
                <SandboxPanel
                  value={sandboxConfig}
                  onChange={handleSandboxSave}
                  readOnly={sandboxSaving}
                />
              </div>
            )}

            {(infraSubTab === "settings" || infraSubTab === "mcps") && (
              <div className="flex flex-col gap-4 h-[600px] animate-in fade-in">
                <div className="bg-blue-900/10 border border-blue-800/30 rounded-lg p-3 shrink-0">
                  <p className="text-[11px] text-blue-300 italic">{t("editRawConfig")}</p>
                </div>
                <div className="flex-1 min-h-0">
                  <RawYamlEditor
                    value={infraSubTab === "settings" ? settingsRaw : mcpRaw}
                    onChange={infraSubTab === "settings" ? setSettingsRaw : setMcpRaw}
                  />
                </div>
                <button
                  onClick={() => handleInfraSave(infraSubTab as any, infraSubTab === "settings" ? settingsRaw : mcpRaw)}
                  className="self-end rounded bg-blue-600 px-8 py-2 text-sm font-bold text-white hover:bg-blue-500 shadow-lg shadow-blue-900/20 active:scale-95 transition-all"
                >
                  {t("saveChanges")}
                </button>
              </div>
            )}

          </main>
        </div>
      ) : (
        <div className="animate-in fade-in duration-500">
          {workbenchConfig ? (
            <div className="space-y-4">
              <button
                onClick={() => { setWorkbenchConfig(null); setActivePipelineId(null); }}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                &larr; {t("backToPipelineList")}
              </button>
              <ConfigWorkbench
                mode="global"
                config={workbenchConfig}
                onUpdateConfig={handleGlobalUpdate}
                availableMcps={systemView?.capabilities.mcps}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6 py-16">
              <div className="flex items-center gap-4">
                <h3 className="text-sm font-bold text-zinc-300">{t("selectPipeline")}</h3>
                <button
                  onClick={() => setShowNewPipelineModal(true)}
                  className="rounded bg-purple-600 px-3 py-1 text-xs font-bold text-white hover:bg-purple-500 transition-all active:scale-95"
                >
                  {t("newPipeline")}
                </button>
                <button
                  onClick={() => setShowAiGenerateModal(true)}
                  className="rounded bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-500 transition-all active:scale-95"
                >
                  {t("aiGenerate")}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 w-full max-w-2xl">
                {availablePipelines.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-start gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-all hover:border-zinc-600 hover:bg-zinc-800/50"
                  >
                    <button
                      onClick={() => loadPipelineConfig(p.id)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-bold text-zinc-100">{p.name}</span>
                        <span className={`text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                          p.engine === "claude" ? "text-blue-400 bg-blue-900/20 border-blue-800/50" :
                          p.engine === "gemini" ? "text-purple-400 bg-purple-900/20 border-purple-800/50" :
                          "text-zinc-400 bg-zinc-800 border-zinc-700"
                        }`}>{p.engine}</span>
                        {p.stageCount != null && (
                          <span className="text-[11px] text-zinc-600">{t("stages", { count: p.stageCount })}</span>
                        )}
                        {p.totalBudget != null && (
                          <span className="text-[11px] text-zinc-600">{t("budget", { amount: p.totalBudget })}</span>
                        )}
                      </div>
                      {p.description && <p className="text-xs text-zinc-500 line-clamp-1 mb-1">{p.description}</p>}
                      {p.stageSummary && (
                        <p className="text-[11px] text-zinc-600 font-mono truncate">{p.stageSummary}</p>
                      )}
                      {p.mcps && p.mcps.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {p.mcps.map((m) => (
                            <span key={m} className="text-[10px] text-zinc-600 bg-zinc-800/50 px-1.5 py-0.5 rounded">{m}</span>
                          ))}
                        </div>
                      )}
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeletingPipeline(p.id); }}
                        className="text-zinc-600 hover:text-red-400 text-xs transition-colors px-1"
                        title={t("deletePipeline")}
                      >
                        &times;
                      </button>
                      <span className="text-zinc-600 text-lg">&rarr;</span>
                    </div>
                  </div>
                ))}
                {availablePipelines.length === 0 && (
                  <p className="text-xs text-zinc-600 italic py-8 text-center">{t("noPipelines")}</p>
                )}
              </div>
            </div>
          )}

          {/* New Pipeline Modal */}
          {showNewPipelineModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
              <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
                <h4 className="text-sm font-bold text-zinc-200 mb-4">{t("createNewPipeline")}</h4>
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">{t("pipelineId")}</label>
                    <input
                      type="text"
                      value={newPipelineId}
                      onChange={(e) => setNewPipelineId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                      placeholder="my-pipeline"
                      className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-purple-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">{t("copyFrom")}</label>
                    <select
                      value={newPipelineCopyFrom}
                      onChange={(e) => setNewPipelineCopyFrom(e.target.value)}
                      className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-purple-500 focus:outline-none"
                    >
                      <option value="">{t("emptyPipeline")}</option>
                      {availablePipelines.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-6">
                  <button
                    onClick={() => { setShowNewPipelineModal(false); setNewPipelineId(""); setNewPipelineCopyFrom(""); }}
                    className="rounded px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    {tc("cancel")}
                  </button>
                  <button
                    onClick={handleCreatePipeline}
                    disabled={!newPipelineId}
                    className="rounded bg-purple-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {tc("create")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Delete Confirmation */}
          {deletingPipeline && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
              <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
                <h4 className="text-sm font-bold text-zinc-200 mb-2">{t("deletePipeline")}</h4>
                <p className="text-xs text-zinc-400 mb-4">
                  {t("deleteConfirm", { name: deletingPipeline })}
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setDeletingPipeline(null)}
                    className="rounded px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    {tc("cancel")}
                  </button>
                  <button
                    onClick={() => handleDeletePipeline(deletingPipeline)}
                    className="rounded bg-red-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-red-500 transition-all"
                  >
                    {tc("delete")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AI Generate Modal */}
          {showAiGenerateModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
              <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-lg shadow-2xl">
                {aiResult ? (
                  // Result view
                  <>
                    <h4 className="text-sm font-bold text-zinc-200 mb-1">{t("aiGenerateDoneTitle")}</h4>
                    <p className="text-xs text-zinc-500 mb-4">{t("aiGenerateDoneDesc", { id: aiResult.pipelineId })}</p>

                    <div className="space-y-3 text-xs">
                      <div>
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">{t("aiGenerateNewFiles")}</p>
                        <div className="bg-zinc-800 rounded p-3 space-y-1 font-mono">
                          <p className="text-emerald-400">{aiResult.pipelineFile}</p>
                          {aiResult.promptFiles.map(f => (
                            <p key={f} className="text-yellow-400">{f}</p>
                          ))}
                          {aiResult.scriptFiles.filter(f => f.endsWith("index.ts")).map(f => (
                            <p key={f} className="text-blue-400">{f}</p>
                          ))}
                        </div>
                      </div>

                      {(aiResult.promptFiles.length > 0 || aiResult.scriptFiles.length > 0) && (
                        <div className="space-y-1.5">
                          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{t("aiGenerateNextSteps")}</p>
                          {aiResult.promptFiles.length > 0 && (
                            <p className="text-yellow-300">
                              {t("aiGenerateStepPrompts")}
                            </p>
                          )}
                          {aiResult.scriptFiles.some(f => f.endsWith("index.ts")) && (
                            <p className="text-blue-300">
                              {t("aiGenerateStepScripts")}
                            </p>
                          )}
                        </div>
                      )}

                      {aiResult.capabilityDiscovery && (
                        <div>
                          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">{t("aiDiscoveryTitle")}</p>
                          <div className="bg-zinc-800 rounded p-3 space-y-2 text-xs">
                            {aiResult.capabilityDiscovery.autoInstalledMcps.length > 0 && (
                              <div>
                                <span className="text-zinc-500">{t("aiDiscoveryInstalledMcps")}:</span>{" "}
                                <span className="text-emerald-400 font-mono">{aiResult.capabilityDiscovery.autoInstalledMcps.join(", ")}</span>
                              </div>
                            )}
                            {aiResult.capabilityDiscovery.autoInstalledSkills.length > 0 && (
                              <div>
                                <span className="text-zinc-500">{t("aiDiscoveryInstalledSkills")}:</span>{" "}
                                <span className="text-emerald-400 font-mono">{aiResult.capabilityDiscovery.autoInstalledSkills.join(", ")}</span>
                              </div>
                            )}
                            {aiResult.capabilityDiscovery.mcpsNeedingKeys.map((m) => (
                              <div key={m.name} className="text-amber-400">
                                <span className="font-mono">{m.name}</span>
                                <span className="text-zinc-500 ml-1">— {t("aiDiscoveryEnvVars", { vars: m.envVars.join(", ") })}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {aiResult.warnings.length > 0 && (
                        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded p-2.5 text-yellow-300 space-y-1">
                          {aiResult.warnings.map((w, i) => <p key={i}>{w}</p>)}
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end mt-6">
                      <button
                        onClick={handleAiGenerateClose}
                        className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 transition-all"
                      >
                        {tc("ok")}
                      </button>
                    </div>
                  </>
                ) : (
                  // Input view
                  <>
                    <h4 className="text-sm font-bold text-zinc-200 mb-4">{t("aiGenerateTitle")}</h4>
                    <p className="text-xs text-zinc-500 mb-4">{t("aiGenerateDesc")}</p>
                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">{t("description")}</label>
                        <textarea
                          value={aiDescription}
                          onChange={(e) => setAiDescription(e.target.value)}
                          placeholder={t("aiGeneratePlaceholder")}
                          rows={4}
                          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none resize-none"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">{t("engine")}</label>
                        <select
                          value={aiEngine}
                          onChange={(e) => setAiEngine(e.target.value as "auto" | "claude" | "gemini")}
                          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
                        >
                          <option value="auto">Auto</option>
                          <option value="claude">Claude</option>
                          <option value="gemini">Gemini</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-6">
                      <button
                        onClick={handleAiGenerateClose}
                        className="rounded px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                        disabled={aiPhase !== "idle"}
                      >
                        {tc("cancel")}
                      </button>
                      <button
                        onClick={handleAiGenerate}
                        disabled={aiDescription.length < 10 || aiPhase !== "idle"}
                        className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                      >
                        {aiPhase === "generating" ? t("aiGeneratingLLM") : aiPhase === "saving" ? t("aiGeneratingSaving") : t("aiGenerateBtn")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ConfigPage;
