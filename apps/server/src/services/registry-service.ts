import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fetchIndex, fetchManifest, downloadPackageFiles } from "../cli/lib/fetch.js";
import { readLock, writeLock, addToLock, removeFromLock } from "../cli/lib/lock.js";
import { TYPE_DIR_MAP, CONFIG_DIR } from "../cli/lib/constants.js";
import { publishToGitHub } from "../cli/lib/github.js";
import type {
  RegistryIndex,
  RegistryPackageSummary,
  PackageManifest,
  PackageType,
  LockFile,
  LockFileEntry,
} from "../cli/lib/types.js";

export interface McpSetupNeeded {
  name: string;
  envVars: string[];
}

export interface InstallResult {
  installed: { name: string; version: string; type: string }[];
  skipped: { name: string; reason: string }[];
  mcpSetupNeeded: McpSetupNeeded[];
}

export interface UpdateResult {
  updated: { name: string; from: string; to: string }[];
  upToDate: string[];
}

export interface UninstallResult {
  removed: string[];
  notFound: string[];
}

export interface OutdatedEntry {
  name: string;
  installed: string;
  latest: string;
  type: string;
}

const SERVER_ROOT = path.resolve(CONFIG_DIR, "..");

export class RegistryService {
  async getIndex(): Promise<RegistryIndex> {
    return fetchIndex();
  }

  async search(query?: string, type?: string): Promise<RegistryPackageSummary[]> {
    const index = await fetchIndex();
    let results = index.packages;

    if (type) {
      results = results.filter((p) => p.type === type);
    }

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return results;
  }

  async getManifest(name: string): Promise<PackageManifest> {
    return fetchManifest(name);
  }

  async install(
    packages: string[],
    options?: { force?: boolean },
  ): Promise<InstallResult> {
    let lock = readLock();
    const result: InstallResult = { installed: [], skipped: [], mcpSetupNeeded: [] };
    const force = options?.force ?? false;

    // Collect all packages to install (including dependencies)
    const toInstall = new Map<string, PackageManifest>();
    for (const spec of packages) {
      const name = spec.split("@")[0];
      try {
        await this.collectDeps(name, toInstall);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.skipped.push({ name, reason: msg });
      }
    }

    // Always include all fragments — they are global knowledge, any pipeline may need them
    const index = await fetchIndex();
    for (const pkg of index.packages) {
      if (pkg.type === "fragment" && !toInstall.has(pkg.name)) {
        try {
          const manifest = await fetchManifest(pkg.name);
          toInstall.set(pkg.name, manifest);
        } catch {
          result.skipped.push({ name: pkg.name, reason: "Manifest not available" });
        }
      }
    }

    const requestedNames = new Set(packages.map((s) => s.split("@")[0]));

    for (const [name, manifest] of toInstall) {
      // Force-install explicitly requested packages to avoid silent skip
      // when files exist but aren't tracked in lockfile
      const forceThis = force || requestedNames.has(name);
      const installResult = await this.installOne(name, manifest, lock, forceThis);
      if (installResult.skipped) {
        result.skipped.push({ name, reason: installResult.skipped });
      } else {
        lock = installResult.lock;
        result.installed.push({
          name,
          version: manifest.version,
          type: manifest.type,
        });
      }
    }

    // Check which installed MCPs need env var setup
    for (const inst of result.installed) {
      if (inst.type === "mcp") {
        const manifest = toInstall.get(inst.name);
        if (manifest?.mcp_entry?.env) {
          const missing = this.findMissingEnvVars(manifest.mcp_entry.env);
          if (missing.length > 0) {
            result.mcpSetupNeeded.push({ name: inst.name, envVars: missing });
          }
        }
      }
    }

    writeLock(lock);
    return result;
  }

  async uninstall(packages: string[]): Promise<UninstallResult> {
    let lock = readLock();
    const result: UninstallResult = { removed: [], notFound: [] };

    for (const name of packages) {
      const entry = lock.packages[name];
      if (!entry) {
        result.notFound.push(name);
        continue;
      }

      if (entry.type === "mcp") {
        // MCP: remove entry from registry.yaml
        this.removeMcpEntry(name);
      } else {
        // Non-MCP: remove installed files
        for (const relFile of entry.files) {
          const absFile = path.join(SERVER_ROOT, relFile);
          if (fs.existsSync(absFile)) {
            fs.rmSync(absFile);
          }
        }

        // Clean up empty directories
        const typeDir = TYPE_DIR_MAP[entry.type];
        if (typeDir) {
          const isSingleFile =
            entry.type === "skill" ||
            entry.type === "fragment" ||
            entry.type === "hook" ||
            entry.type === "gate";

          if (!isSingleFile) {
            const pkgDir = path.join(CONFIG_DIR, typeDir, name);
            if (
              fs.existsSync(pkgDir) &&
              fs.readdirSync(pkgDir).length === 0
            ) {
              fs.rmdirSync(pkgDir);
            }
          }
        }
      }

      lock = removeFromLock(lock, name);
      result.removed.push(name);
    }

    writeLock(lock);
    return result;
  }

  async update(name?: string): Promise<UpdateResult> {
    let lock = readLock();
    const result: UpdateResult = { updated: [], upToDate: [] };

    const toUpdate = name
      ? [[name, lock.packages[name]] as const]
      : Object.entries(lock.packages);

    if (name && !lock.packages[name]) {
      throw new Error(`Package "${name}" is not installed.`);
    }

    for (const [pkgName, entry] of toUpdate) {
      if (!entry) continue;

      const manifest = await fetchManifest(pkgName);
      if (manifest.version === entry.version) {
        result.upToDate.push(pkgName);
        continue;
      }

      if (manifest.type === "mcp") {
        // MCP: update registry.yaml entry (preserve user env)
        if (manifest.mcp_entry) {
          this.mergeMcpEntry(pkgName, manifest.mcp_entry);
        }
        lock = addToLock(lock, pkgName, {
          version: manifest.version,
          type: "mcp",
          author: manifest.author,
          installed_at: new Date().toISOString(),
          files: ["config/mcps/registry.yaml"],
        });
      } else {
        const typeDir = TYPE_DIR_MAP[manifest.type];
        if (!typeDir) continue;

        const isSingleFile =
          manifest.type === "skill" ||
          manifest.type === "fragment" ||
          manifest.type === "hook" ||
          manifest.type === "gate";

        const destDir = isSingleFile
          ? path.join(CONFIG_DIR, typeDir)
          : path.join(CONFIG_DIR, typeDir, pkgName);

        // Remove old files (preserve .local/ directories)
        for (const relFile of entry.files) {
          const absFile = path.join(SERVER_ROOT, relFile);
          if (fs.existsSync(absFile) && !absFile.includes("/.local/")) {
            fs.rmSync(absFile);
          }
        }

        const written = await downloadPackageFiles(pkgName, manifest.files, destDir);
        const relFiles = written.map((f) => path.relative(SERVER_ROOT, f));

        lock = addToLock(lock, pkgName, {
          version: manifest.version,
          type: manifest.type,
          author: manifest.author,
          installed_at: new Date().toISOString(),
          files: relFiles,
        });
      }

      result.updated.push({
        name: pkgName,
        from: entry.version,
        to: manifest.version,
      });
    }

    writeLock(lock);
    return result;
  }

  listInstalled(type?: string): Record<string, LockFileEntry> {
    const lock = readLock();
    const merged = { ...lock.packages };

    // Merge pipelines that exist on disk but aren't in the lock file (e.g. builtin pipelines)
    const pipelinesDir = path.join(CONFIG_DIR, "pipelines");
    if (fs.existsSync(pipelinesDir)) {
      for (const entry of fs.readdirSync(pipelinesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.endsWith(".local")) continue;
        if (merged[entry.name]) continue;
        const yamlPath = path.join(pipelinesDir, entry.name, "pipeline.yaml");
        if (!fs.existsSync(yamlPath)) continue;
        try {
          const raw = fs.readFileSync(yamlPath, "utf-8");
          const parsed = parseYaml(raw) as { name?: string; official?: boolean };
          merged[entry.name] = {
            version: parsed.official ? "builtin" : "local",
            type: "pipeline",
            author: parsed.official ? "workflow-control" : "local",
            installed_at: fs.statSync(yamlPath).mtime.toISOString(),
            files: [`config/pipelines/${entry.name}/pipeline.yaml`],
          };
        } catch { /* skip unreadable */ }
      }
    }

    if (!type) return merged;

    const filtered: Record<string, LockFileEntry> = {};
    for (const [name, entry] of Object.entries(merged)) {
      if (entry.type === type) {
        filtered[name] = entry;
      }
    }
    return filtered;
  }

  async checkOutdated(): Promise<OutdatedEntry[]> {
    const lock = readLock();
    const installed = Object.entries(lock.packages);

    if (installed.length === 0) return [];

    const index = await fetchIndex();
    const latestMap = new Map(index.packages.map((p) => [p.name, p]));

    const outdated: OutdatedEntry[] = [];
    for (const [name, entry] of installed) {
      const remote = latestMap.get(name);
      if (remote && remote.version !== entry.version) {
        outdated.push({
          name,
          installed: entry.version,
          latest: remote.version,
          type: entry.type,
        });
      }
    }

    return outdated;
  }

  async bootstrap(packages: string[]): Promise<InstallResult> {
    return this.install(packages, { force: true });
  }

  installDiscoveredMcp(
    name: string,
    entry: { description?: string; command: string; args?: string[]; env?: Record<string, string | { json: Record<string, string> }> },
  ): { installed: boolean; mcpSetupNeeded?: McpSetupNeeded } {
    let lock = readLock();
    const manifest: PackageManifest = {
      name,
      version: "0.0.0-discovered",
      type: "mcp",
      description: entry.description ?? "",
      author: "capability-discovery",
      tags: ["auto-discovered"],
      files: [],
      mcp_entry: entry,
    };
    const result = this.installMcp(name, manifest, lock, false);
    if (result.skipped) return { installed: false };
    writeLock(result.lock);

    // Check if the MCP needs env vars
    if (manifest.mcp_entry?.env) {
      const missing = this.findMissingEnvVars(manifest.mcp_entry.env);
      if (missing.length > 0) {
        return { installed: true, mcpSetupNeeded: { name, envVars: missing } };
      }
    }
    return { installed: true };
  }

  /**
   * Scan config/ for locally-present packages that are NOT in the registry index.
   * These are user-created configs (from Config page) that can be published.
   */
  listLocalOnly(): { name: string; type: string }[] {
    const lock = readLock();
    const results: { name: string; type: string }[] = [];

    for (const [type, dir] of Object.entries(TYPE_DIR_MAP)) {
      if (type === "mcp") continue; // handled separately below

      const absDir = path.join(CONFIG_DIR, dir);
      if (!fs.existsSync(absDir)) continue;

      const isSingleFile =
        type === "skill" || type === "fragment" || type === "hook" || type === "gate";

      if (isSingleFile) {
        const ext: Record<string, string> = {
          skill: ".md",
          fragment: ".md",
          hook: ".yaml",
          gate: ".ts",
        };
        const suffix = ext[type] || "";
        for (const file of fs.readdirSync(absDir)) {
          if (file.startsWith(".") || file.startsWith("_")) continue;
          if (suffix && !file.endsWith(suffix)) continue;
          const name = file.replace(/\.[^.]+$/, "");
          if (!lock.packages[name]) {
            results.push({ name, type });
          }
        }
      } else {
        for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const name = entry.name;
          if (!lock.packages[name]) {
            results.push({ name, type });
          }
        }
      }
    }

    // Scan MCP entries in registry.yaml not tracked by lock
    const registryPath = path.join(CONFIG_DIR, "mcps", "registry.yaml");
    if (fs.existsSync(registryPath)) {
      try {
        const raw = fs.readFileSync(registryPath, "utf-8");
        const mcpEntries = parseYaml(raw) as Record<string, unknown> | null;
        if (mcpEntries) {
          for (const name of Object.keys(mcpEntries)) {
            if (!lock.packages[name]) {
              results.push({ name, type: "mcp" });
            }
          }
        }
      } catch { /* ignore parse errors */ }
    }

    return results;
  }

  async publish(name: string, type: string): Promise<{ success: boolean; message: string }> {
    const typeDir = TYPE_DIR_MAP[type];
    if (!typeDir) {
      throw new Error(`Invalid package type: ${type}`);
    }

    // MCP publish: read entry from registry.yaml, generate manifest with mcp_entry
    if (type === "mcp") {
      return this.publishMcp(name);
    }

    const isSingleFile =
      type === "skill" || type === "fragment" || type === "hook" || type === "gate";

    // Collect files from config/
    const files: string[] = [];
    if (isSingleFile) {
      const extensions: Record<string, string> = {
        skill: ".md",
        fragment: ".md",
        hook: ".yaml",
        gate: ".ts",
      };
      const ext = extensions[type] || "";
      const filePath = path.join(CONFIG_DIR, typeDir, name + ext);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      files.push(name + ext);
    } else {
      const pkgDir = path.join(CONFIG_DIR, typeDir, name);
      if (!fs.existsSync(pkgDir)) {
        throw new Error(`Directory not found: ${pkgDir}`);
      }
      const collected = this.collectFilesRecursive(pkgDir);
      for (const f of collected) {
        files.push(path.relative(pkgDir, f));
      }
    }

    // Build a temporary package directory with manifest + files
    const tmpDir = path.join(CONFIG_DIR, "..", ".publish-tmp", name);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // Generate manifest
      const manifest: PackageManifest = {
        name,
        version: "1.0.0",
        type: type as PackageManifest["type"],
        description: `${type}: ${name}`,
        author: "workflow-control",
        tags: [type],
        files,
      };
      fs.writeFileSync(
        path.join(tmpDir, "manifest.yaml"),
        stringifyYaml(manifest, { lineWidth: 120 }),
        "utf-8",
      );

      // Copy files
      for (const file of files) {
        const src = isSingleFile
          ? path.join(CONFIG_DIR, typeDir, file)
          : path.join(CONFIG_DIR, typeDir, name, file);
        const dest = path.join(tmpDir, file);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }

      // Push to GitHub — manifest goes along so updateRemoteIndex can upsert
      // the registry index.json entry without re-parsing from disk.
      await publishToGitHub({
        packageDir: tmpDir,
        packageName: name,
        files,
        manifest,
      });

      return { success: true, message: `Published ${name} to registry` };
    } finally {
      // Clean up tmp dir
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const parentTmp = path.join(CONFIG_DIR, "..", ".publish-tmp");
      if (fs.existsSync(parentTmp) && fs.readdirSync(parentTmp).length === 0) {
        fs.rmdirSync(parentTmp);
      }
    }
  }

  private async publishMcp(name: string): Promise<{ success: boolean; message: string }> {
    const registry = this.loadMcpRegistryRaw();
    const entry = registry[name];
    if (!entry) {
      throw new Error(`MCP "${name}" not found in registry.yaml`);
    }

    const tmpDir = path.join(CONFIG_DIR, "..", ".publish-tmp", name);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const mcpEntry = entry as Record<string, unknown>;
      const manifest: PackageManifest = {
        name,
        version: "1.0.0",
        type: "mcp",
        description: (mcpEntry.description as string) || `MCP: ${name}`,
        author: "workflow-control",
        tags: ["mcp"],
        files: [],
        mcp_entry: entry as PackageManifest["mcp_entry"],
      };
      fs.writeFileSync(
        path.join(tmpDir, "manifest.yaml"),
        stringifyYaml(manifest, { lineWidth: 120 }),
        "utf-8",
      );

      await publishToGitHub({
        packageDir: tmpDir,
        packageName: name,
        files: [],
        manifest,
      });

      return { success: true, message: `Published MCP ${name} to registry` };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const parentTmp = path.join(CONFIG_DIR, "..", ".publish-tmp");
      if (fs.existsSync(parentTmp) && fs.readdirSync(parentTmp).length === 0) {
        fs.rmdirSync(parentTmp);
      }
    }
  }

  private collectFilesRecursive(dir: string): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...this.collectFilesRecursive(full));
      } else {
        result.push(full);
      }
    }
    return result;
  }

  private async collectDeps(
    name: string,
    collected: Map<string, PackageManifest>,
  ): Promise<void> {
    if (collected.has(name)) return;

    const manifest = await fetchManifest(name);
    collected.set(name, manifest);

    const deps = manifest.dependencies;
    if (!deps) return;

    const allDeps = [
      ...(deps.skills ?? []),
      ...(deps.fragments ?? []),
      ...(deps.hooks ?? []),
      ...(deps.scripts ?? []),
      ...(deps.mcps ?? []),
    ];
    for (const dep of allDeps) {
      await this.collectDeps(dep, collected);
    }
  }

  private async installOne(
    name: string,
    manifest: PackageManifest,
    lock: LockFile,
    force = false,
  ): Promise<{ lock: LockFile; skipped?: string }> {
    // MCP packages merge into registry.yaml instead of downloading files
    if (manifest.type === "mcp") {
      return this.installMcp(name, manifest, lock, force);
    }

    const typeDir = TYPE_DIR_MAP[manifest.type];
    if (!typeDir) {
      return { lock, skipped: `Unknown package type: ${manifest.type}` };
    }

    const destDir = path.join(CONFIG_DIR, typeDir, name);
    const isSingleFile =
      manifest.type === "skill" ||
      manifest.type === "fragment" ||
      manifest.type === "hook" ||
      manifest.type === "gate";

    const actualDest = isSingleFile ? path.join(CONFIG_DIR, typeDir) : destDir;

    // Check for conflicts with user-created files (skip when force=true)
    if (!force && !lock.packages[name]) {
      if (isSingleFile) {
        for (const file of manifest.files) {
          const target = path.join(actualDest, file);
          if (fs.existsSync(target)) {
            return {
              lock,
              skipped: `File "${target}" already exists and was not installed by registry`,
            };
          }
        }
      } else if (fs.existsSync(destDir)) {
        return {
          lock,
          skipped: `Directory "${destDir}" already exists and was not installed by registry`,
        };
      }
    }

    const written = await downloadPackageFiles(name, manifest.files, actualDest);
    const relFiles = written.map((f) => path.relative(SERVER_ROOT, f));

    return {
      lock: addToLock(lock, name, {
        version: manifest.version,
        type: manifest.type,
        author: manifest.author,
        installed_at: new Date().toISOString(),
        files: relFiles,
      }),
    };
  }

  // --- MCP-specific helpers ---

  private installMcp(
    name: string,
    manifest: PackageManifest,
    lock: LockFile,
    force: boolean,
  ): { lock: LockFile; skipped?: string } {
    if (!manifest.mcp_entry) {
      return { lock, skipped: "MCP package missing mcp_entry in manifest" };
    }

    const registryPath = path.join(CONFIG_DIR, "mcps", "registry.yaml");
    const existing = this.loadMcpRegistryRaw();

    if (!force && existing[name] && !lock.packages[name]) {
      return { lock, skipped: `MCP "${name}" already exists in registry.yaml and was not installed by registry` };
    }

    this.mergeMcpEntry(name, manifest.mcp_entry);

    return {
      lock: addToLock(lock, name, {
        version: manifest.version,
        type: "mcp",
        author: manifest.author,
        installed_at: new Date().toISOString(),
        files: ["config/mcps/registry.yaml"],
      }),
    };
  }

  private loadMcpRegistryRaw(): Record<string, unknown> {
    const registryPath = path.join(CONFIG_DIR, "mcps", "registry.yaml");
    if (!fs.existsSync(registryPath)) return {};
    try {
      return (parseYaml(fs.readFileSync(registryPath, "utf-8")) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  private writeMcpRegistry(data: Record<string, unknown>): void {
    const registryPath = path.join(CONFIG_DIR, "mcps", "registry.yaml");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, stringifyYaml(data, { lineWidth: 120 }), "utf-8");
  }

  private mergeMcpEntry(name: string, entry: NonNullable<PackageManifest["mcp_entry"]>): void {
    const registry = this.loadMcpRegistryRaw();
    const existing = registry[name] as Record<string, unknown> | undefined;

    if (existing?.env && entry.env) {
      // Merge env: use new package's key set as the source of truth,
      // but preserve user's existing values for keys that still exist.
      const oldEnv = existing.env as Record<string, unknown>;
      const mergedEnv: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry.env)) {
        mergedEnv[k] = k in oldEnv ? oldEnv[k] : v;
      }
      registry[name] = { ...entry, env: mergedEnv };
    } else {
      registry[name] = { ...entry };
    }

    this.writeMcpRegistry(registry);
  }

  private removeMcpEntry(name: string): void {
    const registry = this.loadMcpRegistryRaw();
    delete registry[name];
    this.writeMcpRegistry(registry);
  }

  /** Extract env var names referenced in an MCP entry's env config. */
  private findMissingEnvVars(
    env: Record<string, string | { json: Record<string, string> }>,
  ): string[] {
    const missing: string[] = [];
    const varPattern = /\$\{([^}]+)\}/g;

    for (const value of Object.values(env)) {
      if (value == null || typeof value === "number" || typeof value === "boolean") continue;

      const strings = typeof value === "string"
        ? [value]
        : (value.json && typeof value.json === "object")
          ? Object.values(value.json).filter((v): v is string => typeof v === "string")
          : [];

      for (const s of strings) {
        for (const match of s.matchAll(varPattern)) {
          const varName = match[1];
          if (!process.env[varName]) {
            missing.push(varName);
          }
        }
      }
    }

    return [...new Set(missing)];
  }
}

export const registryService = new RegistryService();
