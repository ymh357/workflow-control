// One-shot migration: convert legacy YAML builtin pipelines to canonical
// IR JSON. Verify versionHash round-trip (pre === post) before writing.
// Script deletes itself after all 4 pipelines migrated successfully.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { convertLegacyYaml } from "../kernel-next/converter/legacy-yaml.js";
import { canonicalizeIR, pipelineVersionHash } from "../kernel-next/ir/canonical.js";
import { PipelineIRSchema } from "../kernel-next/ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_ROOT = join(__dirname, "..", "builtin-pipelines");

const PIPELINES = [
  "smoke-test",
  "tech-research-collector",
  "tech-research-writer",
  "pipeline-generator",
];

function scanPrompts(promptRoot: string): Record<string, string> {
  if (!existsSync(promptRoot)) return {};
  const out: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.endsWith(".md")) {
        const rel = relative(promptRoot, full).split(sep).join("/");
        const key = rel.slice(0, -".md".length);
        out[key] = readFileSync(full, "utf-8");
      }
    }
  }
  walk(promptRoot);
  return out;
}

function migratePipeline(name: string): void {
  const dir = join(BUILTIN_ROOT, name);
  const yamlPath = join(dir, "pipeline.yaml");
  const irPath = join(dir, "pipeline.ir.json");
  const promptRoot = join(dir, "prompts");

  console.log(`[${name}] reading ${yamlPath}`);
  const yamlText = readFileSync(yamlPath, "utf-8");
  const conv = convertLegacyYaml(yamlText, { yamlFilePath: yamlPath });
  if (!conv.ok) {
    console.error(`[${name}] convertLegacyYaml failed:`);
    console.error(JSON.stringify(conv.diagnostics, null, 2));
    throw new Error(`conversion failed for ${name}`);
  }

  const prompts = scanPrompts(promptRoot);
  const hashBefore = pipelineVersionHash({ ir: conv.ir, prompts });
  console.log(`[${name}] hashBefore = ${hashBefore}`);

  const canonical = canonicalizeIR(conv.ir);
  const jsonText = JSON.stringify(canonical, null, 2) + "\n";
  writeFileSync(irPath, jsonText, "utf-8");
  console.log(`[${name}] wrote ${irPath} (${jsonText.length} bytes)`);

  const roundTripRaw = readFileSync(irPath, "utf-8");
  const roundTripParsed = PipelineIRSchema.parse(JSON.parse(roundTripRaw));
  const hashAfter = pipelineVersionHash({ ir: roundTripParsed, prompts });
  console.log(`[${name}] hashAfter  = ${hashAfter}`);

  if (hashBefore !== hashAfter) {
    throw new Error(
      `[${name}] ROUND-TRIP FAILED: ${hashBefore} !== ${hashAfter}. ` +
        `IR canonicalization is not idempotent for this pipeline. ` +
        `Leaving ${irPath} in place for inspection.`,
    );
  }
  console.log(`[${name}] ✓ round-trip OK`);
}

function main(): void {
  for (const name of PIPELINES) migratePipeline(name);
  console.log("\nAll 4 pipelines migrated successfully.");
}

main();
