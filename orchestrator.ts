// pi-episteme — GVS-style orchestration core (Stage 1).
//
// Sequential, single-model pipeline: Manager → Worker → Worker → … →
// Verifier, with bounded corrective rounds on verifier failure. No side
// files: the run state IS the Episteme layer set; every call is built by
// context.ts so the shared prefix stays byte-stable for KV-cache reuse.
//
// This module is deliberately free of pi-coding-agent imports: the caller
// (index.ts) injects the two transport functions, which keeps the loop
// fully testable offline (see check.cjs).

import {
  effectivePlan,
  extractEpistemeBlocks,
  extractLayers,
  planChangeError,
  planIdError,
  parsePlan,
  completedStepIds,
  firstUnreportedPlanStep,
  type EpistemeLayers,
} from "./episteme.ts";
import {
  buildOrchestrationContext,
  managerFixTail,
  managerPlanningTail,
  verifierTail,
  workerTail,
  type OrchestrationContext,
} from "./context.ts";

/** Chat-only model call (Manager/Verifier planning rounds). */
export type CallModel = (
  call: OrchestrationContext,
  signal?: AbortSignal,
) => Promise<string>;

/** Full tool-using agent run (Worker/Verifier verification rounds). */
export type RunAgent = (
  call: OrchestrationContext,
  signal?: AbortSignal,
) => Promise<string>;

export interface OrchestratorDeps {
  callModel: CallModel;
  runAgent: RunAgent;
}

export interface OrchestratorOptions {
  /** Corrective rounds after a failed verification. Default 2. */
  maxFixRounds?: number;
  signal?: AbortSignal;
  /** Phase transitions, for UI notifications and tests. */
  onPhase?: (phase: string) => void;
}

export interface OrchestrationOutcome {
  ok: boolean;
  /** Verifier summary (or the last error message). */
  summary: string;
  /** Final layer state — the durable, file-less run state. */
  layers: EpistemeLayers;
  /** Completed fix rounds (0 when the first verification passed). */
  rounds: number;
  /** IDs of plan items with a STEP report. */
  completed: string[];
  /** Outstanding verifier issues when ok=false. */
  issues: string[];
}

const DEFAULT_FIX_ROUNDS = 2;

/**
 * Corrective-round budget: env PI_EPISTEME_ORCH_FIX_ROUNDS (non-negative
 * integer) over the default. Kept env-only — a rarely tuned knob.
 */
export function readOrchFixRounds(): number {
  const raw = process.env.PI_EPISTEME_ORCH_FIX_ROUNDS?.trim();
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  return DEFAULT_FIX_ROUNDS;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("orchestration aborted");
}

function assistantText(report: string): string {
  return report.trim();
}

/**
 * Pull the layers a Manager reply claims to define. Returns undefined when
 * the reply carries no usable blocks; the caller feeds the parse error back
 * to the Manager for one retry.
 */
function managerLayers(text: string): EpistemeLayers | undefined {
  return extractLayers(text);
}

/**
 * Extract the STEP-<id> report from a Worker's final message. Fallback: the
 * whole final message is kept as the report text (never lose finished work).
 */
export function workerReport(
  stepId: string,
  finalText: string,
): { key: string; text: string } {
  const blocks = extractEpistemeBlocks(finalText).filter(
    (b) => b.key === `STEP-${stepId}`,
  );
  const last = blocks.at(-1);
  return {
    key: stepId,
    text: last ? last.text : assistantText(finalText),
  };
}

/** Parse the Verifier's single-JSON-object final message (best effort). */
export function verifierVerdict(finalText: string): {
  verdict: "pass" | "fail";
  issues: string[];
  summary: string;
} {
  const start = finalText.indexOf("{");
  const end = finalText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(finalText.slice(start, end + 1)) as {
        verdict?: unknown;
        issues?: unknown;
        summary?: unknown;
      };
      if (parsed.verdict === "pass" || parsed.verdict === "fail") {
        return {
          verdict: parsed.verdict,
          issues: Array.isArray(parsed.issues)
            ? parsed.issues.filter((i): i is string => typeof i === "string")
            : [],
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
        };
      }
    } catch {
      // fall through to the fail-closed verdict
    }
  }
  return {
    verdict: "fail",
    issues: ["verifier reply was not a parseable verdict JSON"],
    summary: assistantText(finalText).slice(0, 2000),
  };
}

function validatePlan(layers: EpistemeLayers): string | null {
  const plan = effectivePlan(layers);
  if (!layers.research) return "manager reply has no RESEARCH block";
  if (!plan) return "manager reply has no PLAN block";
  const idError = planIdError(plan);
  if (idError) return idError;
  if (parsePlan(plan).length === 0)
    return 'the effective PLAN has no items (format "- [id:S1] action")';
  return null;
}

/**
 * Run the pipeline. Resolves with the final layer state on success or a
 * fail-closed outcome; rejects only on abort/transport errors.
 */
export async function runOrchestration(
  task: string,
  deps: OrchestratorDeps,
  options: OrchestratorOptions = {},
): Promise<OrchestrationOutcome> {
  const maxFixRounds = Math.max(0, options.maxFixRounds ?? DEFAULT_FIX_ROUNDS);
  const { signal, onPhase } = options;
  let layers: EpistemeLayers = { planFresh: false };
  let rounds = 0;
  let issues: string[] = [];

  // -- Phase 1: Manager plans the task (one parse-retry on malformed blocks).
  onPhase?.("manager:planning");
  const planText = await deps.callModel(
    buildOrchestrationContext(layers, managerPlanningTail(task)),
    signal,
  );
  throwIfAborted(signal);
  const planned = managerLayers(planText);
  const planError = planned ? validatePlan(planned) : "manager reply has no Episteme blocks";
  if (planError) {
    onPhase?.("manager:planning-retry");
    const retryText = await deps.callModel(
      buildOrchestrationContext(
        layers,
        `${managerPlanningTail(task)}\n\nYour previous reply was rejected: ${planError}. Reply with the two marker blocks only.`,
      ),
      signal,
    );
    throwIfAborted(signal);
    const retried = managerLayers(retryText);
    const retryError = retried ? validatePlan(retried) : "manager reply has no Episteme blocks";
    if (retryError)
      return {
        ok: false,
        summary: `manager failed to produce a valid plan: ${retryError}`,
        layers,
        rounds,
        completed: [],
        issues: [retryError],
      };
    layers = retried as EpistemeLayers;
  } else {
    layers = planned as EpistemeLayers;
  }

  // -- Phase 2: execute steps, verify, correct — until pass or round budget.
  for (;;) {
    let plan = effectivePlan(layers);
    for (;;) {
      throwIfAborted(signal);
      const idx = plan
        ? firstUnreportedPlanStep(plan, layers.reports ?? [], layers.milestones ?? [])
        : -1;
      if (idx < 0 || !plan) break;
      const item = parsePlan(plan)[idx];
      onPhase?.(`worker:${item.id}`);
      const finalText = await deps.runAgent(
        buildOrchestrationContext(layers, workerTail(item)),
        signal,
      );
      throwIfAborted(signal);
      const report = workerReport(item.id, finalText);
      const reports = layers.reports ?? [];
      const at = reports.findIndex((r) => r.key === report.key);
      layers = {
        ...layers,
        reports:
          at >= 0
            ? reports.map((r, i) => (i === at ? report : r))
            : [...reports, report],
      };
      plan = effectivePlan(layers);
    }

    onPhase?.("verifier");
    const verdictText = await deps.runAgent(
      buildOrchestrationContext(layers, verifierTail()),
      signal,
    );
    throwIfAborted(signal);
    const verdict = verifierVerdict(verdictText);
    if (verdict.verdict === "pass") {
      return {
        ok: true,
        summary: verdict.summary,
        layers,
        rounds,
        completed: [...completedStepIds(layers.reports ?? [], layers.milestones ?? [])],
        issues: [],
      };
    }
    issues = verdict.issues;
    if (rounds >= maxFixRounds)
      return {
        ok: false,
        summary: verdict.summary || `verification failed after ${rounds} corrective round(s)`,
        layers,
        rounds,
        completed: [
          ...completedStepIds(layers.reports ?? [], layers.milestones ?? []),
        ],
        issues,
      };
    rounds += 1;
    onPhase?.(`manager:fix-round-${rounds}`);
    const fixText = await deps.callModel(
      buildOrchestrationContext(layers, managerFixTail(issues)),
      signal,
    );
    throwIfAborted(signal);
    const fixLayers = extractLayers(fixText);
    if (!fixLayers?.planDelta) {
      return {
        ok: false,
        summary: "manager failed to produce a PLAN-DELTA for the corrective round",
        layers,
        rounds,
        completed: [
          ...completedStepIds(layers.reports ?? [], layers.milestones ?? []),
        ],
        issues,
      };
    }
    const changeError = planChangeError(layers, fixLayers);
    const idError = planIdError(fixLayers.planDelta as string);
    if (changeError || idError)
      return {
        ok: false,
        summary: `manager PLAN-DELTA rejected: ${changeError ?? idError}`,
        layers,
        rounds,
        completed: [
          ...completedStepIds(layers.reports ?? [], layers.milestones ?? []),
        ],
        issues,
      };
    // Merge, never replace: the delta is only the new effective plan. The
    // RESEARCH/PLAN reports stay the durable state — replacing the layers
    // here would re-execute completed steps.
    layers = { ...layers, planDelta: fixLayers.planDelta };
  }
}
