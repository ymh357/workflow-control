"use client";

// /registry — package browser for the workflow-control-registry.
// Reads /api/registry/index (remote+local merge) and /api/registry/installed
// (lock file). Lets the user filter by type / search by name|description|tags
// and install / uninstall packages from the running server.
//
// Single-user local: same posture as the rest of the app — no auth, the
// install action mutates the current server's filesystem (config/ dir
// + .wfctl-registry.lock).

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "../../lib/api-client";
import { useToast } from "../../components/toast";
import { Button } from "../../components/ui/button";

type PackageType =
  | "pipeline"
  | "skill"
  | "fragment"
  | "hook"
  | "gate"
  | "script"
  | "mcp";

interface RegistryPackageSummary {
  name: string;
  version: string;
  type: PackageType;
  description: string;
  author: string;
  tags: string[];
  engine_compat?: string;
}

interface InstalledPackage {
  name: string;
  version: string;
  type: string;
  author: string;
  installedAt: string;
  files: string[];
}

interface OutdatedEntry {
  name: string;
  installed: string;
  latest: string;
  type: string;
}

const PACKAGE_TYPES: PackageType[] = [
  "pipeline",
  "skill",
  "fragment",
  "hook",
  "gate",
  "script",
  "mcp",
];

const TYPE_BADGE: Record<PackageType, string> = {
  pipeline: "bg-info-bg text-info-fg border-info-border",
  skill: "bg-success-bg text-success-fg border-success-border",
  fragment: "bg-elevated text-secondary border-default",
  hook: "bg-warning-bg text-warning-fg border-warning-border",
  gate: "bg-warning-bg text-warning-fg border-warning-border",
  script: "bg-elevated text-secondary border-default",
  mcp: "bg-info-bg text-info-fg border-info-border",
};

export default function RegistryPage() {
  const [index, setIndex] = useState<RegistryPackageSummary[] | null>(null);
  const [installed, setInstalled] = useState<Map<string, InstalledPackage>>(new Map());
  const [outdated, setOutdated] = useState<Map<string, OutdatedEntry>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<PackageType | "">("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const toast = useToast();

  const reload = useCallback(async () => {
    try {
      const [indexRes, installedRes, outdatedRes] = await Promise.all([
        fetch(`${API_BASE}/api/registry/index`),
        fetch(`${API_BASE}/api/registry/installed`),
        fetch(`${API_BASE}/api/registry/outdated`),
      ]);
      if (!indexRes.ok) {
        setError(`index HTTP ${indexRes.status}`);
        setIndex([]);
        return;
      }
      const indexBody = (await indexRes.json()) as
        | { ok: true; index: { packages: RegistryPackageSummary[] } }
        | { ok: false; diagnostics: Array<{ code: string; message: string }> };
      if (!indexBody.ok) {
        setError(indexBody.diagnostics[0]?.message ?? "index fetch failed");
        setIndex([]);
        return;
      }
      setIndex(indexBody.index.packages);
      setError(null);

      if (installedRes.ok) {
        const installedBody = (await installedRes.json()) as { ok: boolean; packages: InstalledPackage[] };
        if (installedBody.ok) {
          setInstalled(new Map(installedBody.packages.map((p) => [p.name, p])));
        }
      }
      if (outdatedRes.ok) {
        const outdatedBody = (await outdatedRes.json()) as { ok: boolean; outdated: OutdatedEntry[] };
        if (outdatedBody.ok) {
          setOutdated(new Map(outdatedBody.outdated.map((o) => [o.name, o])));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIndex([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setBusyFor = useCallback((name: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(name); else next.delete(name);
      return next;
    });
  }, []);

  const onInstall = useCallback(async (name: string) => {
    setBusyFor(name, true);
    try {
      const res = await fetch(`${API_BASE}/api/registry/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packages: [name] }),
      });
      const body = await res.json() as
        | { ok: true; installed: Array<{ name: string; version: string; type: string }>; skipped: Array<{ name: string; reason: string }>; mcpSetupNeeded: Array<{ name: string; envVars: string[] }> }
        | { ok: false; diagnostics: Array<{ code: string; message: string }> };
      if (!body.ok) {
        toast.error(`Install failed: ${body.diagnostics[0]?.message ?? "unknown"}`);
        return;
      }
      const ok = body.installed.find((p) => p.name === name);
      if (ok) {
        toast.success(`Installed ${name}@${ok.version}`);
      } else {
        const skip = body.skipped.find((s) => s.name === name);
        if (skip) toast.info(`Skipped ${name}: ${skip.reason}`);
        else toast.success("Install completed");
      }
      if (body.mcpSetupNeeded.length > 0) {
        const list = body.mcpSetupNeeded.map((m) => `${m.name} (${m.envVars.join(", ")})`).join("; ");
        toast.info(`MCP setup needed: ${list}`);
      }
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyFor(name, false);
    }
  }, [reload, setBusyFor, toast]);

  const onUninstall = useCallback(async (name: string) => {
    setBusyFor(name, true);
    try {
      const res = await fetch(`${API_BASE}/api/registry/uninstall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packages: [name] }),
      });
      const body = await res.json() as
        | { ok: true; removed: string[]; notFound: string[] }
        | { ok: false; diagnostics: Array<{ code: string; message: string }> };
      if (!body.ok) {
        toast.error(`Uninstall failed: ${body.diagnostics[0]?.message ?? "unknown"}`);
        return;
      }
      if (body.removed.includes(name)) toast.success(`Uninstalled ${name}`);
      else if (body.notFound.includes(name)) toast.info(`${name} not in lock file`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyFor(name, false);
    }
  }, [reload, setBusyFor, toast]);

  const onUpdate = useCallback(async (name: string) => {
    setBusyFor(name, true);
    try {
      const res = await fetch(`${API_BASE}/api/registry/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json() as
        | { ok: true; updated: Array<{ name: string; from: string; to: string }>; upToDate: string[] }
        | { ok: false; diagnostics: Array<{ code: string; message: string }> };
      if (!body.ok) {
        toast.error(`Update failed: ${body.diagnostics[0]?.message ?? "unknown"}`);
        return;
      }
      const upd = body.updated.find((u) => u.name === name);
      if (upd) toast.success(`Updated ${name}: ${upd.from} → ${upd.to}`);
      else if (body.upToDate.includes(name)) toast.info(`${name} already up to date`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyFor(name, false);
    }
  }, [reload, setBusyFor, toast]);

  const filtered = useMemo(() => {
    if (!index) return null;
    let out = index;
    if (typeFilter) out = out.filter((p) => p.type === typeFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          p.author.toLowerCase().includes(q),
      );
    }
    return [...out].sort((a, b) => a.name.localeCompare(b.name));
  }, [index, query, typeFilter]);

  const installedList = useMemo(() => {
    return Array.from(installed.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [installed]);

  const outdatedCount = outdated.size;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Registry</h1>
          {index !== null && (
            <span className="text-sm text-muted">
              {index.length} package{index.length === 1 ? "" : "s"} ·{" "}
              {installed.size} installed
              {outdatedCount > 0 && (
                <span className="ml-2 text-warning-fg">· {outdatedCount} outdated</span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="search"
            placeholder="Search name, description, tags, author…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-64 rounded border border-strong bg-surface px-2 py-1 text-primary placeholder:text-muted focus:border-strong focus:outline-none"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as PackageType | "")}
            className="rounded border border-strong bg-surface px-2 py-1 text-primary focus:border-strong focus:outline-none"
          >
            <option value="">All types</option>
            {PACKAGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button onClick={() => void reload()} variant="secondary">
            Refresh
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {error}
        </div>
      )}

      {installedList.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
            Installed ({installedList.length})
          </h2>
          <div className="overflow-x-auto rounded-lg border border-default">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface text-xs uppercase tracking-wide text-secondary">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Name</th>
                  <th className="px-3 py-2 text-left font-semibold">Type</th>
                  <th className="px-3 py-2 text-left font-semibold">Version</th>
                  <th className="px-3 py-2 text-left font-semibold">Installed</th>
                  <th className="px-3 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {installedList.map((p) => {
                  const out = outdated.get(p.name);
                  const isBusy = busy.has(p.name);
                  return (
                    <tr key={p.name} className="border-t border-default">
                      <td className="px-3 py-2">
                        <span className="font-mono">{p.name}</span>
                        {out && (
                          <span className="ml-2 rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-xs text-warning-fg">
                            update available → {out.latest}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-xs ${
                            TYPE_BADGE[p.type as PackageType] ?? "border-default text-secondary"
                          }`}
                        >
                          {p.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-secondary">
                        {p.version}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {p.installedAt}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex gap-2">
                          {out && (
                            <Button
                              variant="primary"
                              disabled={isBusy}
                              onClick={() => void onUpdate(p.name)}
                            >
                              Update
                            </Button>
                          )}
                          <Button
                            variant="danger"
                            disabled={isBusy}
                            onClick={() => void onUninstall(p.name)}
                          >
                            Uninstall
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
          Available {filtered ? `(${filtered.length})` : ""}
        </h2>

        {index === null && <div className="text-sm text-muted">Loading…</div>}

        {index !== null && index.length === 0 && (
          <div className="rounded-lg border border-dashed border-strong bg-surface p-10 text-center">
            <p className="text-secondary">Registry index is empty.</p>
            <p className="mt-2 text-xs text-muted">
              Check <code className="rounded bg-elevated px-1.5 py-0.5 font-mono">OG_REGISTRY_REPO</code>
              {" "}env or registry GitHub repo accessibility.
            </p>
          </div>
        )}

        {filtered && filtered.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-default">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface text-xs uppercase tracking-wide text-secondary">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Name</th>
                  <th className="px-3 py-2 text-left font-semibold">Type</th>
                  <th className="px-3 py-2 text-left font-semibold">Version</th>
                  <th className="px-3 py-2 text-left font-semibold">Author</th>
                  <th className="px-3 py-2 text-left font-semibold">Description</th>
                  <th className="px-3 py-2 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const inst = installed.get(p.name);
                  const isBusy = busy.has(p.name);
                  const status = inst ? (
                    inst.version === p.version
                      ? "installed"
                      : `installed v${inst.version}`
                  ) : null;
                  return (
                    <tr key={p.name} className="border-t border-default hover:bg-surface transition-colors">
                      <td className="px-3 py-2">
                        <div className="flex flex-col">
                          <span className="font-mono">{p.name}</span>
                          {p.tags.length > 0 && (
                            <span className="text-xs text-muted">
                              {p.tags.map((t) => `#${t}`).join(" ")}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded border px-1.5 py-0.5 text-xs ${TYPE_BADGE[p.type] ?? "border-default text-secondary"}`}>
                          {p.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-secondary">{p.version}</td>
                      <td className="px-3 py-2 text-xs text-secondary">{p.author}</td>
                      <td className="px-3 py-2 text-xs text-secondary max-w-md">{p.description}</td>
                      <td className="px-3 py-2 text-right">
                        {inst ? (
                          <span className="text-xs text-success-fg">{status}</span>
                        ) : (
                          <Button
                            variant="primary"
                            disabled={isBusy}
                            onClick={() => void onInstall(p.name)}
                          >
                            {isBusy ? "Installing…" : "Install"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered && filtered.length === 0 && index !== null && index.length > 0 && (
          <p className="text-sm text-muted">
            No packages match{" "}
            {query && <code className="rounded bg-elevated px-1 font-mono">{query}</code>}
            {query && typeFilter && " in "}
            {typeFilter && <code className="rounded bg-elevated px-1 font-mono">type={typeFilter}</code>}.
          </p>
        )}
      </section>
    </div>
  );
}
