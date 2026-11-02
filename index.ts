/**
 * pi-episteme — layered KV-cache-friendly context management for pi-coding-agent
 * with local LLMs (llama.cpp / Ollama). See SPEC.md.
 *
 * Context layout (prompt prefix must be byte-stable across steps):
 *
 *   [Layer 0] system prompt (+ static pi-episteme instructions)
 *     [Layer 1] RESEARCH marker block (in the conversation)
 *       [Layer 2] PLAN marker block (the base plan)
 *         [Layer 3] MILESTONE and STEP-ID blocks (archived/current reports)
 *           [Layer 4] PLAN-DELTA (the full effective plan)
 *             [current] ephemeral task + tool outputs (discarded into reports)
 *
 * Layer data lives in the conversation, not in files: the model writes each
 * phase between EPISTEME:: markers, and the layers are injected as the
 * deterministic compaction summary (the extracted blocks re-emitted in fixed
 * order). After every phase compaction the prefix [system + layers] is
 * unchanged except for the replaced/appended blocks, enabling provider-side
 * KV-cache reuse when the provider supports it.
 *
 * The session episteme directory (next to the session file,
 * <session>.pi_episteme/) holds raw context snapshots (tmp/) only.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
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
import { resolveEpistemeSettings } from "./config.ts";
import {
  handleSessionBeforeCompact,
  type EpistemeDetails,
  type EpistemeRuntime,
} from "./compaction.ts";
import {
  readOrchFixRounds,
  runOrchestration,
  type OrchestrationOutcome,
} from "./orchestrator.ts";
import {
  SEP,
  EPISTEME_MARKER,
  buildEpistemeSummary,
  cleanupOrphanedEpistemeDirs,
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
  epistemePaths,
  stripEpistemeMarkersForDisplay,
  type EpistemeLayers,
  type WidgetSegment,
} from "./episteme.ts";

/**
 * customType of the standing-instructions message injected by /episteme-on in
 * a session that already carries context (KV-cache guard: the system prompt
 * must not change mid-session, so the layer-0 instructions ride on a message
 * appended at the end of the context until the next compaction).
 */
const INSTRUCTIONS_CUSTOM_TYPE = "episteme-instructions";

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, never>;
  isError?: boolean;
}

/** Render the orchestration result for the tool result / the TUI. */
function formatOrchestrationOutcome(outcome: OrchestrationOutcome): string {
  const lines = [
    `Orchestration ${outcome.ok ? "PASSED" : "FAILED"}: ${outcome.summary}`,
    `completed steps: [${outcome.completed.join(",")}]`,
  ];
  if (outcome.rounds > 0) lines.push(`corrective rounds: ${outcome.rounds}`);
  if (outcome.issues.length > 0)
    lines.push(`open issues:\n${outcome.issues.map((i) => `- ${i}`).join("\n")}`);
  return lines.join("\n");
}

const toolText = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  details: {},
  isError,
});

/** Session-scoped episteme directory: next to the session file. */
function resolveEpistemeDir(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager;
  const file = sm.getSessionFile();
  if (file) return join(dirname(file), `${basename(file, ".jsonl")}.pi_episteme`);
  return join(getAgentDir(), "episteme", sm.getSessionId());
}

/** Static per-session instructions appended to the system prompt (layer 0). */
export function buildEpistemeInstructions(
  epistemeDir: string,
  mode: "strict" | "light" = "light",
): string {
  const p = epistemePaths(epistemeDir);
  const activation =
    mode === "light"
      ? "Light mode: answer questions and complete small tasks normally, without markers. Start the full pipeline below only when a task is substantial enough to benefit from phased context."
      : "Strict mode: use the pipeline below for every implementation task. For questions, clarification, or discussion without a task, just answer without markers.";
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
 * The standing instructions delivered by /episteme-on in a session that already
 * has context: a short activation notice plus the exact layer-0 body (kept
 * byte-identical to buildEpistemeInstructions, so after the system prompt picks
 * the instructions up the model sees the same protocol it followed before).
 */
export function buildEpistemeActivationMessage(
  epistemeDir: string,
  mode: "strict" | "light",
): string {
  return (
    `[pi-episteme] Layered-context ${mode} mode is now ON for this session. ` +
    "The standing instructions below apply until /episteme-off; after the next " +
    `compaction they move into the system prompt and this message is dropped.\n\n` +
    buildEpistemeInstructions(epistemeDir, mode)
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
      entry.summary.startsWith(EPISTEME_MARKER)
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

function planAdvanceError(layers: EpistemeLayers): string | null {
  if (!layers.research) return "Error: no RESEARCH block for the current cycle.";
  if (!layers.plan || layers.planFresh === false)
    return "Error: a new RESEARCH requires a new base PLAN. Write it between /*EPISTEME::PLAN::v1*/ … /*EPISTEME::END::PLAN::v1*/ and call advance again.";
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
  prev: EpistemeLayers | undefined,
  next: EpistemeLayers,
): { key: string; n?: number; text: string }[] {
  const kept = new Set((next.reports ?? []).map((r) => `${r.key}\u0000${r.text}`));
  return (prev?.reports ?? []).filter((r) => !kept.has(`${r.key}\u0000${r.text}`));
}

function layerChangeNotice(
  prev: EpistemeLayers | undefined,
  next: EpistemeLayers,
): string {
  const dropped = droppedReports(prev, next);
  if (!dropped.length) return "";
  return ` A new RESEARCH block started a new task cycle: the previous cycle's step reports [${dropped
    .map((r) => r.key)
    .join(",")}] are no longer in the layers.`;
}

function stepAdvanceError(layers: EpistemeLayers, key: string): string | null {
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
    return `Error: no report for step ${key}. Write it between /*EPISTEME::STEP-${key}::v1*/ … /*EPISTEME::END::STEP-${key}::v1*/ and call advance again.`;
  return null;
}

function actAdvance(
  rt: EpistemeRuntime,
  ctx: ExtensionContext,
  step?: number | string,
): ToolResult {
  const layers = extractLayers(branchText(ctx));
  if (!layers)
    return toolText(
      "Error: no EPISTEME:: blocks in the conversation. Write RESEARCH/PLAN/STEP-ID blocks first.",
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
  const tmpDir = rt.epistemeDir ? epistemePaths(rt.epistemeDir).tmp : "(no session)";
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
  // Config: env (PI_EPISTEME_*) > settings.json `piEpisteme` > defaults.
  // Resolved at load time from process.cwd(); re-resolved on session_start
  // with the real project cwd.
  const initial = resolveEpistemeSettings(process.cwd());
  const rt: EpistemeRuntime = {
    epistemeDir: null,
    pending: null,
    layerTokenBudget: initial.layerTokenBudget,
  };
  let enabled = false;
  let epistemeMode: "strict" | "light" = "light";
  let paused = false;
  let deferSystemPrompt = false;
  let autoContinue = initial.autoContinue;
  let hideAnchors = initial.hideAnchors;
  let compactOurs = false;
  let deferredReason: string | undefined;
  const stats = { compacted: 0, deferred: 0 };
  let orchestrationActive = false;
  rt.ensureBoundary = (ctx) => {
    pi.appendEntry("episteme-phase-boundary", {
      kind: rt.pending?.kind,
      stepId: rt.pending?.stepId,
    });
    const id = ctx.sessionManager.getLeafId();
    if (!id) throw new Error("pi-episteme: failed to append a phase boundary");
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
          : `${theme.fg("accent", "episteme")} ${theme.fg(
              "dim",
              "standing instructions attached (move to the system prompt after the next compaction)",
            )}`;
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(line, 0, 0));
      return box;
    },
  );

  // Display-only: hide the EPISTEME marker anchors in the TUI transcript
  // (config hideAnchors, default on; re-resolved on session_start). pi's
  // markdown transformer runs before rendering (assistant text and
  // thinking, streaming and final, new and restored messages); the session
  // and the model context keep the raw markers, so extraction is
  // unaffected. User messages are passed through untouched.
  pi.registerMarkdownTransformer((markdown, { messageType }) =>
    hideAnchors && messageType !== "user"
      ? stripEpistemeMarkersForDisplay(markdown)
      : markdown,
  );

  const statusText = (ctx: ExtensionContext): string => {
    const dir = rt.epistemeDir ?? "(no session)";
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
      ? estimateTextTokens(buildEpistemeSummary(layers))
      : 0;
    const epoch = Math.max(0, ...milestones.map((m) => m.n));
    return [
      `dir: ${dir}`,
      `mode: ${enabled ? epistemeMode : "off"}${paused ? " (paused)" : ""}`,
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

  // Keeps both episteme widgets in sync (call this whenever the conversation
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
      ctx.ui.setWidget("episteme", (_tui, theme) => ({
        render: (width) => renderSegments(dashboard, theme, width),
        invalidate: () => {},
      }));
    } else {
      ctx.ui.setWidget("episteme", undefined);
    }
    if (dashboard) {
      ctx.ui.setWidget("episteme-mode", undefined);
    } else {
      const segments = modeSegments(enabled, epistemeMode, paused);
      ctx.ui.setWidget(
        "episteme-mode",
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
          ctx.ui.notify("pi-episteme: all plan steps completed", "info");
        return;
      }
      pi.sendUserMessage(
        `PI-EPISTEME: continue — execute ${itemId(plan, idx)}: "${itemText(plan, idx)}".`,
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
      ctx.ui.notify(`pi-episteme: compacting… (${customInstructions})`, "info");
    ctx.compact({
      customInstructions,
      onComplete: () => {
        deferredReason = undefined;
        if (ctx.hasUI) ctx.ui.notify("pi-episteme: compaction finished", "info");
        onDone?.();
      },
      onError: (err) => {
        rt.pending = null;
        if (continueOnError && err.message !== "Compaction cancelled") {
          deferredReason = err.message;
          stats.deferred += 1;
          if (ctx.hasUI)
            ctx.ui.notify(
              `pi-episteme: compaction deferred (${err.message}); continuing with the full phase in context. It will be retried at the next advance.`,
              "warning",
            );
          updateWidget(ctx);
          onDone?.();
          return;
        }
        if (ctx.hasUI)
          ctx.ui.notify(`pi-episteme: compaction failed: ${err.message}`, "error");
      },
    });
  };

  const orchestrateTask = async (
    task: string,
    ctx: ExtensionContext,
    toolSignal?: AbortSignal,
  ): Promise<ToolResult> => {
    if (orchestrationActive)
      return toolText("Error: an orchestration is already running.", true);
    const model = ctx.model;
    if (!model) return toolText("Error: no model selected.", true);
    orchestrationActive = true;
    const notify = (phase: string): void => {
      if (ctx.hasUI)
        ctx.ui.notify(`pi-episteme orchestration: ${phase}`, "info");
    };
    try {
      const outcome = await runOrchestration(
        task,
        {
          // Chat-only round (Manager planning/fixes): one provider call with
          // the byte-stable prefix as the system prompt (see context.ts).
          callModel: async (call, signal) => {
            const message = await ctx.modelRegistry.complete(
              model,
              {
                systemPrompt: call.systemPrompt,
                messages: [
                  {
                    role: "user",
                    content: call.message,
                    timestamp: Date.now(),
                  },
                ],
              },
              {
                signal,
                ...(ctx.thinkingLevel
                  ? { reasoning: ctx.thinkingLevel }
                  : {}),
              },
            );
            return message.content
              .filter(
                (c): c is { type: "text"; text: string } =>
                  c.type === "text" && typeof c.text === "string",
              )
              .map((c) => c.text)
              .join("\n");
          },
          // Tool-using round (Worker / Verifier): an independent in-memory
          // agent session. No extensions/skills/templates are loaded into the
          // worker (noExtensions) so the run cannot recurse into pi-episteme;
          // the byte-stable prefix becomes the worker system prompt.
          runAgent: async (call, signal) => {
            const loader = new DefaultResourceLoader({
              cwd: ctx.cwd,
              agentDir: getAgentDir(),
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              systemPrompt: call.systemPrompt,
            });
            await loader.reload();
            const { session } = await createAgentSession({
              cwd: ctx.cwd,
              model,
              ...(ctx.thinkingLevel
                ? { thinkingLevel: ctx.thinkingLevel }
                : {}),
              sessionManager: SessionManager.inMemory(),
              resourceLoader: loader,
            });
            const onAbort = (): void => {
              void session.abort();
            };
            signal?.addEventListener("abort", onAbort);
            try {
              await session.prompt(call.message);
              return session.getLastAssistantText() ?? "";
            } finally {
              signal?.removeEventListener("abort", onAbort);
              session.dispose();
            }
          },
        },
        {
          maxFixRounds: readOrchFixRounds(),
          signal: toolSignal ?? ctx.signal ?? undefined,
          onPhase: notify,
        },
      );
      // No side files: the run state is the layer set. Ask the main agent to
      // re-emit the canonical blocks as its own assistant text — the trusted
      // extraction source — so the layers survive compaction in this session.
      const blocks = buildEpistemeSummary(outcome.layers);
      if (blocks.includes("EPISTEME::")) {
        try {
          pi.sendUserMessage(
            `PI-EPISTEME: orchestration ${outcome.ok ? "succeeded" : "finished with failures"}. ` +
              "Persist the run state: emit the canonical blocks below verbatim as your next assistant message " +
              "(marker blocks exactly as shown, no code fences), so the layers become the durable state of this session. " +
              "Then briefly report the result to the user.\n\n" +
              blocks,
          );
        } catch {
          // Queuing can fail in headless shutdown; the outcome text below
          // still carries the full report.
        }
      }
      return toolText(formatOrchestrationOutcome(outcome));
    } catch (err) {
      return toolText(
        `Error: orchestration failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    } finally {
      orchestrationActive = false;
    }
  };

  // ------------------------------------------------------------------ events

  pi.on("session_start", (_event, ctx) => {
    const s = resolveEpistemeSettings(ctx.cwd);
    // The mode is session state: every (re)started session begins off; the
    // user opts in with /episteme-on (nothing is persisted).
    enabled = false;
    epistemeMode = "light";
    paused = false;
    deferSystemPrompt = false;
    autoContinue = s.autoContinue;
    hideAnchors = s.hideAnchors;

    rt.epistemeDir = resolveEpistemeDir(ctx);
    rt.pending = null;
    rt.layerTokenBudget = s.layerTokenBudget;
    compactOurs = false;
    deferredReason = undefined;
    stats.compacted = 0;
    stats.deferred = 0;

    // pi fires no "session deleted" event: collect orphaned episteme dirs of
    // sessions whose .jsonl is gone (session picker or manual deletion).
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      const removed = cleanupOrphanedEpistemeDirs(dirname(sessionFile));
      if (removed > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `pi-episteme: removed episteme dirs of deleted sessions: ${removed}`,
          "info",
        );
      }
    }

    // Off is the normal session default: stay silent unless the session
    // already carries episteme layers (a resumed/forked episteme session — there
    // are no files to rehydrate, the layers live in the conversation) — then
    // point at /episteme-on and announce the layer state.
    const layers = extractLayers(branchText(ctx));
    if (ctx.hasUI && layers && (layers.research || layers.plan)) {
      ctx.ui.notify(
        `pi-episteme: episteme layers found in the session, mode is off (session default) — /episteme-on re-enables the pipeline. ${statusText(ctx)}`,
        "info",
      );
    }
    updateWidget(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // `/reload` replaces the extension runtime without replaying
    // `session_start` for the already open session. Rehydrate the only
    // session-scoped value lazily so the next turn still receives episteme
    // instructions and can intercept compaction.
    if (!rt.epistemeDir) rt.epistemeDir = resolveEpistemeDir(ctx);
    if (!enabled) return; // disabled: no layer-0 instructions this turn
    if (deferSystemPrompt) {
      // KV-cache guard: the standing instructions ride on the injected
      // message until the next compaction (session_compact lifts the
      // deferral) — changing the system prompt here would invalidate the
      // whole cached prefix and make the model re-read the session.
      return;
    }
    const instructions = buildEpistemeInstructions(rt.epistemeDir, epistemeMode);
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Compaction can also be the first event after `/reload` (for example an
    // automatic overflow compaction), before another agent turn has started.
    if (!rt.epistemeDir) rt.epistemeDir = resolveEpistemeDir(ctx);
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
    if (!rt.epistemeDir) rt.epistemeDir = resolveEpistemeDir(ctx);
    const pending = rt.pending;
    if (!pending) return;
    if (!enabled) {
      // Disabled mid-phase: drop the request, no episteme compaction.
      rt.pending = null;
      return;
    }
    try {
      if (!pending.boundaryId) rt.ensureBoundary?.(ctx);
    } catch (err) {
      rt.pending = null;
      if (ctx.hasUI)
        ctx.ui.notify(
          `pi-episteme: could not create a phase boundary: ${err instanceof Error ? err.message : String(err)}`,
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
          "pi-episteme: layer-0 instructions moved to the system prompt",
          "info",
        );
    }
    const details = event.compactionEntry.details as EpistemeDetails | undefined;
    if (details?.episteme) {
      stats.compacted += 1;
      deferredReason = undefined;
    }
    if (!ctx.hasUI) return;
    if (details?.episteme) {
      ctx.ui.notify(
        `pi-episteme: layers compacted (${details.episteme.mode}${
          details.episteme.llmSummary
            ? ", + pi summary"
            : details.episteme.rawFallback
              ? ", + raw fallback"
              : ""
        }${details.episteme.epoch ? `, epoch ${details.episteme.epoch}` : ""})`,
        "info",
      );
    } else if (compactOurs) {
      // We returned a episteme result but the saved entry does not carry our
      // details.episteme marker: another extension's session_before_compact
      // handler (loaded after pi-episteme) replaced it — or, when pi's default
      // ran, our result was dropped. Either way the layers are not preserved.
      const cause = event.fromExtension
        ? "another extension's session_before_compact handler (loaded after pi-episteme) replaced it"
        : "pi's default summarization ran instead";
      ctx.ui.notify(
        `pi-episteme: the episteme summary was not used (${cause}); the episteme layers are not preserved in this summary. If several extensions handle compaction, keep only one or load pi-episteme last.`,
        "warning",
      );
    }
  });

  // -------------------------------------------------------------------- tool

  const EpistemeParams = Type.Object({
    action: StringEnum(["advance", "status", "orchestrate"] as const),
    step: Type.Optional(
      Type.Union([Type.String(), Type.Number()], {
        description:
          'action=advance: completed plan item ID (for example "S1"). Legacy numeric positions are also accepted. Omit after a base PLAN or PLAN-DELTA.',
      }),
    ),
    task: Type.Optional(
      Type.String({
        description:
          'action=orchestrate: the full task for the GVS-style pipeline (Manager → Workers → Verifier). The pipeline runs file-less: its state lives in the Episteme layers.',
      }),
    ),
  });

  pi.registerTool({
    name: "episteme",
    label: "Episteme",
    description:
      'pi-episteme: advances the layered-context phases (KV-cache). After writing a phase between EPISTEME:: markers, call episteme(action="advance") — compaction at the end of the turn; with step=N — after completed step N. status — current layer state. orchestrate — run the file-less Manager → Worker → Verifier pipeline for a complex task (param: task).',
    parameters: EpistemeParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      switch (params.action) {
        case "advance":
          if (!enabled)
            return toolText(
              "Error: pi-episteme is disabled. Run /episteme-on to enable it for this session, then call advance again.",
              true,
            );
          return actAdvance(rt, ctx, params.step);
        case "status":
          return toolText(statusText(ctx));
        case "orchestrate": {
          const task = (params.task ?? "").trim();
          if (!task)
            return toolText(
              'Error: action=orchestrate requires the task parameter (the full task description).',
              true,
            );
          return orchestrateTask(task, ctx, signal);
        }
        default:
          return toolText("Error: unknown episteme action.", true);
      }
    },
  });

  // ----------------------------------------------------------------- command

  pi.registerCommand("episteme-orchestrate", {
    description:
      "pi-episteme: run the file-less GVS-style pipeline (Manager → Workers → Verifier) for a complex task",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify(
          "pi-episteme: usage: /episteme-orchestrate <task description>",
          "error",
        );
        return;
      }
      await ctx.waitForIdle();
      const result = await orchestrateTask(task, ctx);
      const text = result.content.map((c) => c.text).join("\n");
      ctx.ui.notify(`pi-episteme: ${text}`, result.isError ? "error" : "info");
    },
  });

  pi.registerCommand("episteme", {
    description:
      "pi-episteme: status/stats; compact; pause/resume auto-continue; reset snapshots; /episteme-on [strict|light]; /episteme-off",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim().toLowerCase();
      if (cmd === "compact") {
        await ctx.waitForIdle();
        requestCompact(ctx, "manual");
        return;
      }
      if (cmd === "pause" || cmd === "resume") {
        if (!enabled) {
          ctx.ui.notify("pi-episteme: enable the mode with /episteme-on first", "error");
          return;
        }
        paused = cmd === "pause";
        updateWidget(ctx);
        ctx.ui.notify(`pi-episteme: auto-continue ${paused ? "paused" : "resumed"}`, "info");
        if (!paused) {
          await ctx.waitForIdle();
          autoContinueNext(ctx);
        }
        return;
      }
      if (cmd !== "reset") {
        ctx.ui.notify(`pi-episteme: ${statusText(ctx)}`, "info");
        updateWidget(ctx);
        return;
      }
      if (!ctx.hasUI || !rt.epistemeDir) {
        if (ctx.hasUI)
          ctx.ui.notify("pi-episteme: reset requires a session and interactive mode", "error");
        return;
      }
      const ok = await ctx.ui.confirm(
        "pi-episteme",
        "Delete the raw context snapshots of this session (tmp/)?",
      );
      if (!ok) return;
      rmSync(epistemePaths(rt.epistemeDir).tmp, { recursive: true, force: true });
      ctx.ui.notify("pi-episteme: snapshots cleared", "info");
    },
  });

  pi.registerCommand("episteme-on", {
    description: "pi-episteme: enable light (default) or strict mode for this session",
    handler: async (args, ctx) => {
      const requested = (args ?? "").trim().toLowerCase() || "light";
      if (requested !== "strict" && requested !== "light") {
        if (ctx.hasUI)
          ctx.ui.notify("pi-episteme: usage: /episteme-on [strict|light]", "error");
        return;
      }
      if (enabled) {
        if (requested === epistemeMode) {
          if (ctx.hasUI) ctx.ui.notify(`pi-episteme: already on (${epistemeMode})`, "info");
          return;
        }
        // Switch mode without a full off/on cycle. With the instructions in
        // the system prompt the next turn picks the new mode up automatically
        // (the same cache-invalidation cost as /episteme-off); while they
        // ride on the injected message, supersede them in place.
        const previous = epistemeMode;
        epistemeMode = requested;
        if (!rt.epistemeDir) rt.epistemeDir = resolveEpistemeDir(ctx);
        if (deferSystemPrompt) {
          pi.sendMessage(
            {
              customType: INSTRUCTIONS_CUSTOM_TYPE,
              content:
                `[pi-episteme] Mode switched: ${previous} → ${epistemeMode}. ` +
                "The standing instructions below supersede the earlier activation; " +
                "the previous set no longer applies.\n\n" +
                buildEpistemeActivationMessage(rt.epistemeDir, epistemeMode),
              display: true,
            },
            { deliverAs: "nextTurn" },
          );
        }
        updateWidget(ctx);
        if (ctx.hasUI)
          ctx.ui.notify(`pi-episteme: switched to ${epistemeMode} mode`, "info");
        return;
      }
      epistemeMode = requested;
      if (!rt.epistemeDir) rt.epistemeDir = resolveEpistemeDir(ctx);
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
            content: buildEpistemeActivationMessage(rt.epistemeDir, epistemeMode),
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
      }
      if (ctx.hasUI)
        ctx.ui.notify(
          `pi-episteme: ${epistemeMode} mode enabled${deferSystemPrompt ? " — standing instructions queued; the system prompt changes after the next compaction" : ""}.${hasLayers ? ` ${statusText(ctx)}` : ""}`,
          "info",
        );
    },
  });

  pi.registerCommand("episteme-off", {
    description: "pi-episteme: disable layered-context mode for this session",
    handler: async (_args, ctx) => {
      if (!enabled) {
        if (ctx.hasUI) ctx.ui.notify("pi-episteme: already off", "info");
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
              "[pi-episteme] Layered-context mode is now OFF. Previous standing pi-episteme instructions are revoked; do not emit new EPISTEME blocks or call advance unless the user explicitly enables the mode again.",
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
      updateWidget(ctx);
      if (ctx.hasUI) ctx.ui.notify("pi-episteme: disabled for this session", "info");
    },
  });
}
