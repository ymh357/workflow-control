import { describe, it, expect } from "vitest";

/**
 * Kernel-next fetch stage test result generator
 *
 * This test demonstrates how to generate a simple test result for the fetch
 * stage of a kernel-next pipeline. The fetch stage is responsible for
 * retrieving source code or data from remote sources.
 */

describe("kernel-next fetch stage test result", () => {
  interface StageAttemptSummary {
    stage: string;
    attempts: number;
    lastStatus?: "success" | "error";
    lastError?: string;
  }

  interface FetchStageTestResult {
    runIdx: number;
    startMs: number;
    durationMs: number;
    finalState: "completed" | "failed";
    drainErrors: Array<{ stage: string | null; message: string }>;
    portValues: {
      sourceCode: string;
      statusCode: number;
      contentType: string;
    };
    stageAttempts: StageAttemptSummary[];
    schemaCompliant: boolean;
    finalValue: string | null;
  }

  it("generates a simple fetch stage test result", () => {
    const fetchStageResult: FetchStageTestResult = {
      runIdx: 1,
      startMs: Date.now(),
      durationMs: 2350,
      finalState: "completed",
      drainErrors: [],
      portValues: {
        sourceCode:
          "export interface PipelineConfig {\n" +
          "  name: string;\n" +
          "  stages: Stage[];\n" +
          "}\n\n" +
          "export interface Stage {\n" +
          "  name: string;\n" +
          "  type: 'agent' | 'fetch';\n" +
          "  config: Record<string, unknown>;\n" +
          "}",
        statusCode: 200,
        contentType: "application/json",
      },
      stageAttempts: [
        {
          stage: "fetch",
          attempts: 1,
          lastStatus: "success",
        },
      ],
      schemaCompliant: true,
      finalValue: "Fetch stage completed successfully - retrieved 387 bytes",
    };

    // Validate structure
    expect(fetchStageResult).toBeDefined();
    expect(fetchStageResult.finalState).toBe("completed");
    expect(fetchStageResult.drainErrors).toHaveLength(0);
    expect(fetchStageResult.schemaCompliant).toBe(true);

    // Validate port outputs
    expect(fetchStageResult.portValues).toBeDefined();
    expect(fetchStageResult.portValues.statusCode).toBe(200);
    expect(fetchStageResult.portValues.sourceCode).toMatch(/PipelineConfig/);
    expect(fetchStageResult.portValues.contentType).toBe("application/json");

    // Validate stage attempts
    expect(fetchStageResult.stageAttempts).toHaveLength(1);
    expect(fetchStageResult.stageAttempts[0].stage).toBe("fetch");
    expect(fetchStageResult.stageAttempts[0].lastStatus).toBe("success");
    expect(fetchStageResult.stageAttempts[0].attempts).toBe(1);

    // Validate timing
    expect(fetchStageResult.durationMs).toBeGreaterThan(0);
    expect(fetchStageResult.startMs).toBeLessThanOrEqual(Date.now());
  });

  it("generates a fetch stage test result with retry", () => {
    const fetchStageWithRetry: FetchStageTestResult = {
      runIdx: 2,
      startMs: Date.now(),
      durationMs: 4500,
      finalState: "completed",
      drainErrors: [],
      portValues: {
        sourceCode: "const data = { version: '1.0.0', type: 'kernel-next' };",
        statusCode: 200,
        contentType: "application/json",
      },
      stageAttempts: [
        {
          stage: "fetch",
          attempts: 2,
          lastStatus: "success",
          lastError: undefined,
        },
      ],
      schemaCompliant: true,
      finalValue: "Fetch stage completed after 1 retry - retrieved 59 bytes",
    };

    expect(fetchStageWithRetry).toBeDefined();
    expect(fetchStageWithRetry.finalState).toBe("completed");
    expect(fetchStageWithRetry.stageAttempts[0].attempts).toBe(2);
    expect(fetchStageWithRetry.durationMs).toBeGreaterThan(2350);
  });

  it("generates a fetch stage test result with error", () => {
    const fetchStageWithError: FetchStageTestResult = {
      runIdx: 3,
      startMs: Date.now(),
      durationMs: 1200,
      finalState: "failed",
      drainErrors: [
        {
          stage: "fetch",
          message: "HTTP 404: Resource not found at https://example.com/source",
        },
      ],
      portValues: {
        sourceCode: "",
        statusCode: 404,
        contentType: "text/plain",
      },
      stageAttempts: [
        {
          stage: "fetch",
          attempts: 1,
          lastStatus: "error",
          lastError: "HTTP 404: Resource not found",
        },
      ],
      schemaCompliant: false,
      finalValue: null,
    };

    expect(fetchStageWithError).toBeDefined();
    expect(fetchStageWithError.finalState).toBe("failed");
    expect(fetchStageWithError.drainErrors).toHaveLength(1);
    expect(fetchStageWithError.portValues.statusCode).toBe(404);
    expect(fetchStageWithError.schemaCompliant).toBe(false);
    expect(fetchStageWithError.finalValue).toBeNull();
  });

  it("validates fetch stage output port schema", () => {
    const result: FetchStageTestResult = {
      runIdx: 1,
      startMs: Date.now(),
      durationMs: 2000,
      finalState: "completed",
      drainErrors: [],
      portValues: {
        sourceCode: "const x = 42;",
        statusCode: 200,
        contentType: "text/javascript",
      },
      stageAttempts: [
        {
          stage: "fetch",
          attempts: 1,
          lastStatus: "success",
        },
      ],
      schemaCompliant: true,
      finalValue: "Success",
    };

    // Verify all required output ports are present
    const requiredPorts = ["sourceCode", "statusCode", "contentType"];
    for (const port of requiredPorts) {
      expect(result.portValues).toHaveProperty(port);
    }

    // Verify output types
    expect(typeof result.portValues.sourceCode).toBe("string");
    expect(typeof result.portValues.statusCode).toBe("number");
    expect(typeof result.portValues.contentType).toBe("string");
  });
});
