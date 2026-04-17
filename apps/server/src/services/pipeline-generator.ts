import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { validatePipelineConfig } from "../lib/config/schema.js";
import { validatePipelineLogic, getValidationErrors } from "@workflow-control/shared";
import { CONFIG_DIR, loadSystemSettings, loadMcpRegistry } from "../lib/config-loader.js";
import { scriptRegistry } from "../scripts/index.js";
import { buildCapabilitySummary, formatCapabilityPrompt } from "../lib/capability-registry.js";
import { discoverExternalCapabilities, autoInstallSkill, type DiscoveryResult } from "../lib/capability-discovery.js";
import { registryService } from "./registry-service.js";
import { logger } from "../lib/logger.js";
import type { PipelineConfig, WriteDeclaration } from "../lib/config/types.js";
import { flattenStages } from "../lib/config/types.js";
import { autofixPipeline } from "./pipeline-autofix.js";

function wKey(w: WriteDeclaration): string {
  return typeof w === "string" ? w : w.key;
}

export interface GenerateRequest {
  description: string;
  engine?: "claude" | "gemini" | "codex";
}

export interface GeneratedScript {
  scriptId: string;
  manifest: { name: string; version: string; type: "script"; script_id: string; entry: string };
  code: string;
}

export interface GeneratedPromptFile {
  name: string;
  content: string;
}

export interface GenerateResult {
  yaml: string;
  parsed: PipelineConfig;
  scripts: GeneratedScript[];
  promptFiles: GeneratedPromptFile[];
  warnings: string[];
  capabilityDiscovery?: {
    discoveredMcps: Array<{ name: string; packageName: string; description: string }>;
    discoveredSkills: Array<{ name: string; repo: string; description: string }>;
    autoInstalledMcps: string[];
    autoInstalledSkills: string[];
    mcpsNeedingKeys: Array<{ name: string; envVars: string[] }>;
  };
}

export async function generatePipeline(req: GenerateRequest): Promise<GenerateResult> {
  const settings = loadSystemSettings();
  const mcpRegistry = loadMcpRegistry();
  const engine = req.engine ?? settings.agent?.default_engine ?? "claude";

  // Step 0: Discover external capabilities in parallel with skeleton generation
  const installedMcpNames = new Set(mcpRegistry ? Object.keys(mcpRegistry) : []);
  const installedSkillNames = new Set<string>();
  try {
    const skillsDir = join(CONFIG_DIR, "skills");
    for (const f of readdirSync(skillsDir)) {
      if (f.endsWith(".md")) installedSkillNames.add(f.replace(/\.md$/, ""));
    }
  } catch { /* skills dir may not exist */ }

  let discovery: DiscoveryResult | undefined;
  try {
    discovery = await discoverExternalCapabilities(
      req.description, installedMcpNames, installedSkillNames,
      { maxResults: 5, timeoutMs: 30_000 },
    );
    logger.info(
      { mcps: discovery.mcps.length, skills: discovery.skills.length },
      "pipeline-generator: external capability discovery complete",
    );
  } catch (err) {
    logger.warn({ err }, "pipeline-generator: external capability discovery failed");
  }

  // Step 1: Generate skeleton
  const { pipelineYaml, pipelineObj, agentStages, skeletonScripts } =
    await generateSkeleton(req.description, engine, discovery);

  const builtinIds = scriptRegistry.getAllMetadata().map(m => m.id);
  const warnings: string[] = [];

  // Step 2: Generate system prompts in parallel
  const promptResults = await Promise.allSettled(
    agentStages.map((stage: any) => generateStagePrompt(stage, pipelineObj, req.description, engine))
  );
  const promptFiles: GeneratedPromptFile[] = promptResults.map((result, i) => {
    const stage = agentStages[i];
    if (result.status === "fulfilled") return result.value;
    const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
    warnings.push(`Stage '${stage.name}' system prompt generation failed: ${errMsg}. A placeholder was used.`);
    return buildFallbackPrompt(stage, pipelineObj);
  });

  // Step 3: Generate custom script code in parallel
  const customScripts = skeletonScripts.filter((s: any) => !builtinIds.includes(s.scriptId));
  const scriptResults = await Promise.allSettled(
    customScripts.map((s: any) => generateScriptCode(s, pipelineObj, req.description, engine, builtinIds))
  );
  const scripts: GeneratedScript[] = scriptResults.map((result, i) => {
    const skeleton = customScripts[i];
    if (result.status === "fulfilled") return result.value;
    const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
    warnings.push(`Script '${skeleton.scriptId}' code generation failed: ${errMsg}. A stub was used.`);
    return buildFallbackScript(skeleton);
  });

  // Validate custom script coverage
  const generatedScriptIds = new Set([...builtinIds, ...scripts.map(s => s.scriptId)]);
  for (const stage of flattenStages(pipelineObj.stages ?? [])) {
    const scriptId = (stage as any)?.runtime?.script_id;
    if (scriptId && !generatedScriptIds.has(scriptId)) {
      warnings.push(`Stage "${(stage as any).name}" references script_id "${scriptId}" but no script was generated for it.`);
    }
  }

  // Post-generation: auto-install discovered MCPs and skills referenced by the pipeline
  const autoInstalledMcps: string[] = [];
  const autoInstalledSkills: string[] = [];
  const mcpsNeedingKeys: Array<{ name: string; envVars: string[] }> = [];

  if (discovery) {
    const discoveredMcpMap = new Map(discovery.mcps.map((m) => [m.name, m]));
    const discoveredSkillMap = new Map(discovery.skills.map((s) => [s.name, s]));

    // Find MCPs referenced in pipeline stages
    for (const stage of flattenStages(pipelineObj.stages ?? [])) {
      for (const mcp of (stage as any).mcps ?? []) {
        const disc = discoveredMcpMap.get(mcp);
        if (disc) {
          try {
            const result = registryService.installDiscoveredMcp(mcp, {
              description: disc.description,
              command: "npx",
              args: ["-y", disc.packageName],
            });
            if (result.installed) {
              autoInstalledMcps.push(mcp);
              if (result.mcpSetupNeeded) {
                mcpsNeedingKeys.push(result.mcpSetupNeeded);
              }
            }
          } catch (err) {
            logger.warn({ err, mcp }, "pipeline-generator: auto-install MCP failed");
          }
        }
      }
    }

    // Find skills referenced in pipeline
    for (const skillName of (pipelineObj as any).skills ?? []) {
      const disc = discoveredSkillMap.get(skillName);
      if (disc) {
        const ok = await autoInstallSkill(disc);
        if (ok) autoInstalledSkills.push(skillName);
      }
    }
  }

  // MCP warnings (check after auto-install so newly installed MCPs pass)
  const currentMcpRegistry = loadMcpRegistry();
  const mcpNames = currentMcpRegistry ? Object.keys(currentMcpRegistry) : [];
  for (const stage of flattenStages(pipelineObj.stages ?? [])) {
    for (const mcp of (stage as any).mcps ?? []) {
      if (!mcpNames.includes(mcp)) {
        warnings.push(`Stage "${(stage as any).name}" references MCP "${mcp}" which is not in your MCP registry.`);
      }
    }
  }

  const capabilityDiscovery = discovery
    ? {
        discoveredMcps: discovery.mcps.map((m) => ({ name: m.name, packageName: m.packageName, description: m.description })),
        discoveredSkills: discovery.skills.map((s) => ({ name: s.name, repo: s.repo, description: s.description })),
        autoInstalledMcps,
        autoInstalledSkills,
        mcpsNeedingKeys,
      }
    : undefined;

  return { yaml: pipelineYaml, parsed: pipelineObj, scripts, promptFiles, warnings, capabilityDiscovery };
}

async function generateSkeleton(description: string, engine: "claude" | "gemini" | "codex", discovery?: DiscoveryResult): Promise<{
  pipelineYaml: string;
  pipelineObj: PipelineConfig;
  agentStages: any[];
  skeletonScripts: Array<{ scriptId: string; manifest: any }>;
}> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildSkeletonPrompt(description, engine, attempt > 0 ? lastError : null, discovery);
    const raw = await callLLM(prompt, engine);

    try {
      const jsonStr = extractJson(raw);
      const parsed = JSON.parse(jsonStr);

      // Accept both JSON object and YAML string for the pipeline field
      let pipelineObj: any;
      if (typeof parsed.pipeline === "string") {
        pipelineObj = parseYAML(parsed.pipeline);
      } else if (typeof parsed.pipeline === "object" && parsed.pipeline !== null) {
        pipelineObj = parsed.pipeline;
      } else {
        throw new Error("Missing or invalid 'pipeline' field in response (expected object or YAML string)");
      }

      // Replace __GENERATED__ placeholders with stage names
      for (const stage of flattenStages(pipelineObj.stages ?? [])) {
        if (stage.type === "agent" && (stage as any).runtime?.system_prompt === "__GENERATED__") {
          (stage as any).runtime.system_prompt = stage.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        }
      }

      // Auto-fix known mechanical issues before validation
      const autoFixes = autofixPipeline(pipelineObj);
      if (autoFixes.length > 0) {
        logger.info({ fixes: autoFixes }, "pipeline-generator: auto-fixed pipeline issues");
      }

      const validation = validatePipelineConfig(pipelineObj);
      if (!validation.success) {
        const errMsg = validation.errors?.issues?.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? "Validation failed";
        lastError = errMsg;
        logger.warn({ attempt, errors: errMsg }, "pipeline-generator: skeleton validation failed, retrying");
        continue;
      }

      const validatedObj = validation.data!;

      // Logical validation (reads/writes consistency, routing targets, parallel rules)
      const injected = Array.isArray((validatedObj as any).injected_context) ? new Set((validatedObj as any).injected_context as string[]) : undefined;
      const logicIssues = validatePipelineLogic(validatedObj.stages as any, undefined, undefined, injected, (validatedObj as any).store_schema);
      const logicErrors = getValidationErrors(logicIssues);
      if (logicErrors.length > 0) {
        const errMsg = logicErrors.map((e) => `${e.field ? `[${e.field}] ` : ""}${e.message}`).join("; ");
        lastError = `Logical validation failed: ${errMsg}`;
        logger.warn({ attempt, errors: errMsg }, "pipeline-generator: skeleton logical validation failed, retrying");
        continue;
      }

      // Serialize from validated object for consistency
      const cleanYaml = stringifyYAML(validatedObj);
      const agentStages = flattenStages(validatedObj.stages ?? []).filter((s: any) => s.type === "agent");
      const skeletonScripts = (parsed.scripts ?? []).map((s: any) => ({
        scriptId: s.scriptId,
        manifest: s.manifest,
      }));

      return { pipelineYaml: cleanYaml, pipelineObj: validatedObj, agentStages, skeletonScripts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt, error: lastError }, "pipeline-generator: skeleton parse failed");
      if (attempt === 0) continue;
    }
  }

  throw new Error(`Pipeline skeleton generation failed after 2 attempts: ${lastError}`);
}

async function generateStagePrompt(
  stage: any,
  pipelineObj: any,
  userDescription: string,
  engine: "claude" | "gemini" | "codex"
): Promise<GeneratedPromptFile> {
  const stageOverview = flattenStages(pipelineObj.stages ?? [])
    .map((s: any) => `- ${s.name} (${s.type})${s.runtime?.writes ? `: writes [${(s.runtime.writes as WriteDeclaration[]).map(wKey).join(", ")}]` : ""}`)
    .join("\n");

  const readsLines = Object.entries(stage.runtime?.reads ?? {})
    .map(([k, v]) => `  ${k}: (from store path "${v}")`)
    .join("\n") || "  (none)";

  const writesLines = (stage.runtime?.writes ?? [])
    .map((w: WriteDeclaration) => `  ${wKey(w)}`)
    .join("\n") || "  (none)";

  const outputsStr = stage.outputs
    ? JSON.stringify(stage.outputs, null, 2)
    : "  (not specified)";

  const prompt = `You are an expert at writing system prompts for AI agents in workflow pipelines.

## Pipeline Context

Pipeline name: ${pipelineObj.name}
User's goal: ${userDescription}

## All Stages — Naming Reference (use these exact names)
${stageOverview}

IMPORTANT: Use the exact stage names and writes keys shown above. Do not invent alternative names.

## Target Stage: ${stage.name}

This agent stage has:
- reads (data injected into its context):
${readsLines}

- writes (JSON keys it must output):
${writesLines}

- outputs schema (the JSON structure it must return):
${outputsStr}

## Instructions

Write a detailed, production-quality system prompt for the "${stage.name}" agent.
The system prompt MUST:
1. Start with a clear role definition (1-2 sentences)
2. Describe what context the agent will receive and how to use it
3. List explicit step-by-step instructions for the task
4. Specify the exact JSON output structure the agent must return (matching the writes/outputs above)
5. Include anti-hallucination guardrails: "Never make claims about code you have not read. Read files before editing them."
6. Be written in markdown with ## section headers

Output ONLY the system prompt content in markdown. No JSON wrapper, no explanation, no preamble.`;

  const content = await callLLM(prompt, engine);
  // Use kebab-case name to match the system_prompt filename written into the pipeline YAML
  const kebabName = stage.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return { name: kebabName, content: content.trim() };
}

async function generateScriptCode(
  skeleton: { scriptId: string; manifest: any },
  pipelineObj: any,
  userDescription: string,
  engine: "claude" | "gemini" | "codex",
  builtinIds: string[]
): Promise<GeneratedScript> {
  // Find the pipeline stage that references this script
  const stageForScript = flattenStages(pipelineObj.stages ?? []).find(
    (s) => (s.runtime as any)?.script_id === skeleton.scriptId
  ) as any;
  if (!stageForScript) {
    throw new Error(`Script '${skeleton.scriptId}' is declared but not referenced by any stage in the pipeline`);
  }

  const readsLines = Object.entries(stageForScript.runtime?.reads ?? {})
    .map(([k, v]: [string, any]) => `  inputs.${k}  (from store: "${v}")`)
    .join("\n") || "  (none)";

  const writesLines = (stageForScript.runtime?.writes ?? [])
    .map((w: WriteDeclaration) => `  ${wKey(w)}`)
    .join("\n");

  const argsStr = stageForScript.runtime?.args
    ? JSON.stringify(stageForScript.runtime.args, null, 2)
    : "  (none)";

  const writesReturn = (stageForScript.runtime?.writes ?? [] as WriteDeclaration[]).map(wKey).join(", ");

  const prompt = `You are an expert TypeScript developer writing automation scripts for a workflow system.

## Script to Implement

script_id: ${skeleton.scriptId}
name: ${skeleton.manifest.name}
Pipeline goal: ${userDescription}

## Script Contract (from pipeline YAML)

reads (passed as \`inputs\` parameter, mapped from store):
${readsLines}

writes (must be returned as object keys):
${writesLines}

args (static config from pipeline YAML):
${argsStr}

## Handler Signature

export default async function handler({
  taskId,
  context,   // WorkflowContext: { store, worktreePath, branch, taskText, ... }
  settings,  // SystemSettings: { paths: { repos_base, worktrees_base, ... }, agent: { ... } }
  inputs,    // Record<string, unknown> — data from runtime.reads
  args,      // Record<string, unknown> | undefined — data from runtime.args
}: ScriptContext): Promise<Record<string, unknown>>

The return object MUST contain all keys in writes: ${writesReturn}

## Built-in Scripts (do NOT reimplement these, they already exist)
${builtinIds.join(", ")}

## Available APIs
- node:child_process (execSync, spawn)
- node:fs (readFileSync, writeFileSync, existsSync, mkdirSync)
- node:path (join, dirname, basename)
- fetch (for HTTP calls)

## Instructions

Write the complete index.ts for this script. The file must:
1. Have a default export of the handler function
2. Return all required writes keys
3. Handle errors gracefully (try/catch, meaningful error messages)
4. Be clean, minimal TypeScript with no unnecessary abstractions

Output ONLY the TypeScript code. No markdown code fences, no explanation.`;

  const code = await callLLM(prompt, engine);
  return { scriptId: skeleton.scriptId, manifest: skeleton.manifest, code: code.trim() };
}

function buildFallbackPrompt(stage: any, pipelineObj: any): GeneratedPromptFile {
  const writes = (stage.runtime?.writes ?? [] as WriteDeclaration[]).map(wKey);
  const kebabName = stage.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return {
    name: kebabName,
    content: `# ${stage.name}\n\nYou are an AI agent in the "${pipelineObj.name}" pipeline.\n\n## Your Task\n\n${stage.name} stage — implement the required logic.\n\n## Required Output\n\nReturn a JSON object with these fields: ${writes.join(", ")}\n`,
  };
}

function buildFallbackScript(skeleton: { scriptId: string; manifest: any }): GeneratedScript {
  return {
    scriptId: skeleton.scriptId,
    manifest: skeleton.manifest,
    code: `// TODO: Implement ${skeleton.scriptId}\nexport default async function handler({ inputs, args }: any): Promise<Record<string, unknown>> {\n  throw new Error("Script '${skeleton.scriptId}' not yet implemented");\n}\n`,
  };
}

function extractJson(raw: string): string {
  // Try to extract from markdown code block
  const jsonBlockMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();

  // Try to find raw JSON object
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }

  return raw.trim();
}

async function callLLM(prompt: string, engine: "claude" | "gemini" | "codex"): Promise<string> {
  const settings = loadSystemSettings();

  if (engine === "claude") {
    const executable = settings.paths?.claude_executable ?? "claude";
    return spawnAndCollect(executable, ["-p", prompt, "--output-format", "text"]);
  } else if (engine === "codex") {
    const executable = settings.paths?.codex_executable ?? "codex";
    // Codex exec reads prompt from stdin when "-" is passed as positional arg
    return spawnWithStdin(executable, ["exec", "--full-auto", "-o", "/dev/stdout"], prompt);
  } else {
    const executable = settings.paths?.gemini_executable ?? "gemini";
    const model = settings.agent?.gemini_model ?? "gemini-2.5-flash";
    // Pass prompt via stdin to avoid shell arg length limits and improve throughput
    // --allowed-mcp-server-names "" disables loading global MCP servers (faster startup)
    return spawnWithStdin(executable, ["--output-format", "text", "-m", model, "--allowed-mcp-server-names", ""], prompt);
  }
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

function spawnAndCollect(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { proc.kill(); reject(new Error(`Command timed out: ${cmd}`)); }, 300_000);

    proc.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString(); });
    proc.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function spawnWithStdin(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use a neutral cwd so gemini CLI does not inject workspace file context into the prompt
    const cwd = mkdtempSync(tmpdir() + "/pipeline-gen-");
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { proc.kill(); reject(new Error(`Command timed out: ${cmd}`)); }, 300_000);

    proc.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString(); });
    proc.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString(); });
    const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };
    proc.on("close", (code) => {
      clearTimeout(timeout);
      cleanup();
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
    proc.on("error", (err) => { clearTimeout(timeout); cleanup(); reject(err); });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

function formatDiscoverySection(discovery?: DiscoveryResult): string {
  if (!discovery || (discovery.mcps.length === 0 && discovery.skills.length === 0)) return "";

  const parts: string[] = ["## Externally Discovered Capabilities", ""];
  parts.push("The following capabilities were discovered from external registries and can be used in the pipeline.");
  parts.push("Only include them if they would **significantly improve** task execution — not just because they exist.");
  parts.push("");

  if (discovery.mcps.length > 0) {
    parts.push("### Discovered MCP Servers (auto-installable, no API keys needed)");
    parts.push("| Name | Package | Description | Stars |");
    parts.push("|------|---------|-------------|-------|");
    for (const mcp of discovery.mcps) {
      parts.push(`| ${mcp.name} | ${mcp.packageName} | ${mcp.description} | ${mcp.githubStars ?? "-"} |`);
    }
    parts.push("");
  }

  if (discovery.skills.length > 0) {
    parts.push("### Discovered Skills (auto-installable from GitHub)");
    parts.push("| Name | Source | Description | Stars |");
    parts.push("|------|--------|-------------|-------|");
    for (const skill of discovery.skills) {
      parts.push(`| ${skill.name} | ${skill.repo} | ${skill.description} | ${skill.stars ?? "-"} |`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

function normalizeExamplePipeline(yaml: string, asJson = false): string {
  try {
    const obj = parseYAML(yaml);
    for (const stage of flattenStages(obj?.stages ?? [])) {
      if (stage.type === "agent" && (stage as any).runtime?.system_prompt) {
        (stage as any).runtime.system_prompt = "__GENERATED__";
      }
    }
    return asJson ? JSON.stringify(obj, null, 2) : stringifyYAML(obj);
  } catch {
    return yaml;
  }
}

function buildSkeletonPrompt(description: string, engine: "claude" | "gemini" | "codex", retryError: string | null, discovery?: DiscoveryResult): string {
  const capabilitySection = formatCapabilityPrompt(buildCapabilitySummary());

  // Read example pipelines as JSON objects, normalizing system_prompt to __GENERATED__
  const testMixedPath = join(CONFIG_DIR, "pipelines", "test-mixed", "pipeline.yaml");
  const claudeTextPath = join(CONFIG_DIR, "pipelines", "claude-text", "pipeline.yaml");
  const testMixedJson = existsSync(testMixedPath)
    ? normalizeExamplePipeline(readFileSync(testMixedPath, "utf-8"), true) : "";
  const claudeTextJson = existsSync(claudeTextPath)
    ? normalizeExamplePipeline(readFileSync(claudeTextPath, "utf-8"), true) : "";

  const retrySection = retryError
    ? `\n--- PREVIOUS ATTEMPT FAILED ---\nError: ${retryError}\nPlease fix the issues and try again.`
    : "";

  return `You are a pipeline configuration generator for a workflow automation system. Generate a pipeline configuration as a **JSON object** based on the user's description.

## How Workflow Control Executes a Pipeline

When a task is triggered, the pipeline YAML is compiled into an XState state machine.
Each stage becomes a state node. Stages execute sequentially in array order.
The engine keeps a **task-scoped store** (\`context.store\`) — a key-value map, initialized as \`{}\`.

### Parallel Groups

Stages that have no data dependencies on each other can run concurrently inside a \`parallel\` group.
A parallel group is a single entry in the stages array with ONLY a \`parallel\` key (no \`name\` or \`type\` at top level):

\`\`\`json
{
  "parallel": {
    "name": "research",
    "stages": [
      { "name": "techPrep", "type": "agent", "runtime": { "engine": "llm", "system_prompt": "__GENERATED__", "reads": { "analysis": "analysis" }, "writes": ["techContext"] } },
      { "name": "apiReview", "type": "agent", "runtime": { "engine": "llm", "system_prompt": "__GENERATED__", "reads": { "analysis": "analysis" }, "writes": ["apiAudit"] } }
    ]
  }
}
\`\`\`

**Rules for parallel groups:**
- All child stages start at the same time; the group completes when ALL children finish
- Children MUST NOT read data written by sibling stages within the same group — they can only read from stages BEFORE the group
- Children's writes keys MUST NOT overlap
- human_confirm stages are NOT allowed inside parallel groups
- Parallel groups cannot be nested (no parallel inside parallel)
- retry.back_to inside a parallel child can ONLY reference sibling stages within the same group, NOT stages outside the group
- Use parallel groups when 2+ stages share the same upstream data and produce independent outputs

### Data Flow

Each stage can declare what store keys it **reads** (input) and **produces** (output).
Use \`store_schema\` (see below) for production pipelines — it handles writes and outputs automatically.
\`runtime.reads\` maps store paths to local names: for agent stages, values are injected into the prompt as context.

### human_confirm gate: pausing and feedback loops

When execution reaches a gate, the state machine pauses (optionally sends Slack notification).
The gate accepts three human decisions:
1. **Approve** → advance to \`on_approve_to\` or next stage
2. **Reject** → transition to \`on_reject_to\` or error (ends task)
3. **Reject with feedback** → route back to the previous agent stage with feedback injected into its prompt
   This loop repeats up to \`max_feedback_loops\` times (a field on the gate's runtime, not on agent retry)

### Automated QA loops with retry.back_to

For automated QA without human intervention, use \`retry.back_to\`:
- If ANY field in the QA stage's \`writes\` contains \`{ passed: false }\`, the system routes back to \`back_to\`
- The \`blockers\` array in that object is passed as feedback to the implementation stage
- For this to work: the QA stage's outputs MUST declare \`{ key: "passed", type: "boolean" }\` and \`{ key: "blockers", type: "string[]" }\`
- Loop continues until \`passed: true\` or \`retry.max_retries\` is exhausted

### execution_mode

- Omit (default): server-side execution — use for all standard stages
- "edge": the stage runs in the user's local CLI process, not on the server. Use ONLY when the stage needs interactive terminal access or local tool use.
- "any": can run either server-side or edge. Use when the stage works in both modes.

## TypeScript Interface Definitions

\`\`\`typescript
interface PipelineConfig {
  name: string;
  description?: string;
  engine?: "claude" | "gemini" | "mixed";  // "mixed" when stages use different engines
  use_cases?: string[];
  default_execution_mode?: "auto" | "edge";
  store_schema?: Record<string, StoreSchemaEntry>;  // unified data contract for all store keys
  stages: (StageConfig | ParallelGroupConfig)[];  // mix of sequential stages and parallel groups
  hooks?: string[];
  skills?: string[];
  display?: { title_path?: string; completion_summary_path?: string };
}

// Unified data contract — declares all store keys, their producers, and field types
interface StoreSchemaEntry {
  produced_by: string;           // stage name that writes this key
  description?: string;
  fields?: Record<string, {
    type: "string" | "number" | "boolean" | "string[]" | "object" | "object[]" | "markdown";
    description?: string;
    required?: boolean;
  }>;
  additional_properties?: boolean;  // allow extra fields not in schema
  assertions?: string[];           // expr-eval quality assertions on the output value
}

// Wraps multiple stages to run concurrently
interface ParallelGroupConfig {
  parallel: {
    name: string;              // unique group identifier
    stages: StageConfig[];     // at least 2 child stages
  };
}

interface StageConfig {
  name: string;                    // kebab-case or camelCase, unique within pipeline
  type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach";
  engine?: "claude" | "gemini";    // per-stage engine override
  model?: string;                  // e.g. "haiku", "sonnet", specific model ID
  thinking?: { type: "enabled" | "disabled" | "auto" };  // enable extended thinking (agent stages only)
  permission_mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  effort?: "low" | "medium" | "high" | "max";
  max_turns?: number;
  max_budget_usd?: number;
  mcps?: string[];                 // MCP server names from registry
  runtime: AgentRuntime | ScriptRuntime | GateRuntime | Record<string, unknown>;
  outputs?: Record<string, unknown>;  // auto-derived from store_schema; only for legacy pipelines
  on_complete?: { notify?: string };
}

// For type: "agent"
interface AgentRuntime {
  engine: "llm";
  system_prompt: string;           // references a .md file in prompts/system/
  writes?: string[];               // output keys (optional when store_schema is used)
  reads?: Record<string, string>;  // input mapping: localName -> "stageOutputKey" or "stageOutputKey.field"
  disallowed_tools?: string[];     // block specific tools (e.g. ["Edit", "Write", "Bash"] for read-only)
  retry?: { max_retries?: number; back_to?: string };
}

// For type: "script"
interface ScriptRuntime {
  engine: "script";
  script_id: string;               // built-in or custom script ID
  writes?: string[];               // (optional when store_schema is used)
  reads?: Record<string, string>;
  args?: Record<string, unknown>;
  timeout_sec?: number;
  retry?: { max_retries?: number; back_to?: string };
}

// For type: "human_confirm"
interface GateRuntime {
  engine: "human_gate";
  on_approve_to?: string;          // stage name to jump to on approve
  on_reject_to?: string;           // stage name to jump to on reject
  max_feedback_loops?: number;
  notify?: { type: "slack"; template: string };
}

// Advanced stage runtimes (use only when explicitly needed):
// condition: { engine: "condition", branches: [{when?: string, default?: true, to: string}] }
// pipeline:  { engine: "pipeline", pipeline_name: string, reads?: {...}, writes?: string[], timeout_sec?: number }
// foreach:   { engine: "foreach", items: string, item_var: string, pipeline_name: string, max_concurrency?: number, collect_to?: string, item_writes?: string[], on_item_error?: "fail_fast"|"continue" }
\`\`\`

## Stage Quality Settings

**thinking**: Add \`thinking: { type: "enabled" }\` to agent stages that require deep reasoning:
- Analysis stages (analyzing requirements, understanding codebase)
- Architecture/design stages (techPrep, specGeneration, implementationPlan)
- Complex QA stages
Do NOT enable thinking for simple/fast stages (e.g., a stage that just formats output).

**permission_mode**: Controls what tools the agent can use.
- \`"plan"\` — disables ALL tools (Read, Grep, Edit, Bash). Agent only sees reads-injected context. Use when reads provides sufficient data and the stage only needs to reason and output JSON.
- \`"acceptEdits"\` — auto-approves file edits. Use for implementation stages that write code.
- \`"bypassPermissions"\` (default if omitted) — unrestricted access. Use sparingly.
- For read-only stages that need to explore files: keep default mode but add \`runtime.disallowed_tools: ["Edit", "Write", "Bash"]\` instead of plan mode.

**effort + max_turns + max_budget_usd guide**:
- low:    max_turns: 10-15, max_budget_usd: 0.5   — simple transforms, formatting
- medium: max_turns: 20-40, max_budget_usd: 1-3   — analysis, planning, code review
- high:   max_turns: 50-100, max_budget_usd: 4-8  — full implementation, complex debugging
- max:    max_turns: 150+, max_budget_usd: 10+    — only for very large codebases or exhaustive tasks

${capabilitySection}

${formatDiscoverySection(discovery)}
## Example Pipelines (as JSON objects)

### Simple (test-mixed)
\`\`\`json
${testMixedJson}
\`\`\`

### Complex (claude-text)
\`\`\`json
${claudeTextJson}
\`\`\`

## store_schema (RECOMMENDED)

Declare a top-level \`store_schema\` to define all data flowing between stages in one place:
- Each entry declares: store key name, which stage produces it (\`produced_by\`), and its field types
- The engine automatically derives \`runtime.writes\` and stage \`outputs\` from store_schema
- When \`store_schema\` is present: do NOT put \`writes\` in runtime, do NOT put \`outputs\` on stages
- Still declare \`reads\` on each stage (which keys and sub-paths it needs)

Example:
\`\`\`json
{
  "store_schema": {
    "analysis": {
      "produced_by": "analyze",
      "description": "Structured task analysis",
      "fields": {
        "title": { "type": "string", "description": "Short title", "required": true },
        "modules": { "type": "string[]", "description": "Affected modules" },
        "risk": { "type": "string", "description": "Risk assessment" }
      },
      "assertions": ["value.title and len(value.title) > 0"]
    },
    "plan": {
      "produced_by": "planImplementation",
      "description": "Implementation plan",
      "fields": {
        "tasks": { "type": "object[]", "description": "Task breakdown", "required": true },
        "estimatedHours": { "type": "number", "description": "Estimated hours" }
      }
    }
  },
  "stages": [
    { "name": "analyze", "type": "agent", "runtime": { "engine": "llm", "system_prompt": "__GENERATED__", "reads": {} } },
    { "name": "reviewAnalysis", "type": "human_confirm", "runtime": { "engine": "human_gate", "on_reject_to": "analyze" } },
    { "name": "planImplementation", "type": "agent", "runtime": { "engine": "llm", "system_prompt": "__GENERATED__", "reads": { "analysis": "analysis" } } }
  ]
}
\`\`\`

Benefits: single source of truth for data contracts, eliminates writes/outputs mismatch errors, cleaner stage definitions.

## Generation Rules

1. Output MUST be a JSON object with this structure:
\`\`\`json
{
  "pipeline": { ... PipelineConfig object ... },
  "scripts": [
    { "scriptId": "my-script", "manifest": { "name": "My Script", "version": "1.0.0", "type": "script", "script_id": "my-script", "entry": "index.ts" } }
  ]
}
\`\`\`
The "pipeline" field is a **JSON object** (NOT a YAML string). The system will serialize it to YAML automatically.
Do NOT include "promptFiles". Do NOT include "code" in scripts.
For system_prompt fields in agent stages: use the placeholder "__GENERATED__" — the prompt content will be generated separately.

2. The "pipeline" object must conform to PipelineConfig (see TypeScript interfaces above)

3. For every agent stage, set system_prompt to "__GENERATED__" — do NOT write the prompt content here.

4. reads/writes must form a valid data flow: a stage can only read keys written by earlier stages

5. RECOMMENDED: Use store_schema (see above) to declare all data contracts in one place.
   When store_schema is present, do NOT declare runtime.writes or stage outputs — the engine derives both automatically.
   If NOT using store_schema: every stage that produces output MUST declare runtime.writes AND outputs with matching top-level keys.

6. The engine field should match the user's preference: "${engine}"
7. **Mixed engine**: When pipeline engine is "mixed", EVERY agent stage MUST have an explicit \`engine\` field ("claude" or "gemini"). Omitting it causes fallback to system default, defeating mixed mode. Cheap/fast stages → "gemini", quality-critical stages → "claude".
   When specifying \`model\`, use valid identifiers: Claude: "claude-sonnet-4-6" (default), "claude-opus-4-6" (strongest), "claude-haiku-4-5" (fastest). Gemini: "gemini-2.5-pro" (strongest), "gemini-2.5-flash" (default). Only set model when a stage needs something different from engine default.
8. scripts array: include script manifest objects only if custom scripts are needed. If the user's description requires automation that is NOT covered by the built-in scripts listed above, you MUST include a manifest entry in scripts. Do not substitute a built-in script for something different just to avoid generating a custom script.
9. Each entry in scripts: { scriptId: string, manifest: { name, version: "1.0.0", type: "script", script_id, entry: "index.ts" } } — do NOT include "code".
10. CRITICAL: If any pipeline stage references a script_id that is NOT in the built-in list, the scripts array MUST contain an entry with that exact script_id. A pipeline referencing a custom script_id with no corresponding entry is invalid — the script file will not exist and the pipeline will fail at runtime.
11. The built-in script "git_worktree" writes a key whose value is an object: { worktreePath: "/path/..." }. To read the path string in downstream stages, use "worktreePath.worktreePath" (dot notation), not "worktreePath".
12. Keep pipelines practical — don't over-engineer with too many stages
13. Always include at least one human_confirm gate before implementation stages
14. Every pipeline should have display.title_path pointing to a field that contains the task title.
    If the pipeline ends with a script that produces a URL or key result, also set
    display.completion_summary_path to the store key path (e.g. "prUrl.prUrl" if the script writes
    an object { prUrl: "..." } under key "prUrl", or just "prUrl" if the script writes a bare string).
15. For automated QA (retry.back_to): the QA stage must output \`{ passed: boolean, blockers: string[] }\` in its writes. The system routes back_to automatically when \`passed: false\`.
16. **Parallel groups**: Wrap concurrent stages in \`{ "parallel": { "name": "...", "stages": [...] } }\`. No human_confirm inside. No nested parallels. Children cannot read sibling writes.
17. **Advanced stages** (condition, pipeline, foreach): Only use when the user's description clearly requires conditional routing, sub-pipeline reuse, or batch iteration. See TypeScript interfaces above for syntax. Most pipelines only need agent/script/human_confirm.

## User Description

${description}

Generate the pipeline configuration now. Output ONLY the JSON object, no other text.${retrySection}`;
}
