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
  // Always prefer local index.json if it exists (committed to git)
  const localIndex = path.join(REGISTRY_DIR, "index.json");
  if (fs.existsSync(localIndex)) {
    const raw = fs.readFileSync(localIndex, "utf-8");
    return JSON.parse(raw) as RegistryIndex;
  }
  const url = registryUrl("index.json");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch registry index: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RegistryIndex;
}

export async function fetchManifest(packageName: string): Promise<PackageManifest> {
  if (hasLocalPackages()) {
    const manifestPath = path.join(REGISTRY_DIR, "packages", packageName, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Manifest not found for "${packageName}" in local registry`);
    }
    const text = fs.readFileSync(manifestPath, "utf-8");
    return parseYaml(text) as PackageManifest;
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
  if (hasLocalPackages()) {
    const sourceFile = path.join(REGISTRY_DIR, "packages", packageName, filePath);
    if (!fs.existsSync(sourceFile)) {
      throw new Error(`File "${filePath}" not found for "${packageName}" at ${sourceFile}`);
    }
    return fs.readFileSync(sourceFile, "utf-8");
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
  for (const file of files) {
    const content = await fetchPackageFile(packageName, file);
    const dest = path.join(destDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf-8");
    written.push(dest);
  }
  return written;
}
