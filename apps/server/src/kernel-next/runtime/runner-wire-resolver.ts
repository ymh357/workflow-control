// Wire-resolution diagnostics for the runner (design §6.2).
//
// Extracted from runner.ts to keep the orchestration file focused.
// Consumers: runner.ts calls buildNoActiveWireError at every NO_ACTIVE_WIRE
// site; nothing else imports these symbols.

import type { StageMeta, InboundWireMeta } from "../compiler/ir-to-machine.js";
import { evaluateGuard } from "./guard-evaluator.js";

// Design §6.2 — why the inbound wire to a stage failed. NO_ACTIVE_WIRE
// diagnostics attach an array of these so the AI author can see which
// wire was the culprit (which source port, which guard, what value,
// what reason). Kept flat + JSON-serializable for MCP / REST transport.
export interface GuardFailure {
  wire: {
    from: { stage: string; port: string };
    to: { stage: string; port: string };
  };
  // The wire's guard expression. null when the upstream port was never
  // written (so there was no guard to evaluate — the wire is simply
  // dead because its source never fired).
  guardExpr: string | null;
  // JSON-stringified source port value, truncated to 200 bytes so the
  // diagnostic stays inline-friendly. When the upstream never wrote,
  // this is "<never written>".
  valuePreview: string;
  reason:
    | "upstream-not-written"
    | "guard-false"
    | "guard-threw";
  // Present when reason === 'guard-threw'. The Error.message as-is.
  guardError?: string;
}

export interface StageErrorContext {
  // All wires that had an issue. A stage fails NO_ACTIVE_WIRE when EVERY
  // inbound wire is non-deliverable — so the array contains one entry
  // per inbound wire on the stage.
  failedWires: GuardFailure[];
}

// Maximum characters in a value preview embedded in a GuardFailure.
const PREVIEW_BYTES = 200;

// Serialises any value to a JSON string, truncated to PREVIEW_BYTES.
// Exported so runner.ts can reuse it for port_written SSE previews.
export function truncateJson(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    // Circular or non-JSON values: stringify-coerce.
    s = String(v);
  }
  if (s === undefined) s = "undefined";
  if (s.length <= PREVIEW_BYTES) return s;
  return s.slice(0, PREVIEW_BYTES);
}

// Returns null when the wire DELIVERED (source written + guard true, or
// guardless + source written); otherwise returns a GuardFailure record
// explaining why it didn't.
export function describeWireFailure(
  wire: InboundWireMeta,
  portValues: Record<string, unknown>,
): GuardFailure | null {
  const base = {
    wire: { from: wire.from, to: wire.to },
    guardExpr: wire.guard ?? null,
  };
  if (!(wire.sourceKey in portValues)) {
    return { ...base, valuePreview: "<never written>", reason: "upstream-not-written" };
  }
  const raw = portValues[wire.sourceKey];
  const valuePreview = truncateJson(raw);
  if (!wire.guard) {
    // Guardless + settled → wire delivered. Not a failure.
    return null;
  }
  let threw: Error | undefined;
  const ok = evaluateGuard(wire.guard, raw,
    { wireFrom: wire.from, wireTo: wire.to },
    { onError: (err) => { threw = err instanceof Error ? err : new Error(String(err)); } },
  );
  if (threw) {
    return { ...base, valuePreview, reason: "guard-threw", guardError: threw.message };
  }
  return ok ? null : { ...base, valuePreview, reason: "guard-false" };
}

// NO_ACTIVE_WIRE diagnostic builder (design §6.2). When a stage's parallel
// region reaches its `error` final, the compiler has already concluded that
// every inbound wire is non-deliverable. To let the AI author debug it,
// we re-walk the stage's inbound wires here and record, per wire, WHY it
// failed: upstream unwritten, guard evaluated false, or guard threw.
// Stages with no inbound wires never hit this path (they don't have a
// "wires died" failure mode).
export function buildNoActiveWireError(
  stageName: string,
  stageMeta: Map<string, StageMeta>,
  portValues: Record<string, unknown>,
): { stage: string; message: string; context: StageErrorContext } {
  const meta = stageMeta.get(stageName);
  const failedWires: GuardFailure[] = [];
  if (meta) {
    for (const w of meta.inbound) {
      const desc = describeWireFailure(w, portValues);
      // Deliverable wires (guard true) are not recorded — the AI is
      // debugging the wires that DID NOT deliver. A stage in NO_ACTIVE_
      // WIRE has at least one such wire; we expose them all.
      if (desc) failedWires.push(desc);
    }
  }
  return {
    stage: stageName,
    message: `NO_ACTIVE_WIRE: every inbound wire to '${stageName}' resolved false — stage cannot activate`,
    context: { failedWires },
  };
}
