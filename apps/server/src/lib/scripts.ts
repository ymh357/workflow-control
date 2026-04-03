// Script functions replacing AI agents for deterministic stages.
// Registration and PR creation do not require LLM reasoning.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "./artifacts.js";
import { taskLogger } from "./logger.js";
import { type SystemSettings, loadSystemSettings } from "./config-loader.js";

// Use Record<string, any> instead of deleted typed interfaces
type AnalysisResult = Record<string, any>;
type QAResult = Record<string, any>;

const execAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function exec(cmd: string, args: string[], opts: { cwd: string; timeout?: number }): Promise<ExecResult> {
  return execAsync(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 120_000, maxBuffer: 10 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// 1. Registration — direct Notion REST API call
// ---------------------------------------------------------------------------

interface RegistrationInput {
  taskId: string;
  analysis: AnalysisResult;
  branch: string;
  worktreePath?: string;
  notionStatusLabel?: string;
  settings?: SystemSettings;
}

export interface RegistrationOutput {
  notionPageId: string;
}

export async function scriptRegistration(input: RegistrationInput): Promise<RegistrationOutput> {
  const log = taskLogger(input.taskId, "registration");
  const settings = input.settings ?? loadSystemSettings();
  const notionToken = settings.notion?.token;
  const dbId = settings.notion?.sprint_board_id;

  // Write task-registry.json regardless of Notion availability
  const registry = { notionPageId: "", branch: input.branch, repoName: input.analysis.repoName };

  if (!notionToken || !dbId) {
    log.warn("NOTION_TOKEN or SPRINT_BOARD_ID not set, skipping Notion page creation");
    if (input.worktreePath) {
      await writeArtifact(input.worktreePath, "task-registry.json", JSON.stringify(registry, null, 2));
    }
    return { notionPageId: "" };
  }

  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: {
          Name: { title: [{ text: { content: input.analysis.title ?? "Untitled Task" } }] },
          Status: { select: { name: input.notionStatusLabel ?? "执行中" } },
          Branch: { rich_text: [{ text: { content: input.branch } }] },
          "Estimated Days": { number: input.analysis.estimatedDays ?? 1 },
          Risks: { rich_text: [{ text: { content: (input.analysis.risks ?? []).join("; ") } }] },
          "Ticket Source": { url: null },
          // Repo is a select — may fail if option doesn't exist; catch below
          ...(input.analysis.repoName !== "unknown" ? { Repo: { select: { name: input.analysis.repoName } } } : {}),
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      log.error({ status: res.status, err }, "Notion page creation failed");
      // Still continue — registration shouldn't block workflow
    } else {
      const data = await res.json() as { id?: string };
      registry.notionPageId = data.id ?? "";
      log.info({ notionPageId: registry.notionPageId }, "Notion page created");
    }
  } catch (err) {
    log.error({ err }, "Notion API call failed");
  }

  if (input.worktreePath) {
    await writeArtifact(input.worktreePath, "task-registry.json", JSON.stringify(registry, null, 2));
  }

  return { notionPageId: registry.notionPageId };
}

// ---------------------------------------------------------------------------
// 3. PR Creation — git + gh CLI
// ---------------------------------------------------------------------------

function buildPRBody(analysis: AnalysisResult, qaResult: QAResult): string {
  const buildStatus = qaResult.buildPassed ? "PASSED" : "FAILED";
  const testStatus = qaResult.testsPassed ? "PASSED" : (qaResult.warnings?.some((w: string) => w.startsWith("No test script")) ? "SKIPPED" : "FAILED");
  const reviewStatus = qaResult.aiCodeReviewPassed === undefined ? "SKIPPED" : (qaResult.aiCodeReviewPassed ? "PASSED" : "ISSUES FOUND");
  const blockers = qaResult.blockers ?? [];
  const warnings = qaResult.warnings ?? [];

  return `## Task\n${analysis.title ?? "Untitled"}

## Changes
${analysis.description ?? ""}

## QA Results
| Check | Status |
|---|---|
| Build | ${buildStatus} |
| Tests | ${testStatus} |
| AI Code Review | ${reviewStatus} |

${blockers.length > 0 ? `### Blockers\n${blockers.map((b: string) => `- ${b}`).join("\n")}` : ""}
${warnings.length ? `### Warnings\n${warnings.map((w: string) => `- ${w}`).join("\n")}` : ""}`;
}

function buildQAComment(qaResult: QAResult): string {
  const blockers = qaResult.blockers ?? [];
  const warnings = qaResult.warnings ?? [];
  return qaResult.prComment ?? `## QA Report

**Overall**: ${qaResult.passed ? "PASSED" : "FAILED"}
**Build**: ${qaResult.buildPassed ? "PASSED" : "FAILED"}
**Tests**: ${qaResult.testsPassed ? "PASSED" : "FAILED/SKIPPED"}
**AI Code Review**: ${qaResult.aiCodeReviewPassed === undefined ? "SKIPPED" : (qaResult.aiCodeReviewPassed ? "PASSED" : "ISSUES FOUND")}

${blockers.length > 0 ? `### Blockers\n${blockers.map((b: string) => `- ${b}`).join("\n")}` : ""}
${warnings.length ? `### Warnings\n${warnings.map((w: string) => `- ${w}`).join("\n")}` : ""}`;
}

interface PRCreationInput {
  taskId: string;
  worktreePath: string;
  branch: string;
  analysis: AnalysisResult;
  qaResult: QAResult;
  settings?: SystemSettings;
}

export async function scriptPRCreation(input: PRCreationInput): Promise<{ prUrl: string }> {
  const { worktreePath, branch, analysis, qaResult, taskId } = input;
  const settings = input.settings ?? loadSystemSettings();
  const log = taskLogger(taskId, "prCreation");
  const shortId = taskId.slice(0, 8);

  // 1. Stage all changes
  await exec("git", ["add", "-A"], { cwd: worktreePath });

  // 2. Check if there are staged changes
  try {
    await exec("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath });
    log.warn("No staged changes to commit");
    // Still try to push existing commits
  } catch {
    // diff --cached --quiet exits 1 when there ARE changes — this is the success path
    await exec("git", ["commit", "-m", `feat(${shortId}): ${analysis.title}`], { cwd: worktreePath });
    log.info("Changes committed");
  }

  // 3. Push (check remote status first to avoid force-push surprises)
  try {
    await exec("git", ["fetch", "origin", branch], { cwd: worktreePath, timeout: 30_000 });
  } catch { /* branch may not exist remotely yet — that's fine */ }
  await exec("git", ["push", "-u", "origin", branch], { cwd: worktreePath, timeout: 60_000 });
  log.info("Branch pushed");

  // 4. Create PR (use --body-file to avoid shell/arg length issues)
  const prBody = buildPRBody(analysis, qaResult);
  const bodyFile = join(worktreePath, ".pr-body.md");
  writeFileSync(bodyFile, prBody, "utf-8");
  let prUrl: string;
  try {
    const result = await exec("gh", [
      "pr", "create",
      "--title", `feat: ${shortId} ${analysis.title}`,
      "--body-file", bodyFile,
      "--base", "main",
      "--head", branch,
      "--json", "url",
    ], { cwd: worktreePath, timeout: 30_000 });
    try {
      const parsed = JSON.parse(result.stdout);
      prUrl = parsed.url;
    } catch {
      // Fallback to raw stdout if JSON parsing fails
      prUrl = result.stdout.trim();
    }
  } finally {
    try { unlinkSync(bodyFile); } catch {}
  }
  const trimmedPrUrl = prUrl.trim();
  log.info({ prUrl: trimmedPrUrl }, "PR created");

  // 5. Post QA comment
  const prNumber = trimmedPrUrl.split("/").pop();
  if (prNumber) {
    const qaComment = buildQAComment(qaResult);
    const commentFile = join(worktreePath, ".pr-comment.md");
    writeFileSync(commentFile, qaComment, "utf-8");
    try {
      await exec("gh", ["pr", "comment", prNumber, "--body-file", commentFile], { cwd: worktreePath, timeout: 15_000 });
      log.info("QA comment posted");
    } catch (err) {
      log.warn({ err }, "Failed to post QA comment");
    } finally {
      try { unlinkSync(commentFile); } catch {}
    }
  }

  // 6. Write delivery checklist
  await writeArtifact(worktreePath, "delivery-checklist.md", `# Delivery\n\n- PR: ${trimmedPrUrl}\n- Branch: ${branch}\n- Date: ${new Date().toISOString()}\n`);

  return { prUrl: trimmedPrUrl };
}
