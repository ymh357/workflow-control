import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { PackageManifest } from "../lib/types.js";
import { TYPE_DIR_MAP, REGISTRY_DIR } from "../lib/constants.js";
import { publishToGitHub } from "../lib/github.js";

const REQUIRED_FIELDS: (keyof PackageManifest)[] = [
  "name",
  "version",
  "type",
  "description",
  "author",
  "tags",
  "files",
];

export async function publishCommand(directory: string | undefined): Promise<void> {
  if (!directory) {
    console.log("Usage: publish <directory>");
    process.exit(1);
  }

  const dir = path.resolve(directory);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const manifestPath = path.join(dir, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest.yaml not found in ${dir}`);
    process.exit(1);
  }

  let manifest: PackageManifest;
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    manifest = parseYaml(raw) as PackageManifest;
  } catch (err) {
    console.error(`Failed to parse manifest.yaml: ${err}`);
    process.exit(1);
  }

  // Validate required fields
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (!TYPE_DIR_MAP[manifest.type]) {
    errors.push(`Invalid type: "${manifest.type}". Must be one of: ${Object.keys(TYPE_DIR_MAP).join(", ")}`);
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push("files must be a non-empty array");
  }

  // Check that all listed files exist
  const missingFiles: string[] = [];
  if (Array.isArray(manifest.files)) {
    for (const file of manifest.files) {
      const filePath = path.join(dir, file);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(file);
      }
    }
  }
  if (missingFiles.length > 0) {
    errors.push(`Missing files: ${missingFiles.join(", ")}`);
  }

  if (errors.length > 0) {
    console.error("Validation errors:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  // Print summary
  console.log("Package validation passed!\n");
  console.log(`  Name:        ${manifest.name}`);
  console.log(`  Version:     ${manifest.version}`);
  console.log(`  Type:        ${manifest.type}`);
  console.log(`  Author:      ${manifest.author}`);
  console.log(`  Description: ${manifest.description}`);
  console.log(`  Tags:        ${manifest.tags.join(", ")}`);
  console.log(`  Files:       ${manifest.files.join(", ")}`);
  if (manifest.dependencies) {
    console.log(`  Dependencies:`);
    for (const [kind, deps] of Object.entries(manifest.dependencies)) {
      if (deps && deps.length > 0) {
        console.log(`    ${kind}: ${deps.join(", ")}`);
      }
    }
  }

  // Push to GitHub
  console.log("\nPublishing to registry via GitHub API...\n");

  try {
    await publishToGitHub({
      packageDir: dir,
      packageName: manifest.name,
      files: manifest.files,
      manifest,
    });
    console.log(`\nSuccessfully published ${manifest.name}@${manifest.version} to registry.`);
  } catch (err) {
    console.error(`\nPublish failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Rebuild local index.json so the running server picks up the new package
  const buildIndexPath = path.join(REGISTRY_DIR, "build-index.ts");
  if (fs.existsSync(buildIndexPath)) {
    try {
      console.log("\nRebuilding local registry index...");
      execFileSync("npx", ["tsx", buildIndexPath], {
        encoding: "utf-8",
        stdio: "inherit",
        timeout: 15_000,
      });
    } catch (err) {
      console.warn(`Warning: failed to rebuild index.json: ${(err as Error).message}`);
    }
  }
}
