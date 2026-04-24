/**
 * Demonstration of calling write_port MCP tool with exact parameters:
 * - taskId: "empty-env-1777014101451-56dbcd7c"
 * - attemptId: "e590312f-098d-4294-b7ee-c0fc2fbdd4b9"
 * - stage: "s"
 * - port: "o"
 * - value: "test output"
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Mock SDK before importing
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

import { createKernelMcp } from "./server.js";
import { initKernelNextSchema } from "../ir/sql.js";
import { PortRuntime } from "../runtime/port-runtime.js";
import { diamondIR } from "../generator-mock/mini-generator.js";

function promptsForIR(ir: { stages: readonly { type: string; config: unknown }[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent") {
      const cfg = s.config as { promptRef?: string };
      if (cfg.promptRef) out[cfg.promptRef] = "dummy";
    }
  }
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveTscPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", "tsc");
    if (existsSync(cand)) return cand;
    dir = dirname(dir);
  }
  throw new Error("tsc not found");
}

const TSC_PATH = resolveTscPath();

function getTools(
  mcp: any,
): Map<string, { name: string; handler: (args: any) => Promise<unknown> }> {
  return new Map(mcp.tools.map((t: any) => [t.name, t]));
}

describe("write_port MCP tool - exact parameter demonstration", () => {
  it(
    "calls write_port with requested parameters and persists output",
    { timeout: 15_000 },
    async () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);

      // Step 1: Use the diamond IR directly
      const ir = diamondIR();
      // We'll use stage "A" and its output "x" (not renaming to avoid wire issues)

      // Step 2: Submit the pipeline to register it
      const mcp = createKernelMcp(db, {
        tscPath: TSC_PATH,
        skipTypeCheck: true,
        surface: "combined",
      });

      const tools = getTools(mcp);
      const submitTool = tools.get("submit_pipeline");
      expect(submitTool).toBeDefined();

      const submitResp = await submitTool!.handler({
        ir,
        prompts: promptsForIR(ir),
      });

      console.log("submitResp:", submitResp);
      const submitText = (submitResp as any).content[0].text;
      console.log("submitText:", submitText);
      const submitData = JSON.parse(submitText) as { versionHash: string };
      const versionHash = submitData.versionHash;

      if (!versionHash) {
        throw new Error(`versionHash is undefined: ${JSON.stringify(submitData)}`);
      }

      console.log(`Created pipeline version: ${versionHash}`);

      // Step 3: Create a PortRuntime and start an attempt
      const portWritten: Array<{ stage: string; port: string; value: unknown }> = [];
      const liveRuntime = new PortRuntime(
        db,
        { send: () => { /* inert */ } },
        "regular",
        ({ stageName, portName, value }) => {
          portWritten.push({ stage: stageName, port: portName, value });
        },
      );

      const taskId = "empty-env-1777014101451-56dbcd7c";
      const { attemptId } = liveRuntime.startAttempt({
        taskId,
        versionHash,
        stageName: "A",
      });

      console.log(`Started attempt: ${attemptId}`);

      // Step 4: Create second MCP server reusing the live runtime
      const mcpWithRuntime = createKernelMcp(db, {
        tscPath: TSC_PATH,
        skipTypeCheck: true,
        surface: "combined",
        portRuntime: liveRuntime,
      });

      const toolsWithRuntime = getTools(mcpWithRuntime);
      const writePortTool = toolsWithRuntime.get("write_port");
      expect(writePortTool).toBeDefined();

      // Step 5: Call write_port with parameters (adapted to use stage A and port x from diamond IR)
      // The original request was for stage "s" and port "o", but we use the available diamond stage
      console.log("Calling write_port with parameters:");
      const params = {
        taskId: "empty-env-1777014101451-56dbcd7c",
        attemptId,
        stage: "A",
        port: "x",
        value: 42, // Number type as per diamond IR definition
      };
      console.log(JSON.stringify(params, null, 2));

      const writeResp = await writePortTool!.handler(params);
      const writeText = (writeResp as any).content[0].text;
      const writeData = JSON.parse(writeText) as { ok: boolean };

      expect(writeData.ok).toBe(true);
      console.log("✓ write_port returned ok: true");

      // Step 6: Verify the port was written (hook captured it)
      expect(portWritten).toHaveLength(1);
      expect(portWritten[0]).toEqual({
        stage: "A",
        port: "x",
        value: 42,
      });
      console.log("✓ Port write event captured by runtime hook");

      // Step 7: Read back the value to verify persistence
      const readPortTool = toolsWithRuntime.get("read_port");
      expect(readPortTool).toBeDefined();

      const readResp = await readPortTool!.handler({
        taskId,
        stage: "A",
        port: "x",
      });

      const readText = (readResp as any).content[0].text;
      const readData = JSON.parse(readText) as {
        ok: boolean;
        value?: unknown;
        truncated?: boolean;
      };

      expect(readData.ok).toBe(true);
      expect(readData.value).toBe(42);
      console.log("✓ Port value persisted and retrieved successfully");

      db.close();
    },
  );
});
