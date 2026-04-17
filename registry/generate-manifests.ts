#!/usr/bin/env tsx
/**
 * Scans apps/server/config/ and generates manifest.yaml + copies actual files
 * for each pipeline, skill, hook, and fragment into registry/packages/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, "../apps/server/config");
const BUILTIN_DIR = path.resolve(__dirname, "../apps/server/src/builtin-pipelines");
const PACKAGES_DIR = path.resolve(__dirname, "packages");

const AUTHOR = "workflow-control";
const DEFAULT_VERSION = "1.0.0";

interface PipelineYaml {
  name: string;
  version?: string;
  description: string;
  engine: string;
  hooks?: string[];
  skills?: string[];
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function listDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !f.startsWith("."));
}

function writeManifest(name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(PACKAGES_DIR, name);
  ensureDir(dir);
  fs.writeFileSync(
    path.join(dir, "manifest.yaml"),
    stringifyYaml(manifest, { lineWidth: 120 }),
    "utf-8",
  );
  console.log(`  Created: ${name}/manifest.yaml`);
}

function copyFile(src: string, dest: string): void {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function collectFiles(dir: string, _base: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(full, _base));
    } else {
      result.push(full);
    }
  }
  return result;
}

// --- Pipelines ---

function generatePipelinesFromDir(pipelinesDir: string, seen: Set<string>): void {
  for (const dirName of listDir(pipelinesDir)) {
    const pipelineFile = path.join(pipelinesDir, dirName, "pipeline.yaml");
    if (!fs.existsSync(pipelineFile)) continue;
    if (seen.has(dirName)) continue;
    seen.add(dirName);

    const raw = fs.readFileSync(pipelineFile, "utf-8");
    const pipeline = parseYaml(raw) as PipelineYaml;

    // Collect files in the pipeline directory
    const files = collectFiles(path.join(pipelinesDir, dirName), pipelinesDir);
    const relFiles = files.map((f) => path.relative(path.join(pipelinesDir, dirName), f));

    // Build dependencies from hooks/skills
    const dependencies: Record<string, string[]> = {};
    if (pipeline.hooks?.length) dependencies.hooks = pipeline.hooks;
    if (pipeline.skills?.length) dependencies.skills = pipeline.skills;

    // Determine tags
    const tags: string[] = [];
    if (pipeline.engine) tags.push(pipeline.engine);
    if (dirName.includes("bugfix")) tags.push("bugfix", "debugging");
    if (dirName.includes("normal")) tags.push("fullstack", "feature");
    if (dirName.includes("refactor")) tags.push("refactoring", "migration");
    if (dirName.includes("text")) tags.push("text-input", "quick");

    writeManifest(dirName, {
      name: dirName,
      version: pipeline.version || DEFAULT_VERSION,
      type: "pipeline",
      description: pipeline.description || pipeline.name,
      author: AUTHOR,
      tags,
      engine_compat: pipeline.engine,

      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      files: relFiles,
    });

    // Copy actual files to package directory
    const pkgDir = path.join(PACKAGES_DIR, dirName);
    for (const file of files) {
      const rel = path.relative(path.join(pipelinesDir, dirName), file);
      copyFile(file, path.join(pkgDir, rel));
    }
    console.log(`  Copied ${files.length} files to ${dirName}/`);
  }
}

function generatePipelines(): void {
  console.log("\nPipelines:");
  const seen = new Set<string>();
  // config/pipelines/ takes priority (user-installed)
  generatePipelinesFromDir(path.join(CONFIG_DIR, "pipelines"), seen);
  // builtin-pipelines/ as fallback source
  generatePipelinesFromDir(BUILTIN_DIR, seen);
}

// --- Skills ---

function generateSkills(): void {
  console.log("\nSkills:");
  const skillsDir = path.join(CONFIG_DIR, "skills");
  for (const file of listDir(skillsDir)) {
    if (!file.endsWith(".md")) continue;
    const name = file.replace(/\.md$/, "");
    const description = getSkillDescription(name);

    writeManifest(name, {
      name,
      version: DEFAULT_VERSION,
      type: "skill",
      description,
      author: AUTHOR,
      tags: getSkillTags(name),

      files: [file],
    });

    // Copy actual file
    copyFile(
      path.join(skillsDir, file),
      path.join(PACKAGES_DIR, name, file),
    );
    console.log(`  Copied ${file} to ${name}/`);
  }
}

function getSkillDescription(name: string): string {
  const map: Record<string, string> = {
    "security-review": "Review code changes for security vulnerabilities (XSS, injection, secrets, auth)",
    "performance-audit": "Audit code for performance issues and optimization opportunities",
    "systematic-debugging": "Systematic debugging methodology with reproduction and root cause analysis",
    "finishing-branch": "Final checks and cleanup before merging a feature branch",
    "web3-check": "Web3-specific security and correctness checks for smart contract interactions",
  };
  return map[name] || `Skill: ${name}`;
}

function getSkillTags(name: string): string[] {
  const map: Record<string, string[]> = {
    "security-review": ["security", "review", "xss", "injection"],
    "performance-audit": ["performance", "optimization", "audit"],
    "systematic-debugging": ["debugging", "investigation", "root-cause"],
    "finishing-branch": ["git", "cleanup", "pr"],
    "web3-check": ["web3", "security", "smart-contract"],
  };
  return map[name] || [name];
}

// --- Hooks ---

function generateHooks(): void {
  console.log("\nHooks:");
  const hooksDir = path.join(CONFIG_DIR, "hooks");
  for (const file of listDir(hooksDir)) {
    if (!file.endsWith(".yaml")) continue;
    const name = file.replace(/\.yaml$/, "");

    writeManifest(name, {
      name,
      version: DEFAULT_VERSION,
      type: "hook",
      description: getHookDescription(name),
      author: AUTHOR,
      tags: getHookTags(name),

      files: [file],
    });

    // Copy actual file
    copyFile(
      path.join(hooksDir, file),
      path.join(PACKAGES_DIR, name, file),
    );
    console.log(`  Copied ${file} to ${name}/`);
  }
}

function getHookDescription(name: string): string {
  const map: Record<string, string> = {
    "format-on-write": "Auto-format TypeScript/JS/CSS files after Write or Edit using Prettier and ESLint",
    "protect-files": "Prevent modifications to protected files (lock files, generated code, etc.)",
    "safety-guard": "Safety guard hook to prevent dangerous operations",
  };
  return map[name] || `Hook: ${name}`;
}

function getHookTags(name: string): string[] {
  const map: Record<string, string[]> = {
    "format-on-write": ["formatting", "prettier", "eslint", "auto-format"],
    "protect-files": ["protection", "safety", "lock-files"],
    "safety-guard": ["safety", "guard", "protection"],
  };
  return map[name] || [name];
}

// --- Fragments ---

function generateFragments(): void {
  console.log("\nFragments:");
  const fragmentsDir = path.join(CONFIG_DIR, "prompts/fragments");
  for (const file of listDir(fragmentsDir)) {
    if (!file.endsWith(".md")) continue;
    const name = file.replace(/\.md$/, "");

    writeManifest(name, {
      name,
      version: DEFAULT_VERSION,
      type: "fragment",
      description: getFragmentDescription(name),
      author: AUTHOR,
      tags: getFragmentTags(name),

      files: [file],
    });

    // Copy actual file
    copyFile(
      path.join(fragmentsDir, file),
      path.join(PACKAGES_DIR, name, file),
    );
    console.log(`  Copied ${file} to ${name}/`);
  }
}

function getFragmentDescription(name: string): string {
  const map: Record<string, string> = {
    constitution: "Immutable project rules and coding principles",
    "frontend-philosophy": "Frontend development philosophy and best practices",
    "nextjs-app-router": "Next.js App Router patterns and conventions",
    "qa-testing": "QA testing strategies (test pyramid, AAA pattern, component testing)",
    "react-patterns": "React component patterns and best practices",
    "repo-init": "Repository initialization guidelines and project structure",
    "security-checklist": "Security checklist for frontend applications",
    "seo-metadata": "SEO metadata best practices and implementation patterns",
    "tailwind-patterns": "Tailwind CSS patterns and utility conventions",
    "tdd-workflow": "Test-driven development workflow and methodology",
    "typescript-strict": "TypeScript strict mode conventions and type safety patterns",
    "web3-frontend": "Web3 frontend integration patterns (wallet, contracts, chains)",
  };
  return map[name] || `Knowledge fragment: ${name}`;
}

function getFragmentTags(name: string): string[] {
  const map: Record<string, string[]> = {
    constitution: ["rules", "principles", "immutable"],
    "frontend-philosophy": ["frontend", "philosophy", "best-practices"],
    "nextjs-app-router": ["nextjs", "app-router", "react"],
    "qa-testing": ["testing", "qa", "tdd"],
    "react-patterns": ["react", "patterns", "components"],
    "repo-init": ["git", "initialization", "project-structure"],
    "security-checklist": ["security", "checklist", "frontend"],
    "seo-metadata": ["seo", "metadata", "html"],
    "tailwind-patterns": ["tailwind", "css", "utility"],
    "tdd-workflow": ["tdd", "testing", "workflow"],
    "typescript-strict": ["typescript", "strict", "types"],
    "web3-frontend": ["web3", "wallet", "blockchain"],
  };
  return map[name] || [name];
}

// --- Main ---

function main(): void {
  console.log("Generating registry manifests + copying files from config...");
  console.log(`Config dir: ${CONFIG_DIR}`);
  console.log(`Output dir: ${PACKAGES_DIR}`);

  generatePipelines();
  generateSkills();
  generateHooks();
  generateFragments();

  // Count
  const dirs = listDir(PACKAGES_DIR);
  console.log(`\nDone! Generated ${dirs.length} packages (manifests + files).`);
}

main();
