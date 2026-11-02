// pi-episteme — orchestration context builder (Stage 1: GVS-style
// sequential roles over one model).
//
// KV-cache contract: every orchestration call in a run shares ONE
// byte-stable prefix —
//
//   [static role-agnostic header] → [canonical Episteme layers]
//
// — and carries all role/task-specific data AFTER it, in the dynamic tail
// (the user message). The prefix is rebuilt from the same layer values with
// normalizeText-backed builders, so unchanged layers yield identical bytes
// and a local inference server (llama.cpp / Ollama / vLLM) can reuse the
// cached KV prefix across Manager, Worker and Verifier calls.
//
// Hard rule: NEVER put volatile data (iteration counters, wall-clock time,
// run status, role names) into the prefix — any change there invalidates
// the reusable prefix for every subsequent call of the run.

import {
  buildEpistemeSummary,
  type EpistemeLayers,
} from "./episteme.ts";

/**
 * Static, role-agnostic part of every orchestration system prompt. Kept
 * identical across all roles so the layer bytes sit at a stable offset from
 * the start of the request.
 */
export const ORCHESTRATION_HEADER = `## PI-EPISTEME ORCHESTRATION — static header

You are one role in a sequential multi-agent pipeline that solves a single task with repeated independent calls of one model. Everything above this header in the system prompt is byte-stable across the run: a local inference server may reuse its KV-cache for it. Do not restate the layers back to the caller; read what you need from them.

Layer legend:
- RESEARCH — the task: goal, outcome, constraints, acceptance criteria.
- PLAN — the base decomposition, one self-contained item per line ("- [id:S1] action").
- MILESTONE-N — archived digests of completed reports (with Completed-Steps list).
- STEP-ID — completion reports of finished plan items.
- PLAN-DELTA — the full current effective plan; supersedes PLAN when present.

Role contract:
- Manager plans in Episteme marker blocks (/*EPISTEME::RESEARCH::v1*/ … /*EPISTEME::END::RESEARCH::v1*/).
- Worker edits files with tools and ends its final message with a STEP report in /*EPISTEME::STEP-<id>::v1*/ … markers.
- Verifier independently re-runs the verification commands and ends its final message with one JSON object: {"verdict":"pass"|"fail","issues":["…"],"summary":"…"}.`;

export type OrchestrationRole = "manager" | "worker" | "verifier";

export interface OrchestrationContext {
  /** Byte-stable prefix: static header + canonical layers. */
  systemPrompt: string;
  /** Dynamic tail: role instructions + current task + role inputs. */
  message: string;
}

/**
 * The shared prefix for every call of a run. Same layers in → identical
 * string out (buildEpistemeSummary is normalization-stable).
 */
export function buildOrchestrationPrefix(
  layers: EpistemeLayers | undefined,
): string {
  const summary = layers ? buildEpistemeSummary(layers) : "";
  return summary
    ? `${ORCHESTRATION_HEADER}\n\n${summary}`
    : ORCHESTRATION_HEADER;
}

/** Manager, initial planning round: research + base plan for the task. */
export function managerPlanningTail(task: string): string {
  return `[ROLE: MANAGER — planning]

The user task:
${task}

Decompose it into independently executable steps. Reply with exactly two marker blocks:
1. /*EPISTEME::RESEARCH::v1*/ — goal, outcome, explicit constraints, stack/architecture, inputs, acceptance criteria. /*EPISTEME::END::RESEARCH::v1*/
2. /*EPISTEME::PLAN::v1*/ — one self-contained item per line: "- [id:S1] action". IDs are unique and stable. Each item names files/modules, the exact actions, the verification command, and the expected outcome. /*EPISTEME::END::PLAN::v1*/`;
}

/**
 * Manager, corrective round: fold verifier issues into a full new effective
 * plan. Completed item IDs and their text are immutable (the orchestrator
 * validates this), so corrections arrive under fresh IDs.
 */
export function managerFixTail(issues: readonly string[]): string {
  return `[ROLE: MANAGER — plan correction]

The Verifier rejected the completed work. Issues:
${issues.map((issue) => `- ${issue}`).join("\n")}

Write /*EPISTEME::PLAN-DELTA::v1*/ containing the FULL new effective plan: keep every completed item unchanged (same ID, same text), keep or adjust pending items, and add corrective items under fresh IDs. /*EPISTEME::END::PLAN-DELTA::v1*/`;
}

/** Worker: execute one plan item, then report it in a STEP block. */
export function workerTail(item: { id: string; text: string }): string {
  return `[ROLE: WORKER — step ${item.id}]

Execute exactly this plan item:
- [id:${item.id}] ${item.text}

Investigate the codebase with the available tools, implement the changes, and run the item's verification command. When the item is fully done, end your final message with:
/*EPISTEME::STEP-${item.id}::v1*/
10–30 lines: work done, files changed, verification results, decisions, risks.
/*EPISTEME::END::STEP-${item.id}::v1*/`;
}

/** Verifier: independent check, verdict as a single JSON object. */
export function verifierTail(): string {
  return `[ROLE: VERIFIER — independent check]

Independently verify the completed work against the acceptance criteria in RESEARCH. Run the verification commands of the plan items yourself; inspect the changed files. Do not trust worker reasoning — judge actual files and command outputs.

Reply with ONLY one JSON object, no prose:
{"verdict":"pass"|"fail","issues":["concrete problem 1","problem 2"],"summary":"one paragraph: what was checked and the overall result"}`;
}

/** Assemble a full call: stable prefix + dynamic role tail. */
export function buildOrchestrationContext(
  layers: EpistemeLayers | undefined,
  tail: string,
): OrchestrationContext {
  return { systemPrompt: buildOrchestrationPrefix(layers), message: tail };
}
