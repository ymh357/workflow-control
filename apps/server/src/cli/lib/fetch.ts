import { REGISTRY_BASE_URL, REGISTRY_DIR } from "./constants.js";
import type { RegistryIndex, PackageManifest } from "./types.js";
import { parse as parseYaml } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";

// Local registry with packages/ available (for dev after registry:build)
function hasLocalPackages(): boolean {
  return fs.existsSync(path.join(REGISTRY_DIR, "packages"));
}

function registryUrl(relativePath: string): string {
  const base = REGISTRY_BASE_URL.endsWith("/")
    ? REGISTRY_BASE_URL
    : REGISTRY_BASE_URL + "/";
  return base + relativePath;
}

export async function fetchIndex(): Promise<RegistryIndex> {
  // Load local index if it exists
  const localIndex = path.join(REGISTRY_DIR, "index.json");
  let local: RegistryIndex | null = null;
  if (fs.existsSync(localIndex)) {
    const raw = fs.readFileSync(localIndex, "utf-8");
    local = JSON.parse(raw) as RegistryIndex;
  }

  // Fetch remote index and merge with local (local entries take priority)
  try {
    const url = registryUrl("index.json");
    const res = await fetch(url);
    if (res.ok) {
      const remote = (await res.json()) as RegistryIndex;
      if (!local) return remote;

      // Merge: local packages win, remote fills the gaps
      const merged = { ...local };
      const localNames = new Set(local.packages.map((p) => p.name));
      for (const pkg of remote.packages) {
        if (!localNames.has(pkg.name)) {
          merged.packages.push(pkg);
        }
      }
      return merged;
    }
  } catch {
    // Remote unavailable — use local only
  }

  if (local) return local;
  throw new Error("No registry index available (local or remote)");
}

export async function fetchManifest(packageName: string): Promise<PackageManifest> {
  if (packageName.includes("..") || packageName.includes("/") || packageName.includes("\\")) {
    throw new Error(`Invalid package name: ${packageName}`);
  }
  // Try local first
  if (hasLocalPackages()) {
    const manifestPath = path.join(REGISTRY_DIR, "packages", packageName, "manifest.yaml");
    if (fs.existsSync(manifestPath)) {
      const text = fs.readFileSync(manifestPath, "utf-8");
      return parseYaml(text) as PackageManifest;
    }
    // Not found locally — fall through to remote
  }
  const url = registryUrl(`packages/${packageName}/manifest.yaml`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch manifest for "${packageName}": ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return parseYaml(text) as PackageManifest;
}

export async function fetchPackageFile(
  packageName: string,
  filePath: string,
): Promise<string> {
  if (packageName.includes("..") || packageName.includes("/") || packageName.includes("\\")) {
    throw new Error(`Invalid package name: ${packageName}`);
  }
  // Try local first
  if (hasLocalPackages()) {
    const sourceFile = path.join(REGISTRY_DIR, "packages", packageName, filePath);
    if (fs.existsSync(sourceFile)) {
      return fs.readFileSync(sourceFile, "utf-8");
    }
    // Not found locally — fall through to remote
  }
  const url = registryUrl(`packages/${packageName}/${filePath}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch file "${filePath}" from "${packageName}": ${res.status} ${res.statusText}`);
  }
  return res.text();
}

export async function downloadPackageFiles(
  packageName: string,
  files: string[],
  destDir: string,
): Promise<string[]> {
  const written: string[] = [];
  const resolvedDestDir = path.resolve(destDir);
  for (const file of files) {
    const dest = path.join(destDir, file);
    const resolved = path.resolve(dest);
    if (!resolved.startsWith(resolvedDestDir + path.sep)) {
      throw new Error(`File path escapes destination directory: ${file}`);
    }
    const content = await fetchPackageFile(packageName, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf-8");
    written.push(dest);
  }
  return written;
}
