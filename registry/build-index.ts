#!/usr/bin/env tsx
// Scans all package manifests and generates registry/index.json

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(__dirname, "packages");
const INDEX_FILE = path.resolve(__dirname, "index.json");

interface ManifestSummary {
  name: string;
  version: string;
  type: string;
  description: string;
  author: string;
  tags: string[];
  engine_compat?: string;
}

function main(): void {
  const packages: ManifestSummary[] = [];

  if (!fs.existsSync(PACKAGES_DIR)) {
    console.error(`Packages directory not found: ${PACKAGES_DIR}`);
    process.exit(1);
  }

  const dirs = fs.readdirSync(PACKAGES_DIR).filter((d) => {
    return fs.statSync(path.join(PACKAGES_DIR, d)).isDirectory();
  });

  for (const dir of dirs.sort()) {
    const manifestPath = path.join(PACKAGES_DIR, dir, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) {
      console.warn(`  Skipping ${dir}: no manifest.yaml`);
      continue;
    }

    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const manifest = parseYaml(raw) as Record<string, unknown>;

      packages.push({
        name: manifest.name as string,
        version: manifest.version as string,
        type: manifest.type as string,
        description: manifest.description as string,
        author: manifest.author as string,
        tags: (manifest.tags as string[]) || [],
        ...(manifest.engine_compat ? { engine_compat: manifest.engine_compat as string } : {}),
      });
    } catch (err) {
      console.error(`  Error parsing ${dir}/manifest.yaml: ${err}`);
    }
  }

  const index = {
    version: 1,
    updated_at: new Date().toISOString(),
    packages,
  };

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n", "utf-8");
  console.log(`Generated index.json with ${packages.length} packages.`);
}

main();
