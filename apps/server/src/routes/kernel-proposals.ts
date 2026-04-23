// REST routes for kernel-next pipeline-change proposal approval.
//
// GET  /api/kernel/proposals?status=pending|approved|rejected
// POST /api/kernel/proposals/:id/approve
// POST /api/kernel/proposals/:id/reject     body: { reason?: string }
//
// P2 scope: approve only flips status; does NOT migrate running tasks
// (see kernel-next-design.md §13 — migration is Phase 2 P3+).
//
// Error envelope: all non-2xx responses share one shape
//   { ok: false, diagnostics: [{ code, message, context? }] }
// so that the REST surface round-trips the same vocabulary as KernelService
// and MCP tool responses. Clients branch on code, never on body shape.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { KernelService, type ProposalStatus } from "../kernel-next/mcp/kernel.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelProposalsRoute = new Hono();

const STATUS_SET: ReadonlySet<ProposalStatus> = new Set([
  "pending",
  "approved",
  "rejected",
]);

const rejectBodySchema = z.object({
  reason: z.string().max(4096).optional(),
}).strict();

// Body for POST /api/kernel/proposals (create). Mirrors KernelService.propose
// argument shape; IRPatch is validated at service layer (the service re-parses
// via IRPatchSchema), so here we only assert it's an object with an ops array.
// Any mismatches surface as service-level diagnostics rather than HTTP 400 --
// that separation keeps the routing layer simple.
const createProposalBodySchema = z.object({
  currentVersion: z.string().min(1),
  patch: z.object({ ops: z.array(z.unknown()).min(1) }).passthrough(),
  actor: z.string().min(1).max(256),
  rerunFrom: z.union([z.string().min(1), z.null()]).optional(),
  migrateRunningTasks: z.union([
    z.literal("all"),
    z.literal("none"),
    z.array(z.string().min(1)),
  ]).optional(),
  autoApprove: z.boolean().optional(),
  prompts: z.record(z.string(), z.string()).optional(),
}).strict();

function badRequest(
  c: Context,
  code: "INVALID_STATUS_PARAM" | "INVALID_JSON_BODY" | "INVALID_REQUEST_BODY",
  message: string,
  context?: Record<string, unknown>,
) {
  return c.json(
    {
      ok: false,
      diagnostics: [{ code, message, ...(context ? { context } : {}) }],
    },
    400,
  );
}

kernelProposalsRoute.get("/kernel/proposals", (c) => {
  const statusParam = c.req.query("status");
  if (statusParam !== undefined && !STATUS_SET.has(statusParam as ProposalStatus)) {
    return badRequest(
      c,
      "INVALID_STATUS_PARAM",
      `invalid status '${statusParam}' (allowed: pending|approved|rejected)`,
      { received: statusParam },
    );
  }
  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const proposals = svc.listProposals(
    statusParam ? { status: statusParam as ProposalStatus } : {},
  );
  return c.json({ ok: true, proposals });
});

// Phase 6 audit: expose propose() at the HTTP layer. Pre-audit it was
// only reachable via MCP, which meant running-server dogfood paths
// couldn't iterate prompts through the formal pipeline-version flow
// and had to "edit file + restart + re-seed" (which defeats the
// version-hash model).
kernelProposalsRoute.post("/kernel/proposals", async (c) => {
  const raw = await c.req.text();
  if (raw.trim().length === 0) {
    return badRequest(c, "INVALID_REQUEST_BODY", "request body is required");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
  }
  const parsed = createProposalBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequest(
      c,
      "INVALID_REQUEST_BODY",
      issue?.message ?? "bad request",
      issue ? { path: issue.path } : undefined,
    );
  }
  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const result = svc.propose({
    currentVersion: parsed.data.currentVersion,
    // Cast: the service layer re-validates via IRPatchSchema. Routing
    // layer trusts that the shape is close enough to parse.
    patch: parsed.data.patch as unknown as Parameters<typeof svc.propose>[0]["patch"],
    actor: parsed.data.actor,
    rerunFrom: parsed.data.rerunFrom,
    migrateRunningTasks: parsed.data.migrateRunningTasks,
    autoApprove: parsed.data.autoApprove,
    prompts: parsed.data.prompts,
  });
  if (result.ok) return c.json(result, 202);
  // Service diagnostics carry the precise failure code. Map to HTTP
  // status the same way migrate does.
  const code = result.diagnostics[0]?.code;
  const status =
    code === "PATCH_APPLY_ERROR" ? 400 :
    code === "PROMPT_REF_MISSING" ? 400 :
    code === "CONFLICT" ? 409 :
    code === "WIRE_TYPE_MISMATCH" ||
    code === "DUPLICATE_STAGE_NAME" ||
    code === "STORE_SCHEMA_TYPE_MISMATCH" ? 400 :
    500;
  return c.json(result, status);
});

kernelProposalsRoute.post("/kernel/proposals/:id/approve", (c) => {
  const id = c.req.param("id");
  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const result = svc.approveProposal(id);
  if (result.ok) return c.json(result);
  return c.json(result, statusForDiagnostic(result.diagnostics[0]?.code));
});

kernelProposalsRoute.post("/kernel/proposals/:id/reject", async (c) => {
  const id = c.req.param("id");

  // Accept: empty body OR JSON body. content-length header is not
  // reliably set by fetch-based clients (WHATWG Request leaves it null),
  // so we inspect the raw text and only validate when non-empty.
  const raw = await c.req.text();
  let reason: string | undefined;
  if (raw.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON body");
    }
    const parsed = rejectBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return badRequest(
        c,
        "INVALID_REQUEST_BODY",
        issue?.message ?? "bad request",
        issue ? { path: issue.path } : undefined,
      );
    }
    reason = parsed.data.reason;
  }

  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const result = svc.rejectProposal(id, reason);
  if (result.ok) return c.json(result);
  return c.json(result, statusForDiagnostic(result.diagnostics[0]?.code));
});

function statusForDiagnostic(code: string | undefined): 404 | 409 | 500 {
  if (code === "PROPOSAL_NOT_FOUND") return 404;
  if (code === "PROPOSAL_ALREADY_RESOLVED") return 409;
  return 500;
}
