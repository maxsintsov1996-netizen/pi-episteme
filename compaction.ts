/**
 * pi-strata — compaction integration.
 *
 * Plan/step compactions cut at a non-context sentinel, leaving only the
 * deterministic strata summary. Plain compactions retain pi's normal tail and
 * summarize only the ephemeral span. New layer markers are trusted exclusively
 * in assistant text and in a previous canonical strata summary.
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
  STRATA_MARKER,
  STRATA_VERSION,
  buildMilestoneText,
  buildStrataSummary,
  completedStepIds,
  estimateTextTokens,
  extractLayers,
  normalizeText,
  strataPaths,
  stripStrataBlocks,
  writeSnapshot,
  type StrataLayers,
} from "./strata.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type ConversationMessage = Preparation["messagesToSummarize"][number];
type LlmResult = Pick<CompactionResult, "summary" | "usage">;

const FALLBACK_TAIL_CHARS = 12000;
const FALLBACK_HEADER =
  "## PI-STRATA RAW CHECKPOINT\nLLM summarization unavailable. This bounded raw tail preserves interrupted work; older discarded logs are omitted.";

export interface StrataRuntime {
  strataDir: string | null;
  pending: {
    kind: "plan" | "step";
    stepId?: string;
    stepN?: number;
    boundaryId?: string;
  } | null;
  layerTokenBudget?: number;
  ensureBoundary?: (ctx: ExtensionContext) => string;
}

export interface StrataDetails {
  strata: {
    mode: "plan" | "step" | "plain";
    version: string;
    stepN?: number;
    stepId?: string;
    reportFiles: number[];
    reportIds: string[];
    llmSummary: boolean;
    rawFallback: boolean;
    epoch?: number;
  };
}

export type BeforeCompactResult = {
  cancel?: boolean;
  compaction?: CompactionResult<StrataDetails>;
};

const PLAIN_FOCUS =
  "Summarize only the ephemeral work in this conversation: tool outputs, findings, in-progress file changes, errors, and decisions not yet recorded in a step report. Preserve enough detail to resume the interrupted work. Any pi-strata layers were removed from your input and are preserved separately.";

const MILESTONE_FOCUS =
  "Create a durable milestone digest of the completed STEP reports in this strata conversation. Preserve facts needed by remaining plan items: changed files, verification results, decisions, constraints, risks, and unresolved issues. Do not invent progress. The extension will separately retain the completed step IDs.";

export type PlainSummarizer = (
  preparation: Preparation,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<LlmResult>;

export type MilestoneSummarizer = (
  layers: StrataLayers,
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
    content: buildStrataSummary(layers),
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
      const text = stripStrataBlocks(content);
      if (text)
        result.push({ ...message, content: text } as unknown as ConversationMessage);
      continue;
    }
    if (!Array.isArray(content)) {
      result.push(message);
      continue;
    }
    const filtered = content.flatMap((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return [block];
      const text = stripStrataBlocks(block.text);
      return text ? [{ ...block, text }] : [];
    });
    if (filtered.length > 0)
      result.push({ ...message, content: filtered } as ConversationMessage);
  }
  return result;
}

function previousCanonicalSummary(summary: string | undefined): string | undefined {
  if (!summary?.startsWith(STRATA_MARKER)) return undefined;
  let canonical: string | undefined;
  let cursor = STRATA_MARKER.length;
  while (summary.startsWith(SEP, cursor)) {
    const rest = summary.slice(cursor + SEP.length);
    const open = /^\/\*STRATA::(RESEARCH|PLAN-DELTA|PLAN|MILESTONE-\d+|STEP-[A-Za-z0-9][A-Za-z0-9_-]*)::v1\*\//.exec(rest);
    if (!open) break;
    const close = `/*STRATA::END::${open[1]}::v1*/`;
    const closeIndex = rest.indexOf(close, open[0].length);
    if (closeIndex < 0) break;
    const candidate = summary.slice(0, cursor + SEP.length + closeIndex + close.length);
    const layers = extractLayers(candidate);
    if (!layers || buildStrataSummary(layers) !== candidate) break;
    canonical = candidate;
    cursor = candidate.length;
  }
  return canonical;
}

function fallbackCheckpoint(discardedSerialized: string): string | undefined {
  const clean = stripStrataBlocks(discardedSerialized);
  if (!clean) return undefined;
  const tail = clean.slice(-FALLBACK_TAIL_CHARS);
  return `${FALLBACK_HEADER}\n\n${tail}`;
}

async function maybeRollover(
  initial: StrataLayers,
  preparation: Preparation,
  ctx: ExtensionContext,
  signal: AbortSignal,
  rt: StrataRuntime,
  dir: string,
  summarize: MilestoneSummarizer,
): Promise<{ layers: StrataLayers; epoch?: number }> {
  const budget = rt.layerTokenBudget ?? 16384;
  const reports = initial.reports ?? [];
  if (
    budget === 0 ||
    reports.length === 0 ||
    estimateTextTokens(buildStrataSummary(initial)) <= budget
  )
    return { layers: initial };

  const epoch = Math.max(0, ...(initial.milestones ?? []).map((m) => m.n)) + 1;
  writeSnapshot(
    join(strataPaths(dir).tmp, `epoch_${epoch}_layers.md`),
    `epoch ${epoch} layers`,
    buildStrataSummary(initial),
  );
  try {
    const digest = await summarize(initial, preparation, ctx, signal);
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
        "pi-strata: milestone summarization unavailable; full step reports retained",
        "warning",
      );
    return { layers: initial };
  }
}

export async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  rt: StrataRuntime,
  deps?: {
    summarizePlain?: PlainSummarizer;
    summarizeMilestone?: MilestoneSummarizer;
  },
): Promise<BeforeCompactResult | undefined> {
  const dir = rt.strataDir;
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
    if (!boundaryId) throw new Error("pi-strata: no phase-boundary entry available");
    firstKeptEntryId = boundaryId;
    if (mode === "step") {
      const id = stepId ?? String(stepN ?? 0);
      writeSnapshot(
        join(strataPaths(dir).tmp, `step_${id}_raw.md`),
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
          "pi-strata: pi summarization unavailable; preserving a bounded raw checkpoint",
          "warning",
        );
    }
  }

  const strataSummary = buildStrataSummary(layers);
  const tail = llm
    ? normalizeText(llm.summary)
    : rawFallback
      ? fallbackCheckpoint(discardedSerialized)
      : undefined;
  const summary = tail ? `${strataSummary}${SEP}${tail}` : strataSummary;
  const details: StrataDetails = {
    strata: {
      mode,
      version: STRATA_VERSION,
      stepN,
      stepId,
      reportFiles: (layers.reports ?? [])
        .map((r) => r.n)
        .filter((n): n is number => n !== undefined),
      reportIds: (layers.reports ?? []).map((r) => r.key),
      llmSummary: llm !== undefined,
      rawFallback,
      epoch: rollover.epoch,
    },
  };

  if (rt.pending) rt.pending = null;
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
