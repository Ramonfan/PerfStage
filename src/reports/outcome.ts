import type { DiagnosticImpact } from "../diagnostics/normalize.js";
import { deriveGate } from "../analysis/thresholds.js";
import type {
  GateResult,
  MetricVerdict,
  RunStatus,
} from "../model/test-run.js";
import { deriveFinalStatus } from "./status.js";

export interface RunOutcomeInput {
  requestedStatus: RunStatus;
  diagnosticsImpact: DiagnosticImpact;
  /** Evidence-gap codes such as `metric:hitches` or `trace:memoryMB`. */
  missingEvidence: string[];
  metricVerdicts: MetricVerdict[];
  interrupted?: boolean;
}

export interface RunOutcome {
  status: RunStatus;
  gate: GateResult;
}

/**
 * Resolve the two independent results of a Take (D6), following the
 * evidence-gate precedence table from the MVP plan:
 *
 * 1. explicit invalid / cancelled  -> same status, gate unknown
 * 2. crash / jetsam / watchdog     -> failed, gate fail
 * 3. interrupted or failed request -> failed, gate unknown
 * 4. missing metric/value/trace    -> partial, gate unknown
 * 5. unavailable diagnostics       -> partial, gate unknown
 * 6. metric fail                   -> completed, gate fail
 * 7. metric warn                   -> completed, gate warn
 * 8. all pass                      -> completed, gate pass
 */
export function deriveRunOutcome(input: RunOutcomeInput): RunOutcome {
  const requested = input.requestedStatus;

  // 1. Explicit terminal overrides.
  if (requested === "invalid" || requested === "cancelled") {
    return { status: requested, gate: "unknown" };
  }
  if (requested === "prepared" || requested === "running") {
    return { status: "invalid", gate: "unknown" };
  }

  // 2. A new Crash / jetsam / watchdog / device disconnect.
  if (input.diagnosticsImpact.severity === "failure") {
    return { status: "failed", gate: "fail" };
  }

  // 3. Flow interrupted or an action ultimately failed.
  if (input.interrupted === true || requested === "failed") {
    return { status: "failed", gate: "unknown" };
  }

  // 4/5. Evidence gaps and unavailable diagnostics.
  const status = deriveFinalStatus({
    requestedStatus: requested,
    diagnosticsImpact: input.diagnosticsImpact,
    missingEvidence: input.missingEvidence,
  });
  if (status !== "completed") {
    return { status, gate: "unknown" };
  }

  // 6/7/8. Complete Take: gate on thresholds only.
  return { status, gate: deriveGate(input.metricVerdicts) };
}
