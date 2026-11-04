/**
 * pi-episteme — compaction integration.
 *
 * Plan/step compactions cut at a non-context sentinel, leaving only the
 * deterministic episteme summary. Plain compactions retain pi's normal tail and
 * summarize only the ephemeral span. New layer markers are trusted exclusively
 * in assistant text and in a previous canonical episteme summary.
 */

import {
  compact as piCompact,
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  SEP,
  EPISTEME_MARKER,
  EPISTEME_VERSION,
  buildMilestoneText,
  buildEpistemeSummary,
  completedStepIds,
  epistemeSummaryBlocks,
  estimateTextTokens,
  extractLayers,
  normalizeText,
  epistemePaths,
  stripEpistemeBlocks,
  writeSnapshot,
  type EpistemeLayers,
} from "./episteme.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type ConversationMessage = Preparation["messagesToSummarize"][number];
type LlmResult = Pick<CompactionResult, "summary" | "usage">;

const FALLBACK_TAIL_CHARS = 12000;
const FALLBACK_HEADER =
  "## PI-EPISTEME RAW CHECKPOINT\nLLM summarization unavailable. This bounded raw tail preserves interrupted work; older discarded logs are omitted.";

export interface EpistemeRuntime {
  epistemeDir: string | null;
  pending: {
    kind: "plan" | "step";
    stepId?: string;
    stepN?: number;
    boundaryId?: string;
  } | null;
  layerTokenBudget?: number;
  /**
   * A phase request (plan/step) was consumed by a compaction, so the phase is
   * closed and the next plan item is owed to the model. pi can run the phase
   * compaction itself (its threshold check fires between turns, before the run
   * settles), in which case the extension never gets to queue the continuation
   * — it must not be lost with `pending`. Cleared once delivered.
   */
  continueOwed?: boolean;
  ensureBoundary?: (ctx: ExtensionContext) => string;
}

export interface EpistemeDetails {
  episteme: {
    mode: "plan" | "step" | "plain";
    version: string;
    stepN?: number;
    stepId?: string;
    reportFiles: number[];
    reportIds: string[];
    llmSummary: boolean;
    rawFallback: boolean;
    epoch?: number;
    /** Layer blocks left out of the summary because the retained tail already
     *  carries them byte-identically (no point paying for them twice). */
    dedupedWithTail?: string[];
  };
}

export type BeforeCompactResult = {
  cancel?: boolean;
  compaction?: CompactionResult<EpistemeDetails>;
};

const PLAIN_FOCUS =
  "Summarize only the ephemeral work in this conversation: tool outputs, findings, in-progress file changes, errors, and decisions not yet recorded in a step report. Preserve enough detail to resume the interrupted work. Any pi-episteme layers were removed from your input and are preserved separately.";

const MILESTONE_FOCUS =
  "Create a durable milestone digest of the completed STEP reports in this episteme conversation. Preserve facts needed by remaining plan items: changed files, verification results, decisions, constraints, risks, and unresolved issues. Do not invent progress. The extension will separately retain the completed step IDs.";

export type PlainSummarizer = (
  preparation: Preparation,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<LlmResult>;

export type MilestoneSummarizer = (
  layers: EpistemeLayers,
  preparation: Preparation,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<string>;

function cleanHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers))
    if (value !== null) out[key] = value;
  return out;
}

async function runPiSummary(
  preparation: Preparation,
  focus: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<LlmResult> {
  const model = ctx.model;
  if (!model) throw new Error("no model selected");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const result = await piCompact(
    preparation,
    model,
    auth.apiKey,
    cleanHeaders(auth.headers),
    focus,
    signal,
    ctx.thinkingLevel,
    undefined,
    auth.env,
  );
  return { summary: result.summary, usage: result.usage };
}

const defaultPlainSummarizer: PlainSummarizer = (preparation, ctx, signal) =>
  runPiSummary(preparation, PLAIN_FOCUS, ctx, signal);

const defaultMilestoneSummarizer: MilestoneSummarizer = async (
  layers,
  preparation,
  ctx,
  signal,
) => {
  const message = {
    role: "user",
    content: buildEpistemeSummary(layers),
    timestamp: Date.now(),
  } as ConversationMessage;
  const result = await runPiSummary(
    {
      ...preparation,
      messagesToSummarize: [message],
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: undefined,
    },
    MILESTONE_FOCUS,
    ctx,
    signal,
  );
  return result.summary;
};

export function previousLlmTail(
  previousSummary: string | undefined,
): string | undefined {
  if (!previousSummary) return undefined;
  const canonical = previousCanonicalSummary(previousSummary);
  if (canonical) {
    const tail = normalizeText(previousSummary.slice(canonical.length));
    return tail === "" ? undefined : tail;
  }
  return previousSummary;
}

function assistantText(messages: readonly ConversationMessage[]): string[] {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; text?: string }[]) {
      if (block.type === "text" && typeof block.text === "string")
        parts.push(block.text);
    }
  }
  return parts;
}

export function stripLayersFromMessages(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      result.push(message);
      continue;
    }
    const content = message.content;
    if (typeof content === "string") {
      const text = stripEpistemeBlocks(content);
      if (text)
        // SAFETY: only the assistant text content was narrowed/cleaned; the
        // message keeps its role, timestamp, and every other field.
        result.push({ ...message, content: text } as unknown as ConversationMessage);
      continue;
    }
    if (!Array.isArray(content)) {
      result.push(message);
      continue;
    }
    const filtered = content.flatMap((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return [block];
      const text = stripEpistemeBlocks(block.text);
      return text ? [{ ...block, text }] : [];
    });
    if (filtered.length > 0)
      result.push({ ...message, content: filtered } as ConversationMessage);
  }
  return result;
}

function previousCanonicalSummary(summary: string | undefined): string | undefined {
  if (!summary?.startsWith(EPISTEME_MARKER)) return undefined;
  let canonical: string | undefined;
  let cursor = EPISTEME_MARKER.length;
  while (summary.startsWith(SEP, cursor)) {
    const rest = summary.slice(cursor + SEP.length);
    const open = /^\/\*EPISTEME::(RESEARCH|PLAN-DELTA|PLAN|MILESTONE-\d+|STEP-[A-Za-z0-9][A-Za-z0-9_-]*)::v1\*\//.exec(rest);
    if (!open) break;
    const close = `/*EPISTEME::END::${open[1]}::v1*/`;
    const closeIndex = rest.indexOf(close, open[0].length);
    if (closeIndex < 0) break;
    const candidate = summary.slice(0, cursor + SEP.length + closeIndex + close.length);
    const layers = extractLayers(candidate);
    if (!layers || buildEpistemeSummary(layers) !== candidate) break;
    canonical = candidate;
    cursor = candidate.length;
  }
  return canonical;
}

/**
 * Canonical summary for the compacted context. A layer block whose exact
 * rendered form is still present in the messages pi is about to KEEP is left
 * out of the summary: the model would otherwise read the same STEP report
 * twice (once raw in the retained tail, once canonical in the summary). Only
 * byte-identical copies are dropped, so nothing is ever lost — the next
 * compaction folds the tail copy back into the canonical layers.
 */
function canonicalLayerSummary(
  layers: EpistemeLayers,
  keptText: string,
): { summary: string; deduped: string[] } {
  const kept = keptText ? normalizeText(keptText) : "";
  const deduped: string[] = [];
  const blocks = epistemeSummaryBlocks(layers).filter((b) => {
    if (kept && kept.includes(b.block)) {
      deduped.push(b.key);
      return false;
    }
    return true;
  });
  return {
    summary: [EPISTEME_MARKER, ...blocks.map((b) => b.block)].join(SEP),
    deduped,
  };
}

function fallbackCheckpoint(discardedSerialized: string): string | undefined {
  const clean = stripEpistemeBlocks(discardedSerialized);
  if (!clean) return undefined;
  const tail = clean.slice(-FALLBACK_TAIL_CHARS);
  return `${FALLBACK_HEADER}\n\n${tail}`;
}

async function maybeRollover(
  initial: EpistemeLayers,
  preparation: Preparation,
  ctx: ExtensionContext,
  signal: AbortSignal,
  rt: EpistemeRuntime,
  dir: string,
  summarize: MilestoneSummarizer,
): Promise<{ layers: EpistemeLayers; epoch?: number }> {
  const budget = rt.layerTokenBudget ?? 16384;
  const reports = initial.reports ?? [];
  if (
    budget === 0 ||
    reports.length === 0 ||
    estimateTextTokens(buildEpistemeSummary(initial)) <= budget
  )
    return { layers: initial };

  const epoch = Math.max(0, ...(initial.milestones ?? []).map((m) => m.n)) + 1;
  try {
    const digest = await summarize(initial, preparation, ctx, signal);
    // Archive the pre-rollover layers only once the rollover actually happened
    // — a failed summarization keeps the full reports in the layers, and a
    // stray epoch_N file would describe an epoch that never existed.
    writeSnapshot(
      join(epistemePaths(dir).tmp, `epoch_${epoch}_layers.md`),
      `epoch ${epoch} layers`,
      buildEpistemeSummary(initial),
    );
    const completed = completedStepIds(reports, initial.milestones ?? []);
    const milestone = {
      n: epoch,
      text: buildMilestoneText([...completed], digest),
      completed: [...completed],
    };
    return {
      layers: {
        ...initial,
        milestones: [...(initial.milestones ?? []), milestone],
        reports: [],
      },
      epoch,
    };
  } catch (err) {
    if (signal.aborted) throw err;
    if (ctx.hasUI)
      ctx.ui.notify(
        "pi-episteme: milestone summarization unavailable; full step reports retained",
        "warning",
      );
    return { layers: initial };
  }
}

export async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  rt: EpistemeRuntime,
  deps?: {
    summarizePlain?: PlainSummarizer;
    summarizeMilestone?: MilestoneSummarizer;
  },
): Promise<BeforeCompactResult | undefined> {
  const dir = rt.epistemeDir;
  if (!dir) return undefined;

  const { preparation, branchEntries } = event;
  const summarizePlain = deps?.summarizePlain ?? defaultPlainSummarizer;
  const summarizeMilestone = deps?.summarizeMilestone ?? defaultMilestoneSummarizer;
  const messagesToDiscard = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ];
  const discardedSerialized = serializeConversation(
    convertToLlm(messagesToDiscard),
  );

  const firstKeptIndex = branchEntries.findIndex(
    (entry: { id: string }) => entry.id === preparation.firstKeptEntryId,
  );
  const keptMessages =
    firstKeptIndex < 0
      ? []
      : branchEntries
          .slice(firstKeptIndex)
          .flatMap((entry) => sessionEntryToContextMessages(entry as never));
  const keptSerialized = serializeConversation(convertToLlm(keptMessages));
  const serialized = [discardedSerialized, keptSerialized]
    .filter((text) => text.length > 0)
    .join(SEP);

  const trustedParts = [
    previousCanonicalSummary(preparation.previousSummary),
    ...assistantText(messagesToDiscard),
    ...assistantText(keptMessages),
  ].filter((text): text is string => Boolean(text));
  let layers = extractLayers(trustedParts.join(SEP));
  if (!layers) return undefined;

  let mode: "plan" | "step" | "plain";
  let stepN: number | undefined;
  let stepId: string | undefined;
  let firstKeptEntryId = preparation.firstKeptEntryId;

  if (rt.pending?.kind === "step" || rt.pending?.kind === "plan") {
    mode = rt.pending.kind;
    stepN = rt.pending.stepN;
    stepId = rt.pending.stepId;
    const boundaryId = rt.pending.boundaryId ?? rt.ensureBoundary?.(ctx);
    if (!boundaryId) throw new Error("pi-episteme: no phase-boundary entry available");
    firstKeptEntryId = boundaryId;
    if (mode === "step") {
      const id = stepId ?? String(stepN ?? 0);
      writeSnapshot(
        join(epistemePaths(dir).tmp, `step_${id}_raw.md`),
        `step ${id}`,
        serialized,
      );
    }
  } else {
    mode = "plain";
  }

  const rollover = await maybeRollover(
    layers,
    preparation,
    ctx,
    event.signal,
    rt,
    dir,
    summarizeMilestone,
  );
  layers = rollover.layers;

  let llm: LlmResult | undefined;
  let rawFallback = false;
  if (mode === "plain") {
    try {
      llm = await summarizePlain(
        {
          ...preparation,
          messagesToSummarize: stripLayersFromMessages(preparation.messagesToSummarize),
          turnPrefixMessages: stripLayersFromMessages(preparation.turnPrefixMessages),
          previousSummary: previousLlmTail(preparation.previousSummary),
        },
        ctx,
        event.signal,
      );
    } catch (err) {
      if (event.signal.aborted) throw err;
      rawFallback = true;
      if (ctx.hasUI)
        ctx.ui.notify(
          "pi-episteme: pi summarization unavailable; preserving a bounded raw checkpoint",
          "warning",
        );
    }
  }

  const { summary: epistemeSummary, deduped } = canonicalLayerSummary(
    layers,
    assistantText(keptMessages).join(SEP),
  );
  const tail = llm
    ? normalizeText(llm.summary)
    : rawFallback
      ? fallbackCheckpoint(discardedSerialized)
      : undefined;
  const summary = tail ? `${epistemeSummary}${SEP}${tail}` : epistemeSummary;
  const details: EpistemeDetails = {
    episteme: {
      mode,
      version: EPISTEME_VERSION,
      stepN,
      stepId,
      reportFiles: (layers.reports ?? [])
        .map((r) => r.n)
        .filter((n): n is number => n !== undefined),
      reportIds: (layers.reports ?? []).map((r) => r.key),
      llmSummary: llm !== undefined,
      rawFallback,
      epoch: rollover.epoch,
      dedupedWithTail: deduped.length > 0 ? deduped : undefined,
    },
  };

  if (rt.pending) {
    // A phase compaction is done, whoever triggered it. If pi's own
    // threshold/overflow check got here first, the extension's end-of-turn
    // request (and the auto-continue it carries) never runs — leave the
    // continuation behind for `agent_settled`.
    if (mode !== "plain") rt.continueOwed = true;
    rt.pending = null;
  }
  return {
    compaction: {
      summary,
      firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage: llm?.usage,
      details,
    },
  };
}
