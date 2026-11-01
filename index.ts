/**
 * pi-strata — layered KV-cache-friendly context management for pi-coding-agent
 * with local LLMs (llama.cpp / Ollama). See SPEC.md.
 *
 * Context layout (prompt prefix must be byte-stable across steps):
 *
 *   [Layer 0] system prompt (+ static pi-strata instructions)
 *     [Layer 1] RESEARCH marker block (in the conversation)
 *       [Layer 2] PLAN marker block (the base plan)
 *         [Layer 3] MILESTONE and STEP-ID blocks (archived/current reports)
 *           [Layer 4] PLAN-DELTA (the full effective plan)
 *             [current] ephemeral task + tool outputs (discarded into reports)
 *
 * Layer data lives in the conversation, not in files: the model writes each
 * phase between STRATA:: markers, and the layers are injected as the
 * deterministic compaction summary (the extracted blocks re-emitted in fixed
 * order). After every phase compaction the prefix [system + layers] is
 * unchanged except for the replaced/appended blocks, enabling provider-side
 * KV-cache reuse when the provider supports it.
 *
 * The session strata directory (next to the session file,
 * <session>.pi_strata/) holds raw context snapshots (tmp/) only.
 */

import {
  getAgentDir,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { resolveStrataSettings } from "./config.ts";
import {
  handleSessionBeforeCompact,
  type StrataDetails,
  type StrataRuntime,
} from "./compaction.ts";
import {
  SEP,
  STRATA_MARKER,
  buildStrataSummary,
  cleanupOrphanedStrataDirs,
  completedStepIds,
  effectivePlan,
  estimateTextTokens,
  extractLayers,
  fitLine,
  firstUnreportedPlanStep,
  itemId,
  itemText,
  modeSegments,
  parsePlan,
  planChangeError,
  planDashboardSegments,
  planIdError,
  reportPlanCounts,
  strataPaths,
  stripStrataMarkersForDisplay,
  type StrataLayers,
  type WidgetSegment,
} from "./strata.ts";

/**
 * customType of the standing-instructions message injected by /strata-on in
 * a session that already carries context (KV-cache guard: the system prompt
 * must not change mid-session, so the layer-0 instructions ride on a message
 * appended at the end of the context until the next compaction).
 */
const INSTRUCTIONS_CUSTOM_TYPE = "strata-instructions";

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, never>;
  isError?: boolean;
}

const toolText = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  details: {},
  isError,
});

/** Session-scoped strata directory: next to the session file. */
function resolveStrataDir(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager;
  const file = sm.getSessionFile();
  if (file) return join(dirname(file), `${basename(file, ".jsonl")}.pi_strata`);
  return join(getAgentDir(), "strata", sm.getSessionId());
}

/** Static per-session instructions appended to the system prompt (layer 0). */
export function buildStrataInstructions(
  strataDir: string,
  mode: "strict" | "light" = "strict",
): string {
  const p = strataPaths(strataDir);
  const activation =
    mode === "light"
      ? "Light mode: answer questions and complete small tasks normally, without markers. Start the full pipeline below only when a task is substantial enough to benefit from phased context."
      : "Strict mode: use the pipeline below for every implementation task. For questions, clarification, or discussion without a task, just answer without markers.";
  return `## PI-STRATA — layered context (KV-cache optimization)

You work with a layered context: [system] → [research] → [plan] → [milestones] → [step reports] → [plan delta]. Ephemeral work is appended at the end and a phase-boundary compaction is requested after every advance. Small sessions can remain temporarily uncompacted when the host pi does not support forced compaction; keep following the protocol.

${activation}

Write each phase between exact markers. The last occurrence of a block wins. A new RESEARCH starts a new task cycle and clears the previous PLAN, PLAN-DELTA, STEP, and MILESTONE layers. Never rely on a previous cycle's reports.

Markers:
- research: /*STRATA::RESEARCH::v1*/ … /*STRATA::END::RESEARCH::v1*/
- base plan: /*STRATA::PLAN::v1*/ … /*STRATA::END::PLAN::v1*/
- step ID report: /*STRATA::STEP-ID::v1*/ … /*STRATA::END::STEP-ID::v1*/
- plan update: /*STRATA::PLAN-DELTA::v1*/ … /*STRATA::END::PLAN-DELTA::v1*/

Pipeline:
1. Clarify the requirements until the task is pinned down.
2. Write RESEARCH: begin with the user's goal, outcome, and explicit constraints; then record stack, architecture, inputs, and acceptance criteria.
3. Write PLAN with one self-contained item per line in the format "- [id:S1] action". IDs are unique and stable (S1, S2, … or meaningful short IDs). Include files/modules, exact actions, verification commands, and expected outcomes. Call strata(action="advance") after writing a new RESEARCH and its new base PLAN.
4. Execute one item at a time. After its code and checks, write a 10–30 line STEP-ID report: work done, files, verification results, decisions, and risks. Call strata(action="advance", step="ID"). The raw context is saved to ${p.tmp}/step_ID_raw.md when phase compaction succeeds; mention that path in the report.
5. Reports and MILESTONE digests are the information store for later steps. Do not omit key facts.

Rules:
- Do not re-emit PLAN to tick checkboxes. Progress comes from STEP and MILESTONE completion records.
- To change the current plan, write PLAN-DELTA containing the FULL new effective plan with the same IDs for existing items. Completed item IDs and their action text are immutable. Add new work under fresh IDs.
- A new RESEARCH must be followed by a new base PLAN before advance is accepted; a previous plan is not inherited.
- Close every block before calling advance. Unclosed or empty blocks are dropped.
- Do not hand-edit the generated summary after compaction.`;
}

/**
 * True when the branch already carries LLM context: any session entry that
 * produces context messages (a message, a compaction summary, …). A
 * mid-session system-prompt change in that case would invalidate the whole
 * KV-cache prefix and make the local model re-read the entire session.
 */
function branchHasContext(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  return branch.some(
    (entry) => sessionEntryToContextMessages(entry as never).length > 0,
  );
}

/**
 * The standing instructions delivered by /strata-on in a session that already
 * has context: a short activation notice plus the exact layer-0 body (kept
 * byte-identical to buildStrataInstructions, so after the system prompt picks
 * the instructions up the model sees the same protocol it followed before).
 */
export function buildStrataActivationMessage(
  strataDir: string,
  mode: "strict" | "light",
): string {
  return (
    `[pi-strata] Layered-context ${mode} mode is now ON for this session. ` +
    "The standing instructions below apply until /strata-off; after the next " +
    `compaction they move into the system prompt and this message is dropped.\n\n` +
    buildStrataInstructions(strataDir, mode)
  );
}

/**
 * Conversation text for marker extraction: the last compaction summary (the
 * state at the last compaction) followed by the assistant messages after it,
 * in order — so "latest wins" extraction sees the summary first and newer
 * blocks in the tail override it.
 */
function branchText(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  let cut = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      cut = i;
      break;
    }
  }
  const parts: string[] = [];
  if (cut >= 0) {
    const entry = branch[cut];
    if (
      entry.type === "compaction" &&
      typeof entry.summary === "string" &&
      entry.summary.startsWith(STRATA_MARKER)
    )
      parts.push(entry.summary);
  }
  for (let i = cut + 1; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    // SAFETY: AgentMessage is a pi-ai union type; here only the assistant
    // text is needed, and every text-carrying variant has {role, content}.
    const msg = entry.message as unknown as {
      role?: string;
      content?: unknown;
    };
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const c of content as { type?: string; text?: string }[]) {
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join(SEP);
}

// ---------------------------------------------------------------------------
// Tool actions
// ---------------------------------------------------------------------------

function planAdvanceError(layers: StrataLayers): string | null {
  if (!layers.research) return "Error: no RESEARCH block for the current cycle.";
  if (!layers.plan || layers.planFresh === false)
    return "Error: a new RESEARCH requires a new base PLAN. Write it between /*STRATA::PLAN::v1*/ … /*STRATA::END::PLAN::v1*/ and call advance again.";
  const plan = effectivePlan(layers) as string;
  if (parsePlan(plan).length === 0)
    return 'Error: the effective PLAN has no items (format "- [id:S1] action").';
  const idError = planIdError(plan);
  return idError ? `Error: ${idError}` : null;
}

function lastCompactionSummary(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction" && typeof entry.summary === "string")
      return entry.summary;
  }
  return undefined;
}

function droppedReports(
  prev: StrataLayers | undefined,
  next: StrataLayers,
): { key: string; n?: number; text: string }[] {
  const kept = new Set((next.reports ?? []).map((r) => `${r.key}\u0000${r.text}`));
  return (prev?.reports ?? []).filter((r) => !kept.has(`${r.key}\u0000${r.text}`));
}

function layerChangeNotice(
  prev: StrataLayers | undefined,
  next: StrataLayers,
): string {
  const dropped = droppedReports(prev, next);
  if (!dropped.length) return "";
  return ` A new RESEARCH block started a new task cycle: the previous cycle's step reports [${dropped
    .map((r) => r.key)
    .join(",")}] are no longer in the layers.`;
}

function stepAdvanceError(layers: StrataLayers, key: string): string | null {
  const plan = effectivePlan(layers);
  const items = plan ? parsePlan(plan) : [];
  if (items.length === 0)
    return "Error: no effective PLAN. Write the plan and call advance again.";
  const index = items.findIndex((item) => item.id === key);
  if (index < 0) return `Error: there is no plan item with ID ${key}.`;
  const completed = completedStepIds(layers.reports ?? [], layers.milestones ?? []);
  if (items.slice(0, index).some((item) => !completed.has(item.id)))
    return "Error: complete the preceding plan items first: their STEP reports are missing.";
  if (!(layers.reports ?? []).some((r) => r.key === key))
    return `Error: no report for step ${key}. Write it between /*STRATA::STEP-${key}::v1*/ … /*STRATA::END::STEP-${key}::v1*/ and call advance again.`;
  return null;
}

function actAdvance(
  rt: StrataRuntime,
  ctx: ExtensionContext,
  step?: number | string,
): ToolResult {
  const layers = extractLayers(branchText(ctx));
  if (!layers)
    return toolText(
      "Error: no STRATA:: blocks in the conversation. Write RESEARCH/PLAN/STEP-ID blocks first.",
      true,
    );
  const prev = extractLayers(lastCompactionSummary(ctx) ?? "");
  const cycleChanged =
    (prev?.research !== undefined && layers.research !== prev.research) ||
    droppedReports(prev, layers).length > 0;
  if (!cycleChanged) {
    const changeError = planChangeError(prev, layers);
    if (changeError) return toolText(`Error: ${changeError}`, true);
  }
  const notice = layerChangeNotice(prev, layers);
  const plan = effectivePlan(layers);
  const idError = plan ? planIdError(plan) : null;
  if (idError) return toolText(`Error: ${idError}`, true);

  if (step === undefined) {
    const err = planAdvanceError(layers);
    if (err) return toolText(err, true);
    rt.pending = { kind: "plan" };
    const nextIdx = firstUnreportedPlanStep(
      plan as string,
      layers.reports ?? [],
      layers.milestones ?? [],
    );
    const tail =
      nextIdx >= 0
        ? ` Next: execute ${itemId(plan as string, nextIdx)} ("${itemText(plan as string, nextIdx)}").`
        : " All plan steps are complete.";
    return toolText(`Plan compaction at the end of the turn.${notice}${tail}`);
  }

  const items = plan ? parsePlan(plan) : [];
  let key: string;
  if (typeof step === "number") {
    if (!Number.isInteger(step) || step < 1)
      return toolText("Error: numeric step must be an integer >= 1.", true);
    key = items[step - 1]?.id ?? String(step);
  } else {
    key = step.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key))
      return toolText("Error: step ID has an invalid format.", true);
  }
  const err = stepAdvanceError(layers, key);
  if (err) return toolText(err, true);
  rt.pending = {
    kind: "step",
    stepId: key,
    stepN: /^\d+$/.test(key) ? Number(key) : undefined,
  };
  const tmpDir = rt.strataDir ? strataPaths(rt.strataDir).tmp : "(no session)";
  const nextIdx = firstUnreportedPlanStep(
    plan as string,
    layers.reports ?? [],
    layers.milestones ?? [],
  );
  const tail =
    nextIdx >= 0
      ? ` Next step: ${itemId(plan as string, nextIdx)} — "${itemText(plan as string, nextIdx)}".`
      : " All plan steps are complete.";
  return toolText(
    `Step ${key} accepted. Compaction at the end of the turn (raw context → ${tmpDir}/step_${key}_raw.md).${notice}${tail}`,
  );
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Config: env (PI_STRATA_*) > settings.json `piStrata` > defaults.
  // Resolved at load time from process.cwd(); re-resolved on session_start
  // with the real project cwd.
  const initial = resolveStrataSettings(process.cwd());
  const rt: StrataRuntime = {
    strataDir: null,
    pending: null,
    layerTokenBudget: initial.layerTokenBudget,
  };
  let enabled = false;
  let strataMode: "strict" | "light" = "strict";
  let paused = false;
  let deferSystemPrompt = false;
  let autoContinue = initial.autoContinue;
  let hideAnchors = initial.hideAnchors;
  let compactOurs = false;
  let deferredReason: string | undefined;
  const stats = { compacted: 0, deferred: 0 };
  rt.ensureBoundary = (ctx) => {
    pi.appendEntry("strata-phase-boundary", {
      kind: rt.pending?.kind,
      stepId: rt.pending?.stepId,
    });
    const id = ctx.sessionManager.getLeafId();
    if (!id) throw new Error("pi-strata: failed to append a phase boundary");
    if (rt.pending) rt.pending.boundaryId = id;
    return id;
  };

  // Compact TUI rendering for the standing-instructions message
  // (INSTRUCTIONS_CUSTOM_TYPE): one line by default, expandable to the full
  // text — the raw instructions are long and would flood the transcript.
  pi.registerMessageRenderer(
    INSTRUCTIONS_CUSTOM_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const line =
        expanded && typeof message.content === "string"
          ? message.content
          : `${theme.fg("accent", "strata")} ${theme.fg(
              "dim",
              "standing instructions attached (move to the system prompt after the next compaction)",
            )}`;
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(line, 0, 0));
      return box;
    },
  );

  // Display-only: hide the STRATA marker anchors in the TUI transcript
  // (config hideAnchors, default on; re-resolved on session_start). pi's
  // markdown transformer runs before rendering (assistant text and
  // thinking, streaming and final, new and restored messages); the session
  // and the model context keep the raw markers, so extraction is
  // unaffected. User messages are passed through untouched.
  pi.registerMarkdownTransformer((markdown, { messageType }) =>
    hideAnchors && messageType !== "user"
      ? stripStrataMarkersForDisplay(markdown)
      : markdown,
  );

  const statusText = (ctx: ExtensionContext): string => {
    const dir = rt.strataDir ?? "(no session)";
    const layers = extractLayers(branchText(ctx));
    const plan = layers ? effectivePlan(layers) : undefined;
    const reports = layers?.reports ?? [];
    const milestones = layers?.milestones ?? [];
    const counts = plan
      ? reportPlanCounts(plan, reports, milestones)
      : { done: 0, total: 0 };
    const nextIdx = plan
      ? firstUnreportedPlanStep(plan, reports, milestones)
      : -1;
    let next = "no plan";
    if (counts.total > 0) {
      next =
        nextIdx >= 0
          ? `next: ${itemId(plan as string, nextIdx)} ${itemText(plan as string, nextIdx)}`
          : "all done";
    }
    let cacheRead = "n/a";
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "message") continue;
      const message = entry.message as {
        role?: string;
        usage?: { input?: number; cacheRead?: number };
      };
      if (message.role === "assistant" && message.usage) {
        cacheRead = `${message.usage.cacheRead ?? 0}/${message.usage.input ?? 0}`;
        break;
      }
    }
    const layerTokens = layers
      ? estimateTextTokens(buildStrataSummary(layers))
      : 0;
    const epoch = Math.max(0, ...milestones.map((m) => m.n));
    return [
      `dir: ${dir}`,
      `mode: ${enabled ? strataMode : "off"}${paused ? " (paused)" : ""}`,
      `sysprompt: ${!enabled ? "inactive" : deferSystemPrompt ? "deferred (next compaction)" : "active"}`,
      `research: ${layers?.research ? "yes" : "no"}`,
      `plan: ${counts.done}/${counts.total} (${next})`,
      `reports: [${reports.map((r) => r.key).join(",")}]`,
      `layers: ~${layerTokens}/${rt.layerTokenBudget} tokens; epoch=${epoch}`,
      `cacheRead/input: ${cacheRead}`,
      `compactions: ok=${stats.compacted} deferred=${stats.deferred}${deferredReason ? ` (${deferredReason})` : ""}`,
      `settings: auto=${autoContinue ? "on" : "off"} anchors=${hideAnchors ? "hidden" : "shown"}`,
      `pending: ${rt.pending ? `${rt.pending.kind}:${rt.pending.stepId ?? ""}` : "none"}`,
    ].join(" | ");
  };

  // pi-lens-style widget rendering: paint the themeable segments with the
  // current theme and fit the single line to the terminal width (widgets
  // must not wrap). The setWidget factory is invoked on every update, so
  // the captured segments are always fresh; render() only applies colors.
  const renderSegments = (
    segments: WidgetSegment[],
    theme: Theme,
    width: number,
  ): string[] => {
    const paint = (seg: WidgetSegment): string => {
      if (seg.color === undefined) return seg.text;
      return theme.fg(seg.color, seg.text);
    };
    return [fitLine(segments.map(paint).join(""), width)];
  };

  // Keeps both strata widgets in sync (call this whenever the conversation
  // or the mode can have changed).
  const updateWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const layers = extractLayers(branchText(ctx));
    const dashboard =
      enabled && layers
        ? planDashboardSegments(
            effectivePlan(layers),
            layers.reports ?? [],
            layers.research !== undefined,
            layers.milestones ?? [],
          )
        : undefined;
    if (dashboard) {
      ctx.ui.setWidget("strata", (_tui, theme) => ({
        render: (width) => renderSegments(dashboard, theme, width),
        invalidate: () => {},
      }));
    } else {
      ctx.ui.setWidget("strata", undefined);
    }
    if (dashboard) {
      ctx.ui.setWidget("strata-mode", undefined);
    } else {
      const segments = modeSegments(enabled, strataMode, paused);
      ctx.ui.setWidget(
        "strata-mode",
        (_tui, theme) => ({
          render: (width) => renderSegments(segments, theme, width),
          invalidate: () => {},
        }),
        { placement: "belowEditor" },
      );
    }
  };

  const autoContinueNext = (ctx: ExtensionContext): void => {
    if (paused) return;
    try {
      const layers = extractLayers(branchText(ctx));
      const plan = layers ? effectivePlan(layers) : undefined;
      if (!layers || !plan) return;
      const idx = firstUnreportedPlanStep(
        plan,
        layers.reports ?? [],
        layers.milestones ?? [],
      );
      if (idx === -1) {
        if (ctx.hasUI)
          ctx.ui.notify("pi-strata: all plan steps completed", "info");
        return;
      }
      pi.sendUserMessage(
        `PI-STRATA: continue — execute ${itemId(plan, idx)}: "${itemText(plan, idx)}".`,
      );
    } catch {
      // The user can continue manually if the host rejects a queued message.
    }
  };

  const requestCompact = (
    ctx: ExtensionContext,
    customInstructions: string,
    onDone?: () => void,
    continueOnError = false,
  ): void => {
    if (ctx.hasUI)
      ctx.ui.notify(`pi-strata: compacting… (${customInstructions})`, "info");
    ctx.compact({
      customInstructions,
      onComplete: () => {
        deferredReason = undefined;
        if (ctx.hasUI) ctx.ui.notify("pi-strata: compaction finished", "info");
        onDone?.();
      },
      onError: (err) => {
        rt.pending = null;
        if (continueOnError && err.message !== "Compaction cancelled") {
          deferredReason = err.message;
          stats.deferred += 1;
          if (ctx.hasUI)
            ctx.ui.notify(
              `pi-strata: compaction deferred (${err.message}); continuing with the full phase in context. It will be retried at the next advance.`,
              "warning",
            );
          updateWidget(ctx);
          onDone?.();
          return;
        }
        if (ctx.hasUI)
          ctx.ui.notify(`pi-strata: compaction failed: ${err.message}`, "error");
      },
    });
  };

  // ------------------------------------------------------------------ events

  pi.on("session_start", (_event, ctx) => {
    const s = resolveStrataSettings(ctx.cwd);
    // The mode is session state: every (re)started session begins off; the
    // user opts in with /strata-on (nothing is persisted).
    enabled = false;
    strataMode = "strict";
    paused = false;
    deferSystemPrompt = false;
    autoContinue = s.autoContinue;
    hideAnchors = s.hideAnchors;

    rt.strataDir = resolveStrataDir(ctx);
    rt.pending = null;
    rt.layerTokenBudget = s.layerTokenBudget;
    compactOurs = false;
    deferredReason = undefined;
    stats.compacted = 0;
    stats.deferred = 0;

    // pi fires no "session deleted" event: collect orphaned strata dirs of
    // sessions whose .jsonl is gone (session picker or manual deletion).
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      const removed = cleanupOrphanedStrataDirs(dirname(sessionFile));
      if (removed > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `pi-strata: removed strata dirs of deleted sessions: ${removed}`,
          "info",
        );
      }
    }

    // Off is the normal session default: stay silent unless the session
    // already carries strata layers (a resumed/forked strata session — there
    // are no files to rehydrate, the layers live in the conversation) — then
    // point at /strata-on and announce the layer state.
    const layers = extractLayers(branchText(ctx));
    if (ctx.hasUI && layers && (layers.research || layers.plan)) {
      ctx.ui.notify(
        `pi-strata: strata layers found in the session, mode is off (session default) — /strata-on re-enables the pipeline. ${statusText(ctx)}`,
        "info",
      );
    }
    updateWidget(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // `/reload` replaces the extension runtime without replaying
    // `session_start` for the already open session. Rehydrate the only
    // session-scoped value lazily so the next turn still receives strata
    // instructions and can intercept compaction.
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    if (!enabled) return; // disabled: no layer-0 instructions this turn
    if (deferSystemPrompt) {
      // KV-cache guard: the standing instructions ride on the injected
      // message until the next compaction (session_compact lifts the
      // deferral) — changing the system prompt here would invalidate the
      // whole cached prefix and make the model re-read the session.
      return;
    }
    const instructions = buildStrataInstructions(rt.strataDir, strataMode);
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Compaction can also be the first event after `/reload` (for example an
    // automatic overflow compaction), before another agent turn has started.
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    if (!enabled) {
      // Disabled: fall back to pi's default compaction. Drop any stale
      // phase request so it cannot be consumed by a later compaction.
      rt.pending = null;
      return;
    }
    const result = await handleSessionBeforeCompact(event, ctx, rt);
    compactOurs = result?.compaction !== undefined;
    return result;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    const pending = rt.pending;
    if (!pending) return;
    if (!enabled) {
      // Disabled mid-phase: drop the request, no strata compaction.
      rt.pending = null;
      return;
    }
    try {
      if (!pending.boundaryId) rt.ensureBoundary?.(ctx);
    } catch (err) {
      rt.pending = null;
      if (ctx.hasUI)
        ctx.ui.notify(
          `pi-strata: could not create a phase boundary: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      return;
    }
    const continueNext = () => {
      if (autoContinue) autoContinueNext(ctx);
    };
    const label = pending.kind === "step" ? `step:${pending.stepId}` : "plan";
    requestCompact(ctx, label, continueNext, true);
  });

  // The plan/reports live in the conversation, so every finished turn (and
  // every compaction) can change what the dashboard shows.
  pi.on("turn_end", (_event, ctx) => {
    updateWidget(ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    updateWidget(ctx);
    // The compaction just rewrote the context: swapping the system prompt now
    // costs no cached prefix, so lift the KV-cache deferral — from the next
    // turn on the layer-0 instructions live in the system prompt (the
    // injected message is consumed by this or the next compaction).
    if (deferSystemPrompt) {
      deferSystemPrompt = false;
      if (ctx.hasUI)
        ctx.ui.notify(
          "pi-strata: layer-0 instructions moved to the system prompt",
          "info",
        );
    }
    const details = event.compactionEntry.details as StrataDetails | undefined;
    if (details?.strata) {
      stats.compacted += 1;
      deferredReason = undefined;
    }
    if (!ctx.hasUI) return;
    if (details?.strata) {
      ctx.ui.notify(
        `pi-strata: layers compacted (${details.strata.mode}${
          details.strata.llmSummary
            ? ", + pi summary"
            : details.strata.rawFallback
              ? ", + raw fallback"
              : ""
        }${details.strata.epoch ? `, epoch ${details.strata.epoch}` : ""})`,
        "info",
      );
    } else if (compactOurs) {
      // We returned a strata result but the saved entry does not carry our
      // details.strata marker: another extension's session_before_compact
      // handler (loaded after pi-strata) replaced it — or, when pi's default
      // ran, our result was dropped. Either way the layers are not preserved.
      const cause = event.fromExtension
        ? "another extension's session_before_compact handler (loaded after pi-strata) replaced it"
        : "pi's default summarization ran instead";
      ctx.ui.notify(
        `pi-strata: the strata summary was not used (${cause}); the strata layers are not preserved in this summary. If several extensions handle compaction, keep only one or load pi-strata last.`,
        "warning",
      );
    }
  });

  // -------------------------------------------------------------------- tool

  const StrataParams = Type.Object({
    action: StringEnum(["advance", "status"] as const),
    step: Type.Optional(
      Type.Union([Type.String(), Type.Number()], {
        description:
          'action=advance: completed plan item ID (for example "S1"). Legacy numeric positions are also accepted. Omit after a base PLAN or PLAN-DELTA.',
      }),
    ),
  });

  pi.registerTool({
    name: "strata",
    label: "Strata",
    description:
      'pi-strata: advances the layered-context phases (KV-cache). After writing a phase between STRATA:: markers, call strata(action="advance") — compaction at the end of the turn; with step=N — after completed step N. status — current layer state.',
    parameters: StrataParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "advance":
          if (!enabled)
            return toolText(
              "Error: pi-strata is disabled. Run /strata-on to enable it for this session, then call advance again.",
              true,
            );
          return actAdvance(rt, ctx, params.step);
        case "status":
          return toolText(statusText(ctx));
        default:
          return toolText("Error: unknown strata action.", true);
      }
    },
  });

  // ----------------------------------------------------------------- command

  pi.registerCommand("strata", {
    description:
      "pi-strata: status/stats; compact; pause/resume auto-continue; reset snapshots; /strata-on [strict|light]; /strata-off",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim().toLowerCase();
      if (cmd === "compact") {
        await ctx.waitForIdle();
        requestCompact(ctx, "manual");
        return;
      }
      if (cmd === "pause" || cmd === "resume") {
        if (!enabled) {
          ctx.ui.notify("pi-strata: enable the mode with /strata-on first", "error");
          return;
        }
        paused = cmd === "pause";
        updateWidget(ctx);
        ctx.ui.notify(`pi-strata: auto-continue ${paused ? "paused" : "resumed"}`, "info");
        if (!paused) {
          await ctx.waitForIdle();
          autoContinueNext(ctx);
        }
        return;
      }
      if (cmd !== "reset") {
        ctx.ui.notify(`pi-strata: ${statusText(ctx)}`, "info");
        updateWidget(ctx);
        return;
      }
      if (!ctx.hasUI || !rt.strataDir) {
        if (ctx.hasUI)
          ctx.ui.notify("pi-strata: reset requires a session and interactive mode", "error");
        return;
      }
      const ok = await ctx.ui.confirm(
        "pi-strata",
        "Delete the raw context snapshots of this session (tmp/)?",
      );
      if (!ok) return;
      rmSync(strataPaths(rt.strataDir).tmp, { recursive: true, force: true });
      ctx.ui.notify("pi-strata: snapshots cleared", "info");
    },
  });

  pi.registerCommand("strata-on", {
    description: "pi-strata: enable strict (default) or light mode for this session",
    handler: async (args, ctx) => {
      if (enabled) {
        if (ctx.hasUI) ctx.ui.notify(`pi-strata: already on (${strataMode})`, "info");
        return;
      }
      const requested = (args ?? "").trim().toLowerCase() || "strict";
      if (requested !== "strict" && requested !== "light") {
        if (ctx.hasUI)
          ctx.ui.notify("pi-strata: usage: /strata-on [strict|light]", "error");
        return;
      }
      strataMode = requested;
      if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
      enabled = true;
      paused = false;
      deferredReason = undefined;
      rt.pending = null;
      deferSystemPrompt = branchHasContext(ctx);
      updateWidget(ctx);
      const layers = extractLayers(branchText(ctx));
      const hasLayers = Boolean(layers && (layers.research || layers.plan));
      if (deferSystemPrompt) {
        pi.sendMessage(
          {
            customType: INSTRUCTIONS_CUSTOM_TYPE,
            content: buildStrataActivationMessage(rt.strataDir, strataMode),
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
      }
      if (ctx.hasUI)
        ctx.ui.notify(
          `pi-strata: ${strataMode} mode enabled${deferSystemPrompt ? " — standing instructions queued; the system prompt changes after the next compaction" : ""}.${hasLayers ? ` ${statusText(ctx)}` : ""}`,
          "info",
        );
    },
  });

  pi.registerCommand("strata-off", {
    description: "pi-strata: disable layered-context mode for this session",
    handler: async (_args, ctx) => {
      if (!enabled) {
        if (ctx.hasUI) ctx.ui.notify("pi-strata: already off", "info");
        return;
      }
      const hadContext = branchHasContext(ctx);
      enabled = false;
      paused = false;
      deferSystemPrompt = false;
      deferredReason = undefined;
      rt.pending = null;
      if (hadContext)
        pi.sendMessage(
          {
            customType: INSTRUCTIONS_CUSTOM_TYPE,
            content:
              "[pi-strata] Layered-context mode is now OFF. Previous standing pi-strata instructions are revoked; do not emit new STRATA blocks or call advance unless the user explicitly enables the mode again.",
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
      updateWidget(ctx);
      if (ctx.hasUI) ctx.ui.notify("pi-strata: disabled for this session", "info");
    },
  });
}
