// pi-episteme — every string the extension shows to a MODEL lives here.
//
// Kept apart from the wiring in index.ts for two reasons: these texts are the
// extension's actual protocol contract (marker names, plan format, role rules)
// and want to be read/diffed on their own, and they are byte-relevant — the
// layer-0 instructions are appended to the system prompt, so a mid-session
// change invalidates the cached prefix. The activation message therefore reuses
// buildEpistemeInstructions verbatim: what the model reads in the injected
// message must be what later sits in the system prompt.

import { epistemePaths } from "./episteme.ts";
import type { OrchestrationOutcome } from "./orchestrator.ts";

/**
 * customType of the standing-instructions message injected by /episteme-on in
 * a session that already carries context (KV-cache guard: the system prompt
 * must not change mid-session, so the layer-0 instructions ride on a message
 * appended at the end of the context until the next compaction).
 */
export const INSTRUCTIONS_CUSTOM_TYPE = "episteme-instructions";

export type EpistemeMode = "strict" | "light";

/** The one sentence that differs between light and strict sessions. */
function activationRule(mode: EpistemeMode): string {
  if (mode === "strict")
    return "Strict mode: use the pipeline below for every implementation task. For questions, clarification, or discussion without a task, just answer without markers.";
  return "Light mode: answer questions and complete small tasks normally, without markers. Start the full pipeline below only when a task is substantial enough to benefit from phased context.";
}

/** Static per-session instructions appended to the system prompt (layer 0). */
export function buildEpistemeInstructions(
  epistemeDir: string,
  mode: EpistemeMode = "light",
): string {
  const p = epistemePaths(epistemeDir);
  const activation = activationRule(mode);
  return `## PI-EPISTEME — layered context (KV-cache optimization)

You work with a layered context: [system] → [research] → [plan] → [milestones] → [step reports] → [plan delta]. Ephemeral work is appended at the end and a phase-boundary compaction is requested after every advance. Small sessions can remain temporarily uncompacted when the host pi does not support forced compaction; keep following the protocol.

${activation}

Write each phase between exact markers. The last occurrence of a block wins. A new RESEARCH starts a new task cycle and clears the previous PLAN, PLAN-DELTA, STEP, and MILESTONE layers. Never rely on a previous cycle's reports.

Markers:
- research: /*EPISTEME::RESEARCH::v1*/ … /*EPISTEME::END::RESEARCH::v1*/
- base plan: /*EPISTEME::PLAN::v1*/ … /*EPISTEME::END::PLAN::v1*/
- step ID report: /*EPISTEME::STEP-ID::v1*/ … /*EPISTEME::END::STEP-ID::v1*/
- plan update: /*EPISTEME::PLAN-DELTA::v1*/ … /*EPISTEME::END::PLAN-DELTA::v1*/

Pipeline:
1. Clarify the requirements until the task is pinned down.
2. Write RESEARCH: begin with the user's goal, outcome, and explicit constraints; then record stack, architecture, inputs, and acceptance criteria.
3. Write PLAN with one self-contained item per line in the format "- [id:S1] action". IDs are unique and stable (S1, S2, … or meaningful short IDs). Include files/modules, exact actions, verification commands, and expected outcomes. Call episteme(action="advance") after writing a new RESEARCH and its new base PLAN.
4. Execute one item at a time. After its code and checks, write a 10–30 line STEP-ID report: work done, files, verification results, decisions, and risks. Call episteme(action="advance", step="ID"). The raw context is saved to ${p.tmp}/step_ID_raw.md when phase compaction succeeds; mention that path in the report.
5. Reports and MILESTONE digests are the information store for later steps. Do not omit key facts.

Rules:
- PLAN and PLAN-DELTA are FLAT lists: every item is one top-level "- [id:…] …" line starting at column 0. Do not nest sub-bullets and do not put plan items inside a code fence — only top-level bullets are tracked, and every tracked item must eventually carry a STEP report. Put details in the item text or in RESEARCH.
- Do not re-emit PLAN to tick checkboxes. Progress comes from STEP and MILESTONE completion records.
- To change the current plan, write PLAN-DELTA containing the FULL new effective plan with the same IDs for existing items. Completed item IDs and their action text are immutable. Add new work under fresh IDs.
- A new RESEARCH must be followed by a new base PLAN before advance is accepted; a previous plan is not inherited.
- Close every block before calling advance. Unclosed or empty blocks are dropped.
- Do not hand-edit the generated summary after compaction.`;
}

/**
 * The standing instructions delivered by /episteme-on in a session that already
 * has context: a short activation notice plus the exact layer-0 body (kept
 * byte-identical to buildEpistemeInstructions, so after the system prompt picks
 * the instructions up the model sees the same protocol it followed before).
 */
export function buildEpistemeActivationMessage(
  epistemeDir: string,
  mode: EpistemeMode,
): string {
  return (
    `[pi-episteme] Layered-context ${mode} mode is now ON for this session. ` +
    "The standing instructions below apply until /episteme-off; after the next " +
    `compaction they move into the system prompt and this message is dropped.\n\n` +
    buildEpistemeInstructions(epistemeDir, mode)
  );
}

/** Supersedes an earlier activation notice when the mode is switched in place. */
export function buildEpistemeModeSwitchMessage(
  epistemeDir: string,
  previous: EpistemeMode,
  next: EpistemeMode,
): string {
  return (
    `[pi-episteme] Mode switched: ${previous} → ${next}. ` +
    "The standing instructions below supersede the earlier activation; " +
    "the previous set no longer applies.\n\n" +
    buildEpistemeActivationMessage(epistemeDir, next)
  );
}

/** Revokes the standing instructions after /episteme-off. */
export function buildEpistemeRevocationMessage(): string {
  return (
    "[pi-episteme] Layered-context mode is now OFF. Previous standing " +
    "pi-episteme instructions are revoked; do not emit new EPISTEME blocks or " +
    "call advance unless the user explicitly enables the mode again."
  );
}

/** Ask the main agent to persist an orchestration run as its own layers. */
export function buildOrchestrationPersistRequest(
  outcome: OrchestrationOutcome,
  blocks: string,
): string {
  return (
    `PI-EPISTEME: orchestration ${outcome.ok ? "succeeded" : "finished with failures"}. ` +
    "Persist the run state: emit the canonical blocks below verbatim as your next assistant message " +
    "(marker blocks exactly as shown, no code fences), so the layers become the durable state of this session. " +
    "Then briefly report the result to the user.\n\n" +
    blocks
  );
}

/** Render the orchestration result for the tool result / the TUI. */
export function formatOrchestrationOutcome(
  outcome: OrchestrationOutcome,
): string {
  const lines = [
    `Orchestration ${outcome.ok ? "PASSED" : "FAILED"}: ${outcome.summary}`,
    `completed steps: [${outcome.completed.join(",")}]`,
  ];
  if (outcome.rounds > 0) lines.push(`corrective rounds: ${outcome.rounds}`);
  if (outcome.issues.length > 0)
    lines.push(`open issues:\n${outcome.issues.map((i) => `- ${i}`).join("\n")}`);
  return lines.join("\n");
}

/** Queued auto-continue message for the next unfinished plan item. */
export function buildContinueMessage(id: string, text: string): string {
  return `PI-EPISTEME: continue — execute ${id}: "${text}".`;
}
