// assemble_investigation_ir — deterministic 17-stage investigation pipeline
// IR generator. Continuation 9.6 (2026-04-29).
//
// The path D solution (per continuation 9.5 architectural transition):
// rather than asking the LLM to write a 17-stage IR (which produced 8
// consecutive failures with different mechanical errors each time —
// wire dedup, port name typos, fanout output shape, externalInputs,
// missing input ports, type mismatches, ...), we accept that the IR
// structure of an investigation pipeline is 90%+ deterministic. The
// LLM produces the *content* (audience model, axes, concepts list,
// hypotheses), this script assembles the *structure* (stages, wires,
// fanout, types).
//
// Inputs (from analyzing stage's content output ports):
//   investigationType: "lookup" | "diagnostic" | "selection" | "landscape"
//   audience: { role; knowsAbout; doesNotKnow; caresAbout }
//   axes: string[]
//   subjectDomain: string
//   concepts: Array<{ name, tier, deps }>      -- for tutorialOutline
//   pipelineName: string                       -- e.g. "Web3 Tech Research"
//   pipelineId: string                         -- kebab-case slug
//   pipelineDescription: string
//   recommendedMcps: Array<McpServerEntry>     -- attached only to evidenceGather
//
// Output:
//   ir: PipelineIR (deterministic, byte-identical for same inputs)
//   subIrs: PipelineIR[] = []
//
// The IR submitted by this script will pass KernelService.submit by
// construction — the structural shape is hard-coded and validated once
// by the unit tests + by the standing structural validator.

import type { ScriptModule } from "../runtime/script-module-resolver.js";
import type {
  PipelineIR,
  PortIR,
  WireIR,
  AgentStage,
  ScriptStage,
  GateStage,
  StageIR,
  McpServerDecl,
} from "../ir/schema.js";

// ---------- Input contract ----------

export interface AssembleInvestigationIRInput {
  investigationType: "lookup" | "diagnostic" | "selection" | "landscape";
  audience: {
    role: string;
    knowsAbout: string[];
    doesNotKnow: string[];
    caresAbout: string[];
  };
  axes: string[];
  subjectDomain: string;
  concepts: Array<{
    name: string;
    tier: "core" | "support" | "optional";
    deps: string[];
  }>;
  pipelineName: string;
  pipelineId: string;
  pipelineDescription: string;
  recommendedMcps?: McpServerDecl[];
}

export interface AssembleInvestigationIROutput {
  ir: PipelineIR;
  subIrs: PipelineIR[];
}

// ---------- Frequently-used type literals (TS source as strings) ----------

const T_INVESTIGATION_TYPE =
  '"lookup" | "diagnostic" | "selection" | "landscape"';
const T_AUDIENCE =
  "{ role: string; knowsAbout: string[]; doesNotKnow: string[]; caresAbout: string[] }";
const T_CONCEPTS =
  'Array<{ name: string; tier: "core" | "support" | "optional"; deps: string[] }>';
const T_HYPOTHESIS =
  "{ id: string; axis: string; claim: string; expectedEvidence: string[]; conceptsUsed: string[] }";
const T_HYPOTHESES = `Array<${T_HYPOTHESIS}>`;
const T_EVIDENCE_ITEM =
  "{ kind: string; url: string; quote: string }";
const T_EVIDENCE =
  `{ hypothesisId: string; verdict: "supported" | "refuted" | "inconclusive"; positiveEvidence: Array<${T_EVIDENCE_ITEM}>; negativeEvidence: Array<${T_EVIDENCE_ITEM}>; rawArtifacts: string[] }`;
const T_EVIDENCE_ARRAY = `Array<${T_EVIDENCE}>`;
const T_CLASSIFIED_EVIDENCE_ITEM =
  '{ kind: string; url: string; quote: string; type: "primary" | "official_secondary" | "third_party" | "aggregator" | "unknown"; signal: string; confidence: number }';
const T_CLASSIFIED_EVIDENCE_ITEM_NEG =
  "{ kind: string; url: string; quote: string; type: string; signal: string; confidence: number }";
const T_CLASSIFIED_EVIDENCE = `Array<{ hypothesisId: string; verdict: string; positiveEvidence: Array<${T_CLASSIFIED_EVIDENCE_ITEM}>; negativeEvidence: Array<${T_CLASSIFIED_EVIDENCE_ITEM_NEG}>; primaryCount: number; officialCount: number; thirdPartyCount: number; aggregatorCount: number; unknownCount: number }>`;
const T_REPORT_AUDIT =
  "{ sectionToTutorial: Record<string, string[]>; sectionToFindings: Record<string, string[]> }";
const T_AXIS_SCORES =
  "{ explicit_requirements: number; implicit_requirements: number; synthesis: number; references: number; communication: number; instruction_following: number }";
const T_AXIS_FEEDBACK =
  "{ explicit_requirements: string; implicit_requirements: string; synthesis: string; references: string; communication: string; instruction_following: string }";
const T_RECOMMENDED_ACTION =
  '"accept" | "reject_to_evidenceGather" | "reject_to_findingsAuthoring"';

// ---------- Helpers ----------

function port(
  name: string,
  type: string,
  description?: string,
): PortIR {
  return description ? { name, type, description } : { name, type };
}

function wire(
  fromStage: string | { external: string },
  fromPort: string,
  toStage: string,
  toPort: string,
): WireIR {
  if (typeof fromStage === "object") {
    return {
      from: { source: "external", port: fromStage.external },
      to: { stage: toStage, port: toPort },
    };
  }
  return {
    from: { source: "stage", stage: fromStage, port: fromPort },
    to: { stage: toStage, port: toPort },
  };
}

// ---------- 17-stage skeleton template ----------

function buildStages(input: AssembleInvestigationIRInput): StageIR[] {
  // Normalize recommendedMcps shape: analyzing's recommendedMcps port carries
  // catalog entries shaped `{ entryId, name (display), command, args, env?, envKeys, reason }`
  // — `name` is a HUMAN-READABLE string that may contain spaces. The IR's
  // McpServerDecl requires a JS-identifier `name` (kebab-case ok). We use
  // `entryId` (which is always a kebab-case slug) as the IR-level `name`.
  // This is the same convention gen-skeleton.md prescribed for the legacy
  // LLM-driven IR, baked into the deterministic assembler so it can never
  // be wrong again.
  const evidenceGatherMcps =
    input.recommendedMcps && input.recommendedMcps.length > 0
      ? input.recommendedMcps.map((m) => {
          const raw = m as unknown as Record<string, unknown>;
          const entryId = typeof raw.entryId === "string" ? raw.entryId : undefined;
          const name = typeof raw.name === "string" ? raw.name : undefined;
          // Prefer entryId (kebab-case slug). Fall back to name if entryId
          // is missing AND name happens to be a valid identifier already.
          const irName = entryId
            ?? (name && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name) ? name : undefined);
          if (!irName) {
            throw new Error(
              `assemble_investigation_ir: recommendedMcps entry must carry an 'entryId' (kebab-case slug) ` +
                `OR a JS-identifier-compatible 'name'. Got entryId=${JSON.stringify(entryId)}, name=${JSON.stringify(name)}.`,
            );
          }
          return {
            name: irName,
            command: typeof raw.command === "string" ? raw.command : "",
            args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
            env: typeof raw.env === "object" && raw.env !== null && !Array.isArray(raw.env)
              ? (raw.env as Record<string, string>)
              : undefined,
            envKeys: Array.isArray(raw.envKeys) ? (raw.envKeys as string[]) : [],
          } as McpServerDecl;
        })
      : undefined;

  // Layer 0: Framing
  const topicFraming: AgentStage = {
    name: "topicFraming",
    type: "agent",
    inputs: [
      port("taskText", "string", "User-supplied investigation task description (verbatim)."),
      port("audienceHint", "string", "Optional caller-supplied audience hint; empty string disables refinement."),
      port("framingRejectionFeedback", "string", "Reject-rerun correction from framingGate; empty on first pass."),
    ],
    outputs: [
      port("investigationType", T_INVESTIGATION_TYPE, "lookup / diagnostic / selection / landscape."),
      port("audience", T_AUDIENCE, "Audience model: role, what they know/don't know/care about."),
      port("axes", "string[]", "3-7 investigation dimensions for this topic."),
      port("subjectDomain", "string", "Registrable domain of the primary subject (e.g. '0g.ai'); empty when no single subject."),
      port("framingRationale", "string", "Why these axes/audience fit the task."),
    ],
    config: { promptRef: "topicFraming" },
  };

  const framingGate: GateStage = {
    name: "framingGate",
    type: "gate",
    inputs: [
      port("investigationType", T_INVESTIGATION_TYPE),
      port("audience", T_AUDIENCE),
      port("axes", "string[]"),
    ],
    outputs: [],
    config: {
      question: {
        text:
          "Does the framing (audience model, investigationType, axes) appropriately scope the investigation? Approve if yes; reject with feedback if the audience or axes need refinement.",
        options: [
          { value: "approve", description: "Framing is correct; proceed to prerequisites extraction." },
          { value: "reject", description: "Framing needs refinement; reject with feedback." },
        ],
      },
      routing: {
        routes: { approve: "prereqExtraction", reject: "topicFraming" },
      },
    },
  };

  // Layer 1: Foundations
  const prereqExtraction: AgentStage = {
    name: "prereqExtraction",
    type: "agent",
    inputs: [
      port("investigationType", T_INVESTIGATION_TYPE),
      port("audience", T_AUDIENCE),
      port("axes", "string[]"),
      port("prereqRejectionFeedback", "string", "Reject-rerun correction from prereqGate; empty on first pass."),
    ],
    outputs: [
      port("concepts", T_CONCEPTS, "Concept list with tier and dependencies."),
      port("tutorialOutline", "string[]", "Topologically-sorted concept names; core first."),
    ],
    config: { promptRef: "prereqExtraction" },
  };

  const prereqGate: GateStage = {
    name: "prereqGate",
    type: "gate",
    inputs: [
      port("concepts", T_CONCEPTS),
      port("tutorialOutline", "string[]"),
    ],
    outputs: [],
    config: {
      question: {
        text:
          "Is the prereq concept list sufficient to ground all investigation axes? Are there any cycles in the concept dependencies? Approve if outline is complete; reject if gaps remain.",
        options: [
          { value: "approve", description: "Concept outline is adequate." },
          { value: "reject", description: "Concept outline missing prerequisites; reject with feedback." },
        ],
      },
      routing: {
        routes: { approve: "tutorialAuthoring", reject: "prereqExtraction" },
      },
    },
  };

  // D1 (c12, 2026-04-30) — cross-task tutorial cache. Three stages
  // sandwich tutorialAuthoring: lookup feeds the fanout only the
  // missing slugs, write upserts the freshly-authored set, merge
  // concatenates cached + fresh into the bundle that downstream
  // consumers see. Spec:
  // docs/superpowers/specs/2026-04-30-tutorial-cache-design.md.
  const lookupTutorialCache: ScriptStage = {
    name: "lookupTutorialCache",
    type: "script",
    inputs: [
      port("slugs", "string[]", "Full tutorial-outline slug set from prereqExtraction."),
      port("subjectDomain", "string"),
    ],
    outputs: [
      port("cachedSlugs", "string[]", "Slugs already fresh in cache (≤30d old)."),
      port("cachedContents", "string[]", "Cached markdown, parallel to cachedSlugs."),
      port("missingSlugs", "string[]", "Slugs the tutorialAuthoring fanout still needs to author."),
    ],
    config: { source: "registry", moduleId: "lookup_tutorial_cache" },
  };

  const tutorialAuthoring: AgentStage = {
    name: "tutorialAuthoring",
    type: "agent",
    inputs: [
      port("concept", "string", "Single concept name (fanout element from lookupTutorialCache.missingSlugs)."),
      port("audience", T_AUDIENCE),
      port("axes", "string[]"),
      port("tutorialRejectionFeedback", "string", "Reject-rerun correction from tutorialReviewGate; empty on first pass."),
    ],
    outputs: [
      port("slug", "string", "Kebab-case identifier derived from concept name."),
      port("markdown", "string", "What/Why/How for THIS concept, calibrated to audience."),
    ],
    config: { promptRef: "tutorialAuthoring" },
    fanout: { input: "concept", elementRetries: 1 },
  };

  const writeTutorialCache: ScriptStage = {
    name: "writeTutorialCache",
    type: "script",
    inputs: [
      port("slugs", "string[]", "Slugs the fanout actually authored this run (aggregate)."),
      port("contents", "string[]", "Authored markdown, parallel to slugs."),
      port("subjectDomain", "string"),
    ],
    outputs: [
      port("written", "number", "Count of upserted rows; informational."),
    ],
    config: { source: "registry", moduleId: "write_tutorial_cache" },
  };

  const mergeTutorials: ScriptStage = {
    name: "mergeTutorials",
    type: "script",
    inputs: [
      port("cachedSlugs", "string[]"),
      port("cachedContents", "string[]"),
      port("freshSlugs", "string[]", "tutorialAuthoring.slug aggregate (only the freshly-authored slugs)."),
      port("freshContents", "string[]", "tutorialAuthoring.markdown aggregate."),
    ],
    outputs: [
      port("slugs", "string[]", "Merged slug array (cached then fresh)."),
      port("contents", "string[]", "Merged markdown array, parallel to slugs."),
    ],
    config: { source: "registry", moduleId: "merge_tutorials" },
  };

  const tutorialReviewGate: GateStage = {
    name: "tutorialReviewGate",
    type: "gate",
    inputs: [
      port("tutorialSlugs", "string[]"),
      port("tutorialMarkdowns", "string[]"),
    ],
    outputs: [],
    config: {
      question: {
        text:
          "If you handed this tutorial bundle to the audience described, could they read findings that depend on these concepts and understand them WITHOUT looking elsewhere? Approve if yes; reject naming the concepts that need rewriting.",
        options: [
          { value: "approve", description: "Tutorial bundle is audience-ready." },
          { value: "reject", description: "One or more tutorials too shallow / off-audience; reject with the failing concept slugs in the feedback." },
        ],
      },
      routing: {
        routes: { approve: "hypothesize", reject: "tutorialAuthoring" },
      },
    },
  };

  // Layer 2: Investigation
  const hypothesize: AgentStage = {
    name: "hypothesize",
    type: "agent",
    inputs: [
      port("investigationType", T_INVESTIGATION_TYPE),
      port("audience", T_AUDIENCE),
      port("axes", "string[]"),
      port("tutorialSlugs", "string[]"),
      port("tutorialMarkdowns", "string[]"),
      port("findingsRejectionFeedback", "string", "Reject-rerun correction from findingsSynthesisGate; empty on first pass."),
      port("humanRejectionFeedback", "string", "Reject-rerun correction from humanReviewGate; empty on first pass."),
    ],
    outputs: [
      port("hypotheses", T_HYPOTHESES, "Falsifiable claims with axis + expectedEvidence + conceptsUsed."),
      port("round", "number", "Loop iteration; 1 on first pass."),
    ],
    config: { promptRef: "hypothesize" },
  };

  const evidenceGatherInputs: PortIR[] = [
    port("hypothesis", T_HYPOTHESIS, "Single hypothesis (fanout element)."),
    port("tutorialSlugs", "string[]"),
    port("tutorialMarkdowns", "string[]"),
    port("subjectDomain", "string"),
    port("primaryRejectionFeedback", "string", "Reject-rerun correction from primarySourceGate; empty on first pass."),
    port("judgeRejectionFeedback", "string", "Reject-rerun correction from reportJudgeGate; empty on first pass."),
  ];
  const evidenceGather: AgentStage = {
    name: "evidenceGather",
    type: "agent",
    inputs: evidenceGatherInputs,
    outputs: [
      // Single OBJECT port — explicitly NOT split into 5 fields. This is
      // the source of repeated dogfood failure #4(a) when the LLM was
      // doing this by hand. The downstream consumers (sourceClassify,
      // findingsSynthesisGate, findingsAuthoring) all want
      // Array<{...}> — kernel auto-aggregates N elements into the array.
      port("evidence", T_EVIDENCE, "Per-hypothesis evidence record (single object port)."),
    ],
    config: evidenceGatherMcps
      ? { promptRef: "evidenceGather", mcpServers: evidenceGatherMcps }
      : { promptRef: "evidenceGather" },
    fanout: { input: "hypothesis", elementRetries: 1 },
  };

  const sourceClassify: ScriptStage = {
    name: "sourceClassify",
    type: "script",
    inputs: [
      port("evidence", T_EVIDENCE_ARRAY, "Aggregate evidence from evidenceGather (one entry per hypothesis)."),
      port("subjectDomain", "string"),
    ],
    outputs: [
      port("classifiedEvidence", T_CLASSIFIED_EVIDENCE, "Same evidence array shape with citations tagged + per-hypothesis counts."),
    ],
    config: { source: "registry", moduleId: "classify_evidence_bundle" },
  };

  const primarySourceGate: GateStage = {
    name: "primarySourceGate",
    type: "gate",
    inputs: [
      port("investigationType", T_INVESTIGATION_TYPE),
      port("classifiedEvidence", T_CLASSIFIED_EVIDENCE),
    ],
    outputs: [],
    config: {
      question: {
        text:
          "For each hypothesis with verdict='supported', does the evidence include at least one primary source (type='primary')? For diagnostic and selection investigationType, EVERY supported hypothesis MUST have ≥1 primary source. For landscape and lookup, primary sources are recommended but not strictly required. On reject, list hypothesis ids and the source class missing for each.",
        options: [
          { value: "approve", description: "Every supported hypothesis meets the primary-source threshold for this investigationType." },
          { value: "reject", description: "One or more supported hypotheses lack primary sources; rerun evidenceGather targeting the missing source classes (source_repo / onchain_explorer / paper / spec)." },
        ],
      },
      routing: {
        routes: { approve: "findingsSynthesisGate", reject: "evidenceGather" },
      },
    },
  };

  const findingsSynthesisGate: GateStage = {
    name: "findingsSynthesisGate",
    type: "gate",
    inputs: [
      port("classifiedEvidence", T_CLASSIFIED_EVIDENCE),
    ],
    outputs: [],
    config: {
      question: {
        text:
          "Do the gathered hypotheses (with their verdicts and classified evidence) constitute enough material for a useful report? Are framing axes covered? For diagnostic, is there ≥1 comparative baseline? Are supported hypotheses backed by first-hand evidence rather than aggregator summaries?",
        options: [
          { value: "approve", description: "Synthesis material is sufficient; proceed to findings authoring." },
          { value: "reject", description: "Synthesis weak (axes not covered, no comparative baselines, or evidence too aggregator-dominated); regenerate hypotheses." },
        ],
      },
      routing: {
        routes: { approve: "findingsAuthoring", reject: "hypothesize" },
      },
    },
  };

  const findingsAuthoring: AgentStage = {
    name: "findingsAuthoring",
    type: "agent",
    inputs: [
      port("evidence", T_EVIDENCE, "Single evidence record (fanout element from evidenceGather aggregate)."),
      port("tutorialSlugs", "string[]"),
      port("tutorialMarkdowns", "string[]"),
      port("classifiedEvidence", T_CLASSIFIED_EVIDENCE),
      port("audience", T_AUDIENCE),
      port("judgeRejectionFeedback", "string", "Reject-rerun correction from reportJudgeGate; empty on first pass."),
    ],
    outputs: [
      port("id", "string", "Stable finding identifier."),
      port("markdown", "string", "Finding write-up; cites tutorial concepts inline."),
      port("tutorialAnchors", "string[]", "Tutorial concept slugs this finding builds on (≥1 required)."),
      port("evidenceAnchors", "string[]", "Evidence artifact references (≥1 required)."),
    ],
    config: { promptRef: "findingsAuthoring" },
    fanout: { input: "evidence", elementRetries: 1 },
  };

  const humanReviewGate: GateStage = {
    name: "humanReviewGate",
    type: "gate",
    inputs: [
      port("tutorialSlugs", "string[]"),
      port("tutorialMarkdowns", "string[]"),
      port("findingIds", "string[]"),
      port("findingMarkdowns", "string[]"),
      port("findingTutorialAnchors", "string[][]"),
      port("findingEvidenceAnchors", "string[][]"),
    ],
    outputs: [],
    config: {
      question: {
        text:
          "Review the findings (and underlying tutorials). Approve to proceed to report assembly, or reject with feedback to regenerate findings. This is the only truly user-facing gate in the pipeline; all others above are LLM-judges in single-user runtime.",
        options: [
          { value: "approve", description: "Findings are sound; proceed to report assembly." },
          { value: "reject", description: "Findings need rework; regenerate hypotheses + findings with the supplied feedback." },
        ],
      },
      routing: {
        routes: { approve: "reportAssembly", reject: "hypothesize" },
      },
    },
  };

  const reportAssembly: AgentStage = {
    name: "reportAssembly",
    type: "agent",
    inputs: [
      port("investigationType", T_INVESTIGATION_TYPE),
      port("audience", T_AUDIENCE),
      port("tutorialSlugs", "string[]"),
      port("tutorialMarkdowns", "string[]"),
      port("findingIds", "string[]"),
      port("findingMarkdowns", "string[]"),
      port("findingTutorialAnchors", "string[][]"),
      port("findingEvidenceAnchors", "string[][]"),
    ],
    outputs: [
      port("markdown", "string", "Full report markdown."),
      port("audit", T_REPORT_AUDIT, "Bidirectional reference table for verification."),
    ],
    config: { promptRef: "reportAssembly" },
  };

  // Layer 3: Quality judgment
  const reportJudge: AgentStage = {
    name: "reportJudge",
    type: "agent",
    inputs: [
      port("investigationType", T_INVESTIGATION_TYPE),
      port("audience", T_AUDIENCE),
      port("axes", "string[]"),
      port("taskText", "string"),
      port("tutorialSlugs", "string[]"),
      port("tutorialMarkdowns", "string[]"),
      port("findingIds", "string[]"),
      port("findingMarkdowns", "string[]"),
      port("findingTutorialAnchors", "string[][]"),
      port("findingEvidenceAnchors", "string[][]"),
      port("reportMarkdown", "string"),
      port("reportAudit", T_REPORT_AUDIT),
      port("classifiedEvidence", T_CLASSIFIED_EVIDENCE),
    ],
    outputs: [
      port("axisScores", T_AXIS_SCORES, "6-axis 0..10 rubric scores."),
      port("axisFeedback", T_AXIS_FEEDBACK, "One-paragraph feedback per axis."),
      port("totalScore", "number", "Sum of axis scores; max 60."),
      port("recommendedAction", T_RECOMMENDED_ACTION, "Routing recommendation for reportJudgeGate."),
      port("judgeRound", "number", "Reject-loop iteration; force-accept on round 3."),
      port("judgeWarnings", "string[]", "Unresolved gaps when force-accepted on cap; empty otherwise."),
    ],
    config: { promptRef: "reportJudge" },
  };

  const reportJudgeGate: GateStage = {
    name: "reportJudgeGate",
    type: "gate",
    inputs: [
      port("recommendedAction", T_RECOMMENDED_ACTION),
      port("judgeRound", "number"),
    ],
    outputs: [],
    config: {
      question: {
        text:
          "Auto-routed by reportJudge.recommendedAction. Approve = report meets quality bar across all 6 axes; reject_to_evidenceGather = references axis sub-threshold, regenerate evidence; reject_to_findingsAuthoring = synthesis/communication/instruction-following sub-threshold, regenerate findings.",
        options: [
          { value: "accept", description: "All 6 rubric axes meet threshold; pipeline can complete." },
          { value: "reject_to_evidenceGather", description: "References axis below threshold (insufficient primary sources); regenerate evidence." },
          { value: "reject_to_findingsAuthoring", description: "Synthesis/communication/instruction-following below threshold; regenerate findings." },
        ],
      },
      routing: {
        routes: {
          accept: "pipelineComplete",
          reject_to_evidenceGather: "evidenceGather",
          reject_to_findingsAuthoring: "findingsAuthoring",
        },
      },
    },
  };

  const pipelineComplete: ScriptStage = {
    name: "pipelineComplete",
    type: "script",
    inputs: [
      port("reportMarkdown", "string", "Final approved report markdown; lineage only."),
    ],
    outputs: [
      port("done", "boolean"),
    ],
    config: { source: "registry", moduleId: "noop_terminal" },
  };

  // Order matters for the IR's stages array (canonical order is by
  // execution sequence — analysis.md §The 17-stage skeleton).
  return [
    topicFraming,
    framingGate,
    prereqExtraction,
    prereqGate,
    lookupTutorialCache,
    tutorialAuthoring,
    writeTutorialCache,
    mergeTutorials,
    tutorialReviewGate,
    hypothesize,
    evidenceGather,
    sourceClassify,
    primarySourceGate,
    findingsSynthesisGate,
    findingsAuthoring,
    humanReviewGate,
    reportAssembly,
    reportJudge,
    reportJudgeGate,
    pipelineComplete,
  ];
}

// ---------- Wires (deterministic) ----------

function buildWires(): WireIR[] {
  // External inputs feeding the pipeline.
  const ext: WireIR[] = [
    wire({ external: "taskText" }, "", "topicFraming", "taskText"),
    wire({ external: "audienceHint" }, "", "topicFraming", "audienceHint"),
    wire({ external: "taskText" }, "", "reportJudge", "taskText"),
  ];

  // Layer 0 → Layer 1 transition.
  const layer0to1: WireIR[] = [
    wire("topicFraming", "investigationType", "framingGate", "investigationType"),
    wire("topicFraming", "audience", "framingGate", "audience"),
    wire("topicFraming", "axes", "framingGate", "axes"),
    // gate-feedback wires
    wire("framingGate", "__gate_feedback__", "topicFraming", "framingRejectionFeedback"),
  ];

  // Layer 1: prereqExtraction.
  const prereqWires: WireIR[] = [
    wire("topicFraming", "investigationType", "prereqExtraction", "investigationType"),
    wire("topicFraming", "audience", "prereqExtraction", "audience"),
    wire("topicFraming", "axes", "prereqExtraction", "axes"),
    wire("prereqGate", "__gate_feedback__", "prereqExtraction", "prereqRejectionFeedback"),
    wire("prereqExtraction", "concepts", "prereqGate", "concepts"),
    wire("prereqExtraction", "tutorialOutline", "prereqGate", "tutorialOutline"),
  ];

  // D1 (c12) — tutorial cache wires.
  // Sequence: prereqExtraction.tutorialOutline → lookupTutorialCache →
  // tutorialAuthoring (fanout over missingSlugs only) →
  // writeTutorialCache (upsert fresh) → mergeTutorials (cached + fresh)
  // → downstream consumers.
  const tutorialCacheLookupWires: WireIR[] = [
    wire("prereqExtraction", "tutorialOutline", "lookupTutorialCache", "slugs"),
    wire("topicFraming", "subjectDomain", "lookupTutorialCache", "subjectDomain"),
  ];

  // tutorialAuthoring (fanout) — driven by lookupTutorialCache.missingSlugs.
  const tutorialAuthWires: WireIR[] = [
    wire("lookupTutorialCache", "missingSlugs", "tutorialAuthoring", "concept"),
    wire("topicFraming", "audience", "tutorialAuthoring", "audience"),
    wire("topicFraming", "axes", "tutorialAuthoring", "axes"),
    wire("tutorialReviewGate", "__gate_feedback__", "tutorialAuthoring", "tutorialRejectionFeedback"),
  ];

  // writeTutorialCache (upsert) — fed by the fanout aggregate.
  const tutorialCacheWriteWires: WireIR[] = [
    wire("tutorialAuthoring", "slug", "writeTutorialCache", "slugs"),
    wire("tutorialAuthoring", "markdown", "writeTutorialCache", "contents"),
    wire("topicFraming", "subjectDomain", "writeTutorialCache", "subjectDomain"),
  ];

  // mergeTutorials (concat cached + fresh).
  const tutorialMergeWires: WireIR[] = [
    wire("lookupTutorialCache", "cachedSlugs", "mergeTutorials", "cachedSlugs"),
    wire("lookupTutorialCache", "cachedContents", "mergeTutorials", "cachedContents"),
    wire("tutorialAuthoring", "slug", "mergeTutorials", "freshSlugs"),
    wire("tutorialAuthoring", "markdown", "mergeTutorials", "freshContents"),
  ];

  // Tutorial bundle aggregation feeding the rest of the pipeline.
  // Post-D1 the source is mergeTutorials, not tutorialAuthoring directly.
  const tutorialBundleWires: WireIR[] = [
    wire("mergeTutorials", "slugs", "tutorialReviewGate", "tutorialSlugs"),
    wire("mergeTutorials", "contents", "tutorialReviewGate", "tutorialMarkdowns"),
    wire("mergeTutorials", "slugs", "hypothesize", "tutorialSlugs"),
    wire("mergeTutorials", "contents", "hypothesize", "tutorialMarkdowns"),
    wire("mergeTutorials", "slugs", "evidenceGather", "tutorialSlugs"),
    wire("mergeTutorials", "contents", "evidenceGather", "tutorialMarkdowns"),
    wire("mergeTutorials", "slugs", "findingsAuthoring", "tutorialSlugs"),
    wire("mergeTutorials", "contents", "findingsAuthoring", "tutorialMarkdowns"),
    wire("mergeTutorials", "slugs", "humanReviewGate", "tutorialSlugs"),
    wire("mergeTutorials", "contents", "humanReviewGate", "tutorialMarkdowns"),
    wire("mergeTutorials", "slugs", "reportAssembly", "tutorialSlugs"),
    wire("mergeTutorials", "contents", "reportAssembly", "tutorialMarkdowns"),
    wire("mergeTutorials", "slugs", "reportJudge", "tutorialSlugs"),
    wire("mergeTutorials", "contents", "reportJudge", "tutorialMarkdowns"),
  ];

  // Layer 2: hypothesize.
  const hypothesizeWires: WireIR[] = [
    wire("topicFraming", "investigationType", "hypothesize", "investigationType"),
    wire("topicFraming", "audience", "hypothesize", "audience"),
    wire("topicFraming", "axes", "hypothesize", "axes"),
    wire("findingsSynthesisGate", "__gate_feedback__", "hypothesize", "findingsRejectionFeedback"),
    wire("humanReviewGate", "__gate_feedback__", "hypothesize", "humanRejectionFeedback"),
  ];

  // Layer 2: evidenceGather (fanout per hypothesis).
  const evidenceGatherWires: WireIR[] = [
    wire("hypothesize", "hypotheses", "evidenceGather", "hypothesis"),
    wire("topicFraming", "subjectDomain", "evidenceGather", "subjectDomain"),
    wire("primarySourceGate", "__gate_feedback__", "evidenceGather", "primaryRejectionFeedback"),
    wire("reportJudgeGate", "__gate_feedback__", "evidenceGather", "judgeRejectionFeedback"),
  ];

  // sourceClassify, primarySourceGate, findingsSynthesisGate.
  const classifyWires: WireIR[] = [
    wire("evidenceGather", "evidence", "sourceClassify", "evidence"),
    wire("topicFraming", "subjectDomain", "sourceClassify", "subjectDomain"),
    wire("topicFraming", "investigationType", "primarySourceGate", "investigationType"),
    wire("sourceClassify", "classifiedEvidence", "primarySourceGate", "classifiedEvidence"),
    wire("sourceClassify", "classifiedEvidence", "findingsSynthesisGate", "classifiedEvidence"),
  ];

  // findingsAuthoring (fanout over evidence elements).
  const findingsAuthWires: WireIR[] = [
    wire("evidenceGather", "evidence", "findingsAuthoring", "evidence"),
    wire("sourceClassify", "classifiedEvidence", "findingsAuthoring", "classifiedEvidence"),
    wire("topicFraming", "audience", "findingsAuthoring", "audience"),
    wire("reportJudgeGate", "__gate_feedback__", "findingsAuthoring", "judgeRejectionFeedback"),
  ];

  // Findings bundle → humanReviewGate, reportAssembly, reportJudge.
  const findingsBundleWires: WireIR[] = [
    wire("findingsAuthoring", "id", "humanReviewGate", "findingIds"),
    wire("findingsAuthoring", "markdown", "humanReviewGate", "findingMarkdowns"),
    wire("findingsAuthoring", "tutorialAnchors", "humanReviewGate", "findingTutorialAnchors"),
    wire("findingsAuthoring", "evidenceAnchors", "humanReviewGate", "findingEvidenceAnchors"),
    wire("findingsAuthoring", "id", "reportAssembly", "findingIds"),
    wire("findingsAuthoring", "markdown", "reportAssembly", "findingMarkdowns"),
    wire("findingsAuthoring", "tutorialAnchors", "reportAssembly", "findingTutorialAnchors"),
    wire("findingsAuthoring", "evidenceAnchors", "reportAssembly", "findingEvidenceAnchors"),
    wire("findingsAuthoring", "id", "reportJudge", "findingIds"),
    wire("findingsAuthoring", "markdown", "reportJudge", "findingMarkdowns"),
    wire("findingsAuthoring", "tutorialAnchors", "reportJudge", "findingTutorialAnchors"),
    wire("findingsAuthoring", "evidenceAnchors", "reportJudge", "findingEvidenceAnchors"),
  ];

  // reportAssembly inputs (excluding tutorial/findings bundles, already wired above).
  const reportAssemblyWires: WireIR[] = [
    wire("topicFraming", "investigationType", "reportAssembly", "investigationType"),
    wire("topicFraming", "audience", "reportAssembly", "audience"),
  ];

  // reportJudge inputs (excluding tutorial/findings bundles, already wired above).
  const reportJudgeWires: WireIR[] = [
    wire("topicFraming", "investigationType", "reportJudge", "investigationType"),
    wire("topicFraming", "audience", "reportJudge", "audience"),
    wire("topicFraming", "axes", "reportJudge", "axes"),
    wire("reportAssembly", "markdown", "reportJudge", "reportMarkdown"),
    wire("reportAssembly", "audit", "reportJudge", "reportAudit"),
    wire("sourceClassify", "classifiedEvidence", "reportJudge", "classifiedEvidence"),
  ];

  // reportJudgeGate → pipelineComplete (terminal).
  const judgeGateWires: WireIR[] = [
    wire("reportJudge", "recommendedAction", "reportJudgeGate", "recommendedAction"),
    wire("reportJudge", "judgeRound", "reportJudgeGate", "judgeRound"),
    wire("reportAssembly", "markdown", "pipelineComplete", "reportMarkdown"),
  ];

  return [
    ...ext,
    ...layer0to1,
    ...prereqWires,
    ...tutorialCacheLookupWires,
    ...tutorialAuthWires,
    ...tutorialCacheWriteWires,
    ...tutorialMergeWires,
    ...tutorialBundleWires,
    ...hypothesizeWires,
    ...evidenceGatherWires,
    ...classifyWires,
    ...findingsAuthWires,
    ...findingsBundleWires,
    ...reportAssemblyWires,
    ...reportJudgeWires,
    ...judgeGateWires,
  ];
}

// ---------- Public assembly ----------

export function assembleInvestigationIR(
  input: AssembleInvestigationIRInput,
): AssembleInvestigationIROutput {
  const stages = buildStages(input);
  const wires = buildWires();

  // store_schema entries — one per agent/script output port (gate stages
  // have no outputs).
  const store_schema: Record<string, { type: string; description?: string; produced_by: { stage: string; port: string } }> = {};
  for (const s of stages) {
    if (s.type === "gate") continue;
    for (const p of s.outputs) {
      const key = `${s.name}.${p.name}`;
      store_schema[key] = {
        type: p.type,
        description: p.description,
        produced_by: { stage: s.name, port: p.name },
      };
    }
  }

  const ir: PipelineIR = {
    name: input.pipelineName,
    stages,
    wires,
    externalInputs: [
      port("taskText", "string", "User-supplied investigation task description. Required."),
      port("audienceHint", "string", "Optional caller-supplied audience hint; empty string disables refinement."),
    ],
    store_schema,
    session_mode: "multi",
  };

  return { ir, subIrs: [] };
}

// ---------- ScriptModule export ----------

export const assemble_investigation_ir: ScriptModule = {
  async run(inputs) {
    // Validate and coerce inputs.
    const investigationType = inputs.investigationType;
    if (
      typeof investigationType !== "string" ||
      !["lookup", "diagnostic", "selection", "landscape"].includes(investigationType)
    ) {
      throw new Error(
        `assemble_investigation_ir: input 'investigationType' must be one of "lookup"|"diagnostic"|"selection"|"landscape" (got ${typeof investigationType === "string" ? `"${investigationType}"` : typeof investigationType})`,
      );
    }

    const audienceRaw = inputs.audience;
    if (audienceRaw === null || typeof audienceRaw !== "object" || Array.isArray(audienceRaw)) {
      throw new Error(
        `assemble_investigation_ir: input 'audience' must be an object (got ${typeof audienceRaw})`,
      );
    }
    const audience = audienceRaw as AssembleInvestigationIRInput["audience"];

    const axes = inputs.axes;
    if (!Array.isArray(axes) || axes.some((a) => typeof a !== "string")) {
      throw new Error(`assemble_investigation_ir: input 'axes' must be string[] (got ${typeof axes})`);
    }

    const subjectDomain = inputs.subjectDomain;
    if (typeof subjectDomain !== "string") {
      throw new Error(
        `assemble_investigation_ir: input 'subjectDomain' must be a string (got ${typeof subjectDomain})`,
      );
    }

    const conceptsRaw = inputs.concepts;
    if (!Array.isArray(conceptsRaw)) {
      throw new Error(
        `assemble_investigation_ir: input 'concepts' must be an array (got ${typeof conceptsRaw})`,
      );
    }
    // Note: we don't enforce the concept shape strictly here — this script
    // assembles structure regardless of content shape. Downstream agent
    // stages read concepts via the prompt and enforce shape there.
    const concepts = conceptsRaw as AssembleInvestigationIRInput["concepts"];

    const pipelineName = inputs.pipelineName;
    if (typeof pipelineName !== "string" || pipelineName.length === 0) {
      throw new Error(
        `assemble_investigation_ir: input 'pipelineName' must be a non-empty string (got ${typeof pipelineName})`,
      );
    }

    const pipelineId = inputs.pipelineId;
    if (typeof pipelineId !== "string" || pipelineId.length === 0) {
      throw new Error(
        `assemble_investigation_ir: input 'pipelineId' must be a non-empty string (got ${typeof pipelineId})`,
      );
    }

    const pipelineDescription = inputs.pipelineDescription;
    if (typeof pipelineDescription !== "string") {
      throw new Error(
        `assemble_investigation_ir: input 'pipelineDescription' must be a string (got ${typeof pipelineDescription})`,
      );
    }

    const recommendedMcpsRaw = inputs.recommendedMcps;
    let recommendedMcps: McpServerDecl[] | undefined;
    if (recommendedMcpsRaw !== undefined && recommendedMcpsRaw !== null) {
      if (!Array.isArray(recommendedMcpsRaw)) {
        throw new Error(
          `assemble_investigation_ir: input 'recommendedMcps' must be an array when set (got ${typeof recommendedMcpsRaw})`,
        );
      }
      recommendedMcps = recommendedMcpsRaw as McpServerDecl[];
    }

    const out = assembleInvestigationIR({
      investigationType: investigationType as AssembleInvestigationIRInput["investigationType"],
      audience,
      axes: axes as string[],
      subjectDomain,
      concepts,
      pipelineName,
      pipelineId,
      pipelineDescription,
      recommendedMcps,
    });

    return {
      ir: out.ir as unknown as Record<string, unknown>,
      subIrs: out.subIrs as unknown as Record<string, unknown>[],
    };
  },
};
