// Tests for assemble_investigation_ir — the deterministic 17-stage IR
// generator that replaces LLM-driven genSkeleton (continuation 9.6 / D).
//
// Acceptance criteria:
//   1. Output IR has exactly 17 stages with the canonical names + types.
//   2. Output IR passes KernelService.submit (full structural validator).
//   3. Output IR is byte-identical for identical inputs (determinism).
//   4. evidenceGather has EXACTLY 1 output port `evidence` (not 5 split fields).
//   5. recommendedMcps attach to evidenceGather only.
//   6. externalInputs always include taskText + audienceHint.
//   7. All gate routing targets reference declared stages.
//   8. The 7 reject-feedback wires + 5 cross-gate-shared targets are correct.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { assembleInvestigationIR, assemble_investigation_ir } from "./assemble-investigation-ir.js";
import type { AssembleInvestigationIRInput } from "./assemble-investigation-ir.js";
import { KernelService } from "../mcp/kernel.js";
import { initKernelNextSchema } from "../ir/sql.js";
import type { PipelineIR } from "../ir/schema.js";

function baseInput(overrides: Partial<AssembleInvestigationIRInput> = {}): AssembleInvestigationIRInput {
  return {
    investigationType: "diagnostic",
    audience: {
      role: "senior protocol engineer",
      knowsAbout: ["EVM", "LayerZero", "Web3 token standards"],
      doesNotKnow: ["0G internals"],
      caresAbout: ["security", "latency", "cost"],
    },
    axes: ["security", "latency", "cost", "compatibility", "decentralization"],
    subjectDomain: "0g.ai",
    concepts: [
      { name: "OFT primer", tier: "core", deps: [] },
      { name: "LayerZero v2", tier: "support", deps: [] },
    ],
    pipelineName: "Test Investigation",
    pipelineId: "test-investigation",
    pipelineDescription: "Test investigation pipeline.",
    ...overrides,
  };
}

// Build a minimal prompts dict covering every agent stage's promptRef so
// KernelService.submit accepts the IR.
function buildPromptsDict(ir: PipelineIR): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent") {
      prompts[s.config.promptRef] = `# ${s.name}\nplaceholder prompt`;
    }
  }
  return prompts;
}

describe("assemble_investigation_ir / structure", () => {
  it("emits 20 stages with canonical names and types (D1 added 3 cache stages)", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    expect(ir.stages.length).toBe(20);
    const names = ir.stages.map((s) => s.name);
    expect(names).toEqual([
      "topicFraming",
      "framingGate",
      "prereqExtraction",
      "prereqGate",
      "lookupTutorialCache",
      "tutorialAuthoring",
      "writeTutorialCache",
      "mergeTutorials",
      "tutorialReviewGate",
      "hypothesize",
      "evidenceGather",
      "sourceClassify",
      "primarySourceGate",
      "findingsSynthesisGate",
      "findingsAuthoring",
      "humanReviewGate",
      "reportAssembly",
      "reportJudge",
      "reportJudgeGate",
      "pipelineComplete",
    ]);

    // Type counts: 8 agent, 7 gate, 5 script (D1 added 3 script stages).
    const counts = ir.stages.reduce<Record<string, number>>(
      (acc, s) => {
        acc[s.type] = (acc[s.type] ?? 0) + 1;
        return acc;
      },
      {},
    );
    expect(counts.agent).toBe(8);
    expect(counts.gate).toBe(7);
    expect(counts.script).toBe(5);
  });

  it("evidenceGather has EXACTLY 1 output port `evidence` (not 5 split fields)", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const eg = ir.stages.find((s) => s.name === "evidenceGather")!;
    expect(eg.outputs.length).toBe(1);
    expect(eg.outputs[0]!.name).toBe("evidence");
    expect(eg.outputs[0]!.type).toContain("hypothesisId");
    expect(eg.outputs[0]!.type).toContain("verdict");
    expect(eg.outputs[0]!.type).toContain("positiveEvidence");
  });

  it("tutorialAuthoring has EXACTLY 2 outputs (slug + markdown)", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const ta = ir.stages.find((s) => s.name === "tutorialAuthoring")!;
    expect(ta.outputs.map((p) => p.name).sort()).toEqual(["markdown", "slug"]);
  });

  it("findingsAuthoring has EXACTLY 4 outputs (id + markdown + tutorialAnchors + evidenceAnchors)", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const fa = ir.stages.find((s) => s.name === "findingsAuthoring")!;
    expect(fa.outputs.map((p) => p.name).sort()).toEqual([
      "evidenceAnchors",
      "id",
      "markdown",
      "tutorialAnchors",
    ]);
  });

  it("externalInputs include taskText + audienceHint", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    expect(ir.externalInputs!.map((p) => p.name).sort()).toEqual([
      "audienceHint",
      "taskText",
    ]);
  });

  it("session_mode is 'multi'", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    expect(ir.session_mode).toBe("multi");
  });

  it("3 fanout stages declare elementRetries: 1", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const fanoutStages = ["tutorialAuthoring", "evidenceGather", "findingsAuthoring"];
    for (const name of fanoutStages) {
      const s = ir.stages.find((st) => st.name === name)!;
      expect((s as { fanout?: { elementRetries?: number } }).fanout?.elementRetries).toBe(1);
    }
  });

  it("subIrs is empty (single-pipeline investigation)", () => {
    const { subIrs } = assembleInvestigationIR(baseInput());
    expect(subIrs).toEqual([]);
  });
});

describe("assemble_investigation_ir / wiring", () => {
  it("wires all 7 reject-feedback paths correctly", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const rejectWires: Array<{ from: string; to: string }> = ir.wires
      .filter((w) => w.from.source === "stage" && w.from.port === "__gate_feedback__")
      .map((w) => ({
        from: `${(w.from as { stage: string }).stage}.__gate_feedback__`,
        to: `${w.to.stage}.${w.to.port}`,
      }));

    const expected = [
      { from: "framingGate.__gate_feedback__", to: "topicFraming.framingRejectionFeedback" },
      { from: "prereqGate.__gate_feedback__", to: "prereqExtraction.prereqRejectionFeedback" },
      { from: "tutorialReviewGate.__gate_feedback__", to: "tutorialAuthoring.tutorialRejectionFeedback" },
      { from: "primarySourceGate.__gate_feedback__", to: "evidenceGather.primaryRejectionFeedback" },
      { from: "findingsSynthesisGate.__gate_feedback__", to: "hypothesize.findingsRejectionFeedback" },
      { from: "humanReviewGate.__gate_feedback__", to: "hypothesize.humanRejectionFeedback" },
      { from: "reportJudgeGate.__gate_feedback__", to: "evidenceGather.judgeRejectionFeedback" },
      { from: "reportJudgeGate.__gate_feedback__", to: "findingsAuthoring.judgeRejectionFeedback" },
    ];
    for (const e of expected) {
      expect(rejectWires).toContainEqual(e);
    }
  });

  it("every gate routing target references a declared stage", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const stageNames = new Set(ir.stages.map((s) => s.name));
    for (const s of ir.stages) {
      if (s.type !== "gate") continue;
      for (const target of Object.values(s.config.routing.routes)) {
        const targets = Array.isArray(target) ? target : [target];
        for (const t of targets) {
          expect(stageNames.has(t)).toBe(true);
        }
      }
    }
  });

  it("reportJudgeGate has 3-way routing: accept/reject_to_evidenceGather/reject_to_findingsAuthoring", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const g = ir.stages.find((s) => s.name === "reportJudgeGate")!;
    if (g.type !== "gate") throw new Error("expected gate");
    expect(Object.keys(g.config.routing.routes).sort()).toEqual([
      "accept",
      "reject_to_evidenceGather",
      "reject_to_findingsAuthoring",
    ]);
    expect(g.config.routing.routes.accept).toBe("pipelineComplete");
    expect(g.config.routing.routes.reject_to_evidenceGather).toBe("evidenceGather");
    expect(g.config.routing.routes.reject_to_findingsAuthoring).toBe("findingsAuthoring");
  });

  it("no duplicate wires in the output", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const keys = ir.wires.map((w) => JSON.stringify({ from: w.from, to: w.to, guard: w.guard ?? null }));
    const dedup = new Set(keys);
    expect(keys.length).toBe(dedup.size);
  });

  it("every wire's target port exists on the target stage's inputs[]", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const stageByName = new Map(ir.stages.map((s) => [s.name, s] as const));
    for (const w of ir.wires) {
      const target = stageByName.get(w.to.stage);
      expect(target, `target stage '${w.to.stage}' must exist`).toBeDefined();
      const inputNames = target!.inputs.map((p) => p.name);
      // gate's __gate_feedback__ is implicit, never in inputs[]
      // but here we're checking wire targets, which are actual inputs.
      expect(
        inputNames.includes(w.to.port),
        `target port '${w.to.stage}.${w.to.port}' must be declared in inputs[]; declared: [${inputNames.join(", ")}]`,
      ).toBe(true);
    }
  });

  it("every wire's source port exists on the source stage's outputs[] (or externalInputs[])", () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const stageByName = new Map(ir.stages.map((s) => [s.name, s] as const));
    const externalNames = new Set((ir.externalInputs ?? []).map((p) => p.name));
    for (const w of ir.wires) {
      if (w.from.source === "external") {
        expect(externalNames.has(w.from.port)).toBe(true);
        continue;
      }
      const src = stageByName.get(w.from.stage);
      expect(src, `source stage '${w.from.stage}' must exist`).toBeDefined();
      // Gates emit an implicit __gate_feedback__ port.
      if (w.from.port === "__gate_feedback__") {
        expect(src!.type).toBe("gate");
        continue;
      }
      const outNames = src!.outputs.map((p) => p.name);
      expect(
        outNames.includes(w.from.port),
        `source port '${w.from.stage}.${w.from.port}' must be in outputs[]; declared: [${outNames.join(", ")}]`,
      ).toBe(true);
    }
  });
});

describe("assemble_investigation_ir / mcpServers wiring", () => {
  it("attaches recommendedMcps to evidenceGather only", () => {
    const { ir } = assembleInvestigationIR(
      baseInput({
        recommendedMcps: [
          {
            name: "etherscan",
            command: "npx",
            args: ["-y", "@scope/etherscan-mcp"],
            env: { ETHERSCAN_API_KEY: "${ETHERSCAN_API_KEY}" },
            envKeys: ["ETHERSCAN_API_KEY"],
          },
        ],
      }),
    );
    for (const s of ir.stages) {
      if (s.type !== "agent") continue;
      const mcps = (s.config as { mcpServers?: unknown[] }).mcpServers;
      if (s.name === "evidenceGather") {
        expect(mcps).toBeDefined();
        expect(mcps!.length).toBe(1);
      } else {
        expect(mcps, `${s.name} should have no mcpServers`).toBeUndefined();
      }
    }
  });

  it("emits no mcpServers when recommendedMcps is empty", () => {
    const { ir } = assembleInvestigationIR(baseInput({ recommendedMcps: [] }));
    for (const s of ir.stages) {
      if (s.type !== "agent") continue;
      const mcps = (s.config as { mcpServers?: unknown[] }).mcpServers;
      expect(mcps).toBeUndefined();
    }
  });

  it("uses entryId (kebab-case slug) as IR mcpServers[].name even when LLM provided spaces in display name", () => {
    // gen9 dogfood failure: LLM wrote { entryId: "etherscan", name: "Etherscan MCP" }
    // (display name with spaces). The IR's McpServerDecl.name regex rejects it.
    // Assembler must normalize to entryId.
    const { ir } = assembleInvestigationIR(
      baseInput({
        recommendedMcps: [
          {
            // The LLM-shaped entry carries both entryId + name (display).
            // We intentionally type-cast here because IR's McpServerDecl
            // doesn't have entryId — but real LLM output does.
            ...({ entryId: "etherscan" } as Record<string, unknown>),
            name: "Etherscan MCP",
            command: "npx",
            args: ["-y", "@everimbaq/etherscan-mcp"],
            env: {},
            envKeys: ["ETHERSCAN_API_KEY"],
          } as unknown as import("../ir/schema.js").McpServerDecl,
        ],
      }),
    );
    const eg = ir.stages.find((s) => s.name === "evidenceGather")!;
    const mcps = (eg.config as { mcpServers?: Array<{ name: string }> }).mcpServers;
    expect(mcps).toBeDefined();
    expect(mcps![0]!.name).toBe("etherscan"); // NOT "Etherscan MCP"
  });

  it("falls back to name when name is already JS-identifier and entryId missing", () => {
    const { ir } = assembleInvestigationIR(
      baseInput({
        recommendedMcps: [
          {
            name: "fetch", // already kebab-case-compatible
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-fetch"],
            envKeys: [],
          } as unknown as import("../ir/schema.js").McpServerDecl,
        ],
      }),
    );
    const eg = ir.stages.find((s) => s.name === "evidenceGather")!;
    const mcps = (eg.config as { mcpServers?: Array<{ name: string }> }).mcpServers;
    expect(mcps![0]!.name).toBe("fetch");
  });

  it("throws when neither entryId nor JS-identifier-name is present", () => {
    expect(() =>
      assembleInvestigationIR(
        baseInput({
          recommendedMcps: [
            {
              name: "Has Spaces", // not a JS identifier
              command: "npx",
              args: [],
              envKeys: [],
            } as unknown as import("../ir/schema.js").McpServerDecl,
          ],
        }),
      ),
    ).toThrow(/entryId.*JS-identifier/);
  });
});

describe("assemble_investigation_ir / determinism", () => {
  it("produces byte-identical IRs for identical inputs", () => {
    const a = assembleInvestigationIR(baseInput()).ir;
    const b = assembleInvestigationIR(baseInput()).ir;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not depend on concepts ORDER changing structure (concepts go into runtime data, not IR)", () => {
    const a = assembleInvestigationIR(baseInput({
      concepts: [
        { name: "A", tier: "core", deps: [] },
        { name: "B", tier: "core", deps: [] },
      ],
    })).ir;
    const b = assembleInvestigationIR(baseInput({
      concepts: [
        { name: "B", tier: "core", deps: [] },
        { name: "A", tier: "core", deps: [] },
      ],
    })).ir;
    // Stages structure is identical; concepts list isn't reflected in IR.
    expect(JSON.stringify(a.stages)).toBe(JSON.stringify(b.stages));
    expect(JSON.stringify(a.wires)).toBe(JSON.stringify(b.wires));
  });

  it("4 investigationType variants all produce 20-stage IRs (same structure post-D1)", () => {
    const types: AssembleInvestigationIRInput["investigationType"][] = [
      "lookup",
      "diagnostic",
      "selection",
      "landscape",
    ];
    for (const t of types) {
      const { ir } = assembleInvestigationIR(baseInput({ investigationType: t }));
      expect(ir.stages.length).toBe(20);
    }
  });
});

describe("assemble_investigation_ir / KernelService.submit acceptance", () => {
  it("output IR submits cleanly (full structural validation passes)", async () => {
    const { ir } = assembleInvestigationIR(baseInput());
    const prompts = buildPromptsDict(ir);

    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(ir, { prompts });
    if (!res.ok) {
      const summary = res.diagnostics
        .map((d) => `${d.code}: ${d.message ?? ""}`)
        .join("\n  ");
      throw new Error(`submit failed:\n  ${summary}`);
    }
    expect(res.versionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("submits cleanly across all 4 investigationType variants", async () => {
    const types: AssembleInvestigationIRInput["investigationType"][] = [
      "lookup",
      "diagnostic",
      "selection",
      "landscape",
    ];
    for (const t of types) {
      const { ir } = assembleInvestigationIR(baseInput({ investigationType: t }));
      const prompts = buildPromptsDict(ir);
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const res = await svc.submit(ir, { prompts });
      if (!res.ok) {
        const summary = res.diagnostics
          .map((d) => `${d.code}: ${d.message ?? ""}`)
          .join("\n  ");
        throw new Error(`submit failed (${t}):\n  ${summary}`);
      }
    }
  });

  it("submits cleanly with recommendedMcps", async () => {
    const { ir } = assembleInvestigationIR(
      baseInput({
        recommendedMcps: [
          {
            name: "fetch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-fetch"],
            envKeys: [],
          },
        ],
      }),
    );
    const prompts = buildPromptsDict(ir);
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(ir, { prompts });
    if (!res.ok) {
      const summary = res.diagnostics
        .map((d) => `${d.code}: ${d.message ?? ""}`)
        .join("\n  ");
      throw new Error(`submit failed with mcps:\n  ${summary}`);
    }
  });
});

describe("assemble_investigation_ir / module run()", () => {
  it("returns ir + subIrs given a full inputs object", async () => {
    const result = await assemble_investigation_ir.run(
      {
        investigationType: "diagnostic",
        audience: {
          role: "engineer",
          knowsAbout: [],
          doesNotKnow: [],
          caresAbout: [],
        },
        axes: ["security"],
        subjectDomain: "example.com",
        concepts: [],
        pipelineName: "test",
        pipelineId: "test",
        pipelineDescription: "test",
      },
      {
        taskId: "t",
        stageName: "genSkeleton",
        attemptId: "a",
        attemptIdx: 0,
        moduleId: "assemble_investigation_ir",
        env: {},
      },
    );
    expect(result.ir).toBeDefined();
    expect(Array.isArray(result.subIrs)).toBe(true);
    expect((result.subIrs as PipelineIR[]).length).toBe(0);
  });

  it("throws on invalid investigationType", async () => {
    await expect(
      assemble_investigation_ir.run(
        {
          investigationType: "INVALID",
          audience: {},
          axes: [],
          subjectDomain: "",
          concepts: [],
          pipelineName: "x",
          pipelineId: "x",
          pipelineDescription: "x",
        },
        {
          taskId: "t",
          stageName: "s",
          attemptId: "a",
          attemptIdx: 0,
          moduleId: "m",
          env: {},
        },
      ),
    ).rejects.toThrow(/investigationType/);
  });

  it("throws on missing pipelineName", async () => {
    await expect(
      assemble_investigation_ir.run(
        {
          investigationType: "lookup",
          audience: {},
          axes: [],
          subjectDomain: "",
          concepts: [],
          pipelineName: "",
          pipelineId: "x",
          pipelineDescription: "x",
        },
        {
          taskId: "t",
          stageName: "s",
          attemptId: "a",
          attemptIdx: 0,
          moduleId: "m",
          env: {},
        },
      ),
    ).rejects.toThrow(/pipelineName/);
  });
});
