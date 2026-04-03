import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { CONFIG_DIR } from "../lib/config-loader.js";
import { validatePipelineConfig } from "../lib/config/schema.js";
import { validatePipelineLogic, getValidationErrors, validatePromptAlignment } from "@workflow-control/shared";
import { taskLogger } from "../lib/logger.js";
import { loadMcpRegistry } from "../lib/config/mcp.js";
import { RegistryService } from "../services/registry-service.js";
import { sseManager } from "../sse/manager.js";
import type { AutomationScript } from "./types.js";

export const persistPipelineScript: AutomationScript = {
  metadata: {
    id: "persist_pipeline",
    name: "Persist Pipeline",
    description: "Validates and writes generated pipeline configuration and prompts to the config/pipelines/ directory.",
    helpMd: `
### Persist Pipeline
Validates and saves a generated pipeline (YAML + prompts) to the config directory.

**Inputs (via \`reads\`):**
- \`yaml\` — The pipeline.yaml content (string)
- \`prompts\` — Object with \`files\` array ({name, content}[]) and optional \`globalConstraints\` (string)
- \`pipelineId\` — Directory name (kebab-case)
- \`pipelineName\` — Human-readable name (for logging)

**Output (via \`writes\`):**
- \`persistResult\` — { pipelineId, savedFiles[], validationPassed }

**Validation:**
The YAML is parsed and validated against the pipeline schema before writing.
If validation fails, an error is thrown and nothing is written.
`,
    requiredSettings: [],
  },
  handler: async ({ taskId, inputs }) => {
    const log = taskLogger(taskId, "persist-pipeline");

    const pipelineInput = inputs?.pipeline ?? inputs?.yaml;
    const prompts = inputs?.prompts as { files?: { name: string; content: string }[]; globalConstraints?: string } | undefined;
    const pipelineId = inputs?.pipelineId as string | undefined;
    const pipelineName = inputs?.pipelineName as string | undefined;

    if (!pipelineInput || !pipelineId) {
      throw new Error("Missing required inputs: pipeline (or yaml) and pipelineId");
    }

    // Accept both JSON object and YAML string
    let parsed: unknown;
    if (typeof pipelineInput === "string") {
      try {
        parsed = parseYAML(pipelineInput);
      } catch (e) {
        throw new Error(`Invalid YAML syntax: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (typeof pipelineInput === "object" && pipelineInput !== null) {
      parsed = pipelineInput;
      log.info("Received pipeline as JSON object — will serialize to YAML");
    } else {
      throw new Error(`Invalid pipeline input type: ${typeof pipelineInput}`);
    }

    const validation = validatePipelineConfig(parsed);
    if (!validation.success) {
      const issues = validation.errors!.issues.map(
        (i) => `${(i as any).path?.join(".") ?? ""}: ${i.message}`,
      );
      throw new Error(`Pipeline schema validation failed:\n${issues.join("\n")}`);
    }

    // Logical validation (reads/writes consistency, routing targets, parallel rules)
    const parsedObj = parsed as { stages?: unknown[] };
    if (parsedObj.stages) {
      const logicIssues = validatePipelineLogic(parsedObj.stages as any);
      const errors = getValidationErrors(logicIssues);
      if (errors.length > 0) {
        const details = errors.map((e) => `${e.field ? `[${e.field}] ` : ""}${e.message}`);
        throw new Error(`Pipeline logical validation failed:\n${details.join("\n")}`);
      }
      // Log warnings but don't block
      const warnings = logicIssues.filter((i) => i.severity === "warning");
      for (const w of warnings) {
        log.warn({ field: w.field }, w.message);
      }
    }

    const promptContentMap = new Map<string, string>();

    // Sanitize pipelineId to prevent path traversal
    const safeId = pipelineId.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!safeId) {
      throw new Error(`Invalid pipelineId: "${pipelineId}"`);
    }

    const pipelinesDir = join(CONFIG_DIR, "pipelines");
    const pipelineDir = join(pipelinesDir, safeId);
    const promptsDir = join(pipelineDir, "prompts");
    const systemDir = join(promptsDir, "system");

    // Check for existing pipeline — do not overwrite
    if (existsSync(join(pipelineDir, "pipeline.yaml"))) {
      throw new Error(`Pipeline "${safeId}" already exists at ${pipelineDir}. Delete it first or use a different ID.`);
    }

    const savedFiles: string[] = [];

    // Create directory structure
    mkdirSync(systemDir, { recursive: true });

    // Write pipeline.yaml — always serialize from validated object for consistency
    const yamlPath = join(pipelineDir, "pipeline.yaml");
    const yamlContent = typeof pipelineInput === "string" ? pipelineInput : stringifyYAML(parsed);
    writeFileSync(yamlPath, yamlContent, "utf-8");
    savedFiles.push("pipeline.yaml");
    log.info({ path: yamlPath }, "Wrote pipeline.yaml");

    // Write prompt files — supports three input formats:
    // 1. refinePrompts output: { outputDir: "/tmp/...", refinedFiles: ["audit", ...] } — read from disk
    // 2. genPrompts dict output: { files: { "audit": "content...", ... }, globalConstraints: "..." }
    // 3. genPrompts array output: { files: [{ name: "audit", content: "..." }], globalConstraints: "..." }
    const promptsInput = prompts as Record<string, unknown> | undefined;
    const refinedOutputDir = promptsInput?.outputDir as string | undefined;

    let wrotePromptsFromDisk = false;
    if (refinedOutputDir && existsSync(refinedOutputDir)) {
      // Format 1: read enhanced prompts from disk (written by refinePrompts agent)
      wrotePromptsFromDisk = true;
      log.info({ outputDir: refinedOutputDir }, "Reading refined prompts from disk");
      const dirEntries = readdirSync(refinedOutputDir).filter((f: string) => f.endsWith(".md"));
      for (const fileName of dirEntries) {
        const content = readFileSync(join(refinedOutputDir, fileName), "utf-8");
        if (fileName === "global-constraints.md") {
          writeFileSync(join(promptsDir, "global-constraints.md"), content, "utf-8");
          savedFiles.push("prompts/global-constraints.md");
          log.info("Wrote refined global-constraints.md");
        } else {
          const safeName = fileName.replace(/\.md$/, "").replace(/[^a-z0-9-]/g, "-");
          writeFileSync(join(systemDir, `${safeName}.md`), content, "utf-8");
          savedFiles.push(`prompts/system/${safeName}.md`);
          promptContentMap.set(safeName, content);
          log.info({ prompt: safeName }, "Wrote refined prompt");
        }
      }
      // Clean up temp directory
      try { rmSync(refinedOutputDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    } else if (promptsInput?.files) {
      // Format 2 & 3: prompt content in store
      const files = promptsInput.files as Record<string, string> | Array<{ name: string; content: string }>;
      let entries: { name: string; content: string }[];
      if (Array.isArray(files)) {
        entries = files;
      } else if (typeof files === "object") {
        entries = Object.entries(files).map(([name, content]) => ({
          name,
          content: typeof content === "string" ? content : JSON.stringify(content),
        }));
        log.info({ format: "dict", count: entries.length }, "Normalized dict-format prompt files to array");
      } else {
        entries = [];
        log.warn({ type: typeof files }, "Unexpected prompts.files type — skipping");
      }

      log.info({ fileCount: entries.length }, "Processing prompt files");
      for (const file of entries) {
        if (!file.name || !file.content) {
          log.warn({ file: JSON.stringify(file).slice(0, 200) }, "Skipping prompt file with missing name or content");
          continue;
        }
        const safeName = file.name.replace(/[^a-z0-9-]/g, "-");
        const filePath = join(systemDir, `${safeName}.md`);
        writeFileSync(filePath, file.content, "utf-8");
        savedFiles.push(`prompts/system/${safeName}.md`);
        promptContentMap.set(safeName, file.content);
        log.info({ path: filePath }, `Wrote prompt: ${safeName}.md`);
      }

    }

    // Write global constraints from store (if not already written from disk in format 1)
    if (!wrotePromptsFromDisk && promptsInput?.globalConstraints) {
      const gc = promptsInput.globalConstraints as string;
      writeFileSync(join(promptsDir, "global-constraints.md"), gc, "utf-8");
      if (!savedFiles.includes("prompts/global-constraints.md")) {
        savedFiles.push("prompts/global-constraints.md");
      }
      log.info("Wrote global-constraints.md");
    }

    // Write sub-pipelines (e.g. foreach sub-pipelines generated alongside the main pipeline)
    const subPipelines = inputs?.subPipelines;
    if (Array.isArray(subPipelines)) {
      for (const sub of subPipelines) {
        if (!sub.name || !sub.stages) {
          log.warn({ sub: JSON.stringify(sub).slice(0, 200) }, "Skipping invalid sub-pipeline entry");
          continue;
        }
        const subId = sub.name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
        if (!subId) continue;

        const subDir = join(pipelinesDir, subId);
        if (existsSync(join(subDir, "pipeline.yaml"))) {
          log.warn({ subId }, "Sub-pipeline already exists, skipping");
          continue;
        }

        const subSystemDir = join(subDir, "prompts", "system");
        mkdirSync(subSystemDir, { recursive: true });
        writeFileSync(join(subDir, "pipeline.yaml"), stringifyYAML(sub), "utf-8");
        savedFiles.push(`${subId}/pipeline.yaml`);
        log.info({ subId }, "Wrote sub-pipeline");

        // Copy prompt files that the sub-pipeline references from the main pipeline's prompts
        if (sub.stages) {
          for (const stage of Array.isArray(sub.stages) ? sub.stages : []) {
            const sp = stage?.runtime?.system_prompt;
            if (sp && typeof sp === "string") {
              const mainPromptPath = join(systemDir, `${sp}.md`);
              const subPromptPath = join(subSystemDir, `${sp}.md`);
              if (existsSync(mainPromptPath) && !existsSync(subPromptPath)) {
                const content = readFileSync(mainPromptPath, "utf-8");
                writeFileSync(subPromptPath, content, "utf-8");
                savedFiles.push(`${subId}/prompts/system/${sp}.md`);
                log.info({ subId, prompt: sp }, "Copied prompt to sub-pipeline");
              }
            }
          }
        }
      }
    }

    // Clean up genPrompts' original temp directory (separate from refinedOutputDir)
    const rawPromptDir = inputs?.rawPromptDir as string | undefined;
    if (rawPromptDir && rawPromptDir !== refinedOutputDir && existsSync(rawPromptDir)) {
      try { rmSync(rawPromptDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      log.info({ rawPromptDir }, "Cleaned up raw prompt temp directory");
    }

    // Prompt alignment validation (warning only — heuristic, does not block persist)
    if (promptContentMap.size > 0 && parsedObj.stages) {
      const alignmentIssues = validatePromptAlignment(parsedObj.stages as any, promptContentMap);
      for (const issue of alignmentIssues) {
        log.warn({ field: issue.field, stageIndex: issue.stageIndex }, issue.message);
      }
    }

    log.info({ pipelineId: safeId, pipelineName, fileCount: savedFiles.length }, "Pipeline persisted successfully");

    // Auto-register missing MCPs referenced by the pipeline
    const mcpSetupNeeded = await autoRegisterMissingMcps(parsedObj, pipelineName ?? safeId, log);

    // Notify dashboard if any MCPs need API key configuration
    if (mcpSetupNeeded.length > 0) {
      const lines = mcpSetupNeeded.map((m) => `  ${m.name}: set ${m.envVars.join(", ")}`);
      sseManager.pushMessage(taskId, {
        type: "agent_text",
        taskId,
        timestamp: new Date().toISOString(),
        data: {
          text: `\n⚠ Auto-registered MCPs that need API keys:\n${lines.join("\n")}\nConfigure them in Settings → MCP Registry or .env.local\n`,
        },
      });
    }

    return {
      persistResult: {
        pipelineId: safeId,
        pipelineName: pipelineName ?? safeId,
        savedFiles,
        validationPassed: true,
        ...(mcpSetupNeeded.length > 0 ? { mcpSetupNeeded } : {}),
      },
    };
  },
};

// Well-known MCP servers — maps short name to official package/config.
// Only these are auto-registered. Unknown MCPs are left for manual setup.
const WELL_KNOWN_MCPS: Record<string, {
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}> = {
  gitlab: {
    description: "GitLab API — repositories, merge requests, issues, pipelines, and CI/CD",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}", GITLAB_API_URL: "${GITLAB_API_URL}" },
  },
  github: {
    description: "GitHub API — repositories, pull requests, issues, and actions",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
  },
  linear: {
    description: "Linear project management — issues, projects, teams, and comments",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
  },
  slack: {
    description: "Slack messaging — channels, messages, users, and reactions",
    command: "npx",
    args: ["-y", "@anthropic-ai/mcp-server-slack"],
    env: { SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}" },
  },
  "google-maps": {
    description: "Google Maps API — geocoding, directions, places, and distance matrix",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    env: { GOOGLE_MAPS_API_KEY: "${GOOGLE_MAPS_API_KEY}" },
  },
  puppeteer: {
    description: "Browser automation via Puppeteer — navigate, screenshot, and interact with web pages",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  filesystem: {
    description: "Local filesystem access — read, write, and search files",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
  },
};

/**
 * Scan pipeline stages for MCP references not in registry.yaml,
 * and auto-register well-known MCPs. Unknown MCPs are reported as
 * needing manual setup — we do NOT blindly install third-party packages
 * from search results.
 */
async function autoRegisterMissingMcps(
  parsedObj: Record<string, unknown>,
  pipelineName: string,
  log: ReturnType<typeof taskLogger>,
): Promise<Array<{ name: string; envVars: string[] }>> {
  const stages = parsedObj.stages as Array<Record<string, unknown>> | undefined;
  if (!stages) return [];

  // Collect all MCP names referenced in the pipeline
  const referencedMcps = new Set<string>();
  for (const entry of stages) {
    const mcps = entry.mcps as string[] | undefined;
    if (mcps) for (const m of mcps) referencedMcps.add(m);
    const parallel = entry.parallel as { stages?: Array<Record<string, unknown>> } | undefined;
    if (parallel?.stages) {
      for (const child of parallel.stages) {
        const childMcps = child.mcps as string[] | undefined;
        if (childMcps) for (const m of childMcps) referencedMcps.add(m);
      }
    }
  }

  if (referencedMcps.size === 0) return [];

  const registry = loadMcpRegistry() ?? {};
  const missing = [...referencedMcps].filter((name) => !registry[name]);
  if (missing.length === 0) return [];

  log.info({ missing }, "Pipeline references unregistered MCPs — checking well-known list");

  const mcpSetupNeeded: Array<{ name: string; envVars: string[] }> = [];
  const registryService = new RegistryService();
  const manualSetup: string[] = [];

  for (const name of missing) {
    const known = WELL_KNOWN_MCPS[name];
    if (!known) {
      manualSetup.push(name);
      continue;
    }

    try {
      const installResult = registryService.installDiscoveredMcp(name, {
        description: known.description,
        command: known.command,
        args: known.args,
        ...(known.env ? { env: known.env } : {}),
      });

      if (installResult.installed) {
        log.info({ mcp: name }, "Auto-registered well-known MCP");
        if (installResult.mcpSetupNeeded) {
          mcpSetupNeeded.push(installResult.mcpSetupNeeded);
        }
        // If the well-known entry has env vars, always report them as needing setup
        if (known.env && !installResult.mcpSetupNeeded) {
          const envVars = Object.keys(known.env).filter((k) => known.env![k].includes("${"));
          if (envVars.length > 0) {
            mcpSetupNeeded.push({ name, envVars });
          }
        }
      }
    } catch (err) {
      log.warn({ err, mcp: name }, "Failed to register well-known MCP");
      manualSetup.push(name);
    }
  }

  if (manualSetup.length > 0) {
    log.warn({ mcps: manualSetup }, "Unknown MCPs need manual setup — not in well-known list");
    for (const name of manualSetup) {
      mcpSetupNeeded.push({ name, envVars: ["(manual setup required — search npmjs.com or modelcontextprotocol.io)"] });
    }
  }

  return mcpSetupNeeded;
}
