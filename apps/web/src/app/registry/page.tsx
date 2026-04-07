"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface PackageSummary {
  name: string;
  version: string;
  type: string;
  description: string;
  author: string;
  tags: string[];
  engine_compat?: string;
}

interface PackageManifest extends PackageSummary {
  license?: string;
  dependencies?: {
    skills?: string[];
    fragments?: string[];
    hooks?: string[];
    scripts?: string[];
  };
  files: string[];
}

interface InstalledEntry {
  version: string;
  type: string;
  author: string;
  installed_at: string;
  files: string[];
}

interface OutdatedEntry {
  name: string;
  installed: string;
  latest: string;
  type: string;
}

const TYPE_COLORS: Record<string, string> = {
  pipeline: "bg-blue-600/20 text-blue-400 border-blue-600/30",
  skill: "bg-purple-600/20 text-purple-400 border-purple-600/30",
  hook: "bg-amber-600/20 text-amber-400 border-amber-600/30",
  fragment: "bg-emerald-600/20 text-emerald-400 border-emerald-600/30",
  mcp: "bg-indigo-600/20 text-indigo-400 border-indigo-600/30",
  script: "bg-cyan-600/20 text-cyan-400 border-cyan-600/30",
};

const FILTER_TYPES = ["all", "pipeline", "skill", "hook", "fragment", "mcp", "script"] as const;

const RegistryPage = () => {
  const t = useTranslations("Registry");

  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [installed, setInstalled] = useState<Record<string, InstalledEntry>>({});
  const [outdated, setOutdated] = useState<OutdatedEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [expandedPkg, setExpandedPkg] = useState<string | null>(null);
  const [expandedManifest, setExpandedManifest] = useState<PackageManifest | null>(null);
  const [operating, setOperating] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [localPackages, setLocalPackages] = useState<{ name: string; type: string }[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [publishing, setPublishing] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [indexRes, installedRes, outdatedRes, localRes] = await Promise.all([
        fetch(`${API_BASE}/api/registry/index`),
        fetch(`${API_BASE}/api/registry/installed`),
        fetch(`${API_BASE}/api/registry/outdated`),
        fetch(`${API_BASE}/api/registry/local`),
      ]);
      if (indexRes.ok) {
        const data = await indexRes.json();
        setPackages(data.packages ?? []);
      }
      if (installedRes.ok) {
        const data = await installedRes.json();
        setInstalled(data.packages ?? {});
      }
      if (outdatedRes.ok) {
        const data = await outdatedRes.json();
        setOutdated(data.packages ?? []);
      }
      if (localRes.ok) {
        const data = await localRes.json();
        setLocalPackages(data.packages ?? []);
      }
    } catch {
      // silently fail on initial load
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const showToast = (message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleInstall = async (name: string) => {
    setOperating((prev) => new Set(prev).add(name));
    try {
      const res = await fetch(`${API_BASE}/api/registry/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packages: [name] }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Install failed");
      }
      const data = await res.json();
      const requestedSkipped = data.skipped?.find(
        (s: { name: string; reason: string }) => s.name === name,
      );
      if (requestedSkipped) {
        throw new Error(requestedSkipped.reason);
      }
      const mcpSetup = data.mcpSetupNeeded as Array<{ name: string; envVars: string[] }> | undefined;
      if (mcpSetup?.length) {
        const envList = mcpSetup.map((m: { name: string; envVars: string[] }) => `${m.name}: ${m.envVars.join(", ")}`).join("; ");
        showToast(t("installSuccess", { count: data.installed.length }) + ` — ${t("mcpEnvNeeded")}: ${envList}`, "success");
      } else {
        showToast(t("installSuccess", { count: data.installed.length }), "success");
      }
      await fetchData();
    } catch (err) {
      showToast(t("error", { message: (err as Error).message }), "error");
    } finally {
      setOperating((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const handleUninstall = async (name: string) => {
    setOperating((prev) => new Set(prev).add(name));
    try {
      const res = await fetch(`${API_BASE}/api/registry/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packages: [name] }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Uninstall failed");
      }
      const data = await res.json();
      showToast(t("uninstallSuccess", { count: data.removed.length }), "success");
      await fetchData();
    } catch (err) {
      showToast(t("error", { message: (err as Error).message }), "error");
    } finally {
      setOperating((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const handleUpdate = async (name: string) => {
    setOperating((prev) => new Set(prev).add(name));
    try {
      const res = await fetch(`${API_BASE}/api/registry/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Update failed");
      }
      const data = await res.json();
      showToast(t("updateSuccess", { count: data.updated.length }), "success");
      await fetchData();
    } catch (err) {
      showToast(t("error", { message: (err as Error).message }), "error");
    } finally {
      setOperating((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const handleBootstrap = async () => {
    setBootstrapping(true);
    try {
      const res = await fetch(`${API_BASE}/api/registry/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Bootstrap failed");
      }
      const data = await res.json();
      showToast(t("bootstrapSuccess", { count: data.installed.length }), "success");
      await fetchData();
    } catch (err) {
      showToast(t("error", { message: (err as Error).message }), "error");
    } finally {
      setBootstrapping(false);
    }
  };

  const handlePublish = async (name: string, type: string) => {
    setPublishing(name);
    try {
      const res = await fetch(`${API_BASE}/api/registry/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Publish failed");
      }
      showToast(t("publishSuccess", { name }), "success");
      await fetchData();
    } catch (err) {
      showToast(t("error", { message: (err as Error).message }), "error");
    } finally {
      setPublishing(null);
    }
  };

  const handleExpand = async (name: string) => {
    if (expandedPkg === name) {
      setExpandedPkg(null);
      setExpandedManifest(null);
      return;
    }
    setExpandedPkg(name);
    try {
      const res = await fetch(`${API_BASE}/api/registry/packages/${name}`);
      if (res.ok) {
        setExpandedManifest(await res.json());
      }
    } catch {
      // ignore
    }
  };

  // Merge registry packages + local-only packages into a single list
  const localSet = new Set(localPackages.map((lp) => lp.name));
  const allPackages: (PackageSummary & { isLocalOnly?: boolean })[] = [
    ...packages.map((p) => ({ ...p, isLocalOnly: false as const })),
    ...localPackages
      .filter((lp) => !packages.some((p) => p.name === lp.name))
      .map((lp) => ({
        name: lp.name,
        version: "local",
        type: lp.type,
        description: t("localDescription"),
        author: "local",
        tags: [],
        isLocalOnly: true as const,
      })),
  ];

  // Filter packages
  const filtered = allPackages.filter((p) => {
    if (typeFilter !== "all" && p.type !== typeFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const outdatedMap = new Map(outdated.map((o) => [o.name, o]));
  const installedCount = Object.keys(installed).length;
  const outdatedCount = outdated.length;
  const localOnlyCount = localPackages.filter((lp) => !packages.some((p) => p.name === lp.name)).length;
  const filterLabels: Record<string, string> = {
    all: t("filterAll"),
    pipeline: t("filterPipeline"),
    skill: t("filterSkill"),
    hook: t("filterHook"),
    fragment: t("filterFragment"),
    mcp: t("filterMcp"),
    script: t("filterScript"),
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg ${
            toast.type === "success"
              ? "bg-emerald-600/90 text-white"
              : "bg-red-600/90 text-white"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="max-w-6xl mx-auto mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-100">{t("title")}</h1>
            <p className="text-sm text-zinc-500 mt-1">{t("subtitle")}</p>
          </div>
          <button
            onClick={handleBootstrap}
            disabled={bootstrapping}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-600/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bootstrapping ? t("bootstrapping") : t("bootstrapAll")}
          </button>
        </div>

        {/* Stats */}
        <div className="flex gap-4 mt-4 text-sm">
          <span className="text-zinc-400">
            {t("available")}: <span className="text-zinc-200 font-medium">{packages.length}</span>
          </span>
          <span className="text-zinc-400">
            {t("installed")}: <span className="text-zinc-200 font-medium">{installedCount}</span>
          </span>
          {localOnlyCount > 0 && (
            <span className="text-orange-400">
              {t("local")}: <span className="font-medium">{localOnlyCount}</span>
            </span>
          )}
          {outdatedCount > 0 && (
            <span className="text-amber-400">
              {t("outdated")}: <span className="font-medium">{outdatedCount}</span>
            </span>
          )}
        </div>
      </div>

      {/* Search + Filter */}
      <div className="max-w-6xl mx-auto mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
            {FILTER_TYPES.map((ft) => (
              <button
                key={ft}
                onClick={() => setTypeFilter(ft)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  typeFilter === ft
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {filterLabels[ft]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Package List */}
      <div className="max-w-6xl mx-auto">
        {filtered.length === 0 ? (
          <p className="text-zinc-500 text-center py-12">{t("noPackages")}</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((pkg) => {
              const isLocalOnly = "isLocalOnly" in pkg && pkg.isLocalOnly;
              const isInstalled = !!installed[pkg.name];
              const isOutdated = outdatedMap.has(pkg.name);
              const isOperating = operating.has(pkg.name);
              const isExpanded = expandedPkg === pkg.name;

              return (
                <div key={pkg.name} className="border border-zinc-800 rounded-lg overflow-hidden">
                  {/* Card header */}
                  <div
                    className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-zinc-900/50 transition-colors"
                    onClick={() => handleExpand(pkg.name)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {pkg.type === "pipeline" ? (
                          <a
                            href={`/config?pipeline=${encodeURIComponent(pkg.name)}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-blue-400 hover:text-blue-300 hover:underline"
                          >
                            {pkg.name}
                          </a>
                        ) : (
                          <span className="font-medium text-zinc-100">{pkg.name}</span>
                        )}
                        <span className="text-xs text-zinc-500">{pkg.version}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            TYPE_COLORS[pkg.type] || "bg-zinc-700/20 text-zinc-400 border-zinc-600/30"
                          }`}
                        >
                          {pkg.type}
                        </span>
                        {pkg.engine_compat && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">
                            {pkg.engine_compat}
                          </span>
                        )}
                        {isLocalOnly && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-600/20 text-orange-400 border border-orange-600/30">
                            {t("local")}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5 truncate">{pkg.description}</p>
                    </div>

                    {/* Tags */}
                    <div className="hidden md:flex gap-1 flex-shrink-0">
                      {pkg.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/50 text-zinc-600">
                          {tag}
                        </span>
                      ))}
                    </div>

                    {/* Action button */}
                    <div className="flex-shrink-0 flex gap-2" onClick={(e) => e.stopPropagation()}>
                      {isOperating ? (
                        <span className="text-xs text-zinc-500 px-3 py-1.5">{t("installing")}</span>
                      ) : isLocalOnly ? (
                        <button
                          onClick={() => handlePublish(pkg.name, pkg.type)}
                          disabled={publishing === pkg.name}
                          className="text-xs px-3 py-1.5 rounded-md bg-violet-600/20 text-violet-400 hover:bg-violet-600/30 border border-violet-600/30 transition-colors disabled:opacity-50"
                        >
                          {publishing === pkg.name ? t("publishing") : t("publish")}
                        </button>
                      ) : isOutdated ? (
                        <button
                          onClick={() => handleUpdate(pkg.name)}
                          className="text-xs px-3 py-1.5 rounded-md bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 border border-amber-600/30 transition-colors"
                        >
                          {t("update")}
                        </button>
                      ) : isInstalled ? (
                        <>
                          <button
                            onClick={() => handlePublish(pkg.name, pkg.type)}
                            disabled={publishing === pkg.name}
                            className="text-xs px-3 py-1.5 rounded-md bg-violet-600/20 text-violet-400 hover:bg-violet-600/30 border border-violet-600/30 transition-colors disabled:opacity-50"
                          >
                            {publishing === pkg.name ? t("publishing") : t("publish")}
                          </button>
                          <button
                            onClick={() => handleUninstall(pkg.name)}
                            className="text-xs px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700 transition-colors"
                          >
                            {t("installed")}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleInstall(pkg.name)}
                          className="text-xs px-3 py-1.5 rounded-md bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-600/30 transition-colors"
                        >
                          {t("install")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded details */}
                  {isExpanded && expandedManifest && (
                    <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-900/30 text-xs space-y-3">
                      <div className="flex gap-8">
                        <div>
                          <span className="text-zinc-500">{t("by", { author: "" })}</span>
                          <span className="text-zinc-300">{expandedManifest.author}</span>
                        </div>
                        {expandedManifest.engine_compat && (
                          <div>
                            <span className="text-zinc-500">{t("engineCompat")}: </span>
                            <span className="text-zinc-300">{expandedManifest.engine_compat}</span>
                          </div>
                        )}
                        {expandedManifest.license && (
                          <div>
                            <span className="text-zinc-500">License: </span>
                            <span className="text-zinc-300">{expandedManifest.license}</span>
                          </div>
                        )}
                      </div>

                      {/* Dependencies */}
                      {expandedManifest.dependencies && Object.keys(expandedManifest.dependencies).length > 0 && (
                        <div>
                          <span className="text-zinc-500">{t("dependencies")}:</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {Object.entries(expandedManifest.dependencies).flatMap(([kind, deps]) =>
                              (deps ?? []).map((dep: string) => (
                                <span
                                  key={`${kind}-${dep}`}
                                  className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400"
                                >
                                  {dep}
                                  <span className="text-zinc-600 ml-1">({kind.replace(/s$/, "")})</span>
                                </span>
                              )),
                            )}
                          </div>
                        </div>
                      )}

                      {/* Files */}
                      <div>
                        <span className="text-zinc-500">{t("files")}:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {expandedManifest.files.map((f: string) => (
                            <span key={f} className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">
                              {f}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Publish hint */}
                      {(isInstalled || isLocalOnly) && (
                        <div className="pt-2 border-t border-zinc-800">
                          <span className="text-zinc-600 text-[10px]">{t("publishHint")}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default RegistryPage;
