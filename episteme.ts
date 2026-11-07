// pi-episteme — core episteme logic.
//
// Phase data lives in the conversation. The model writes marker blocks and
// the extension folds them into a deterministic summary. New plans use stable
// item IDs; numeric STEP-N blocks remain supported for existing sessions.
//
// Canonical summary order:
//   RESEARCH → PLAN → MILESTONE-N → STEP-ID → PLAN-DELTA
//
// A new RESEARCH starts a cycle and clears every later layer. A PLAN-DELTA is
// a full effective-plan snapshot placed after the reports, so status updates
// do not rewrite the base PLAN. MILESTONE-N blocks archive completed reports
// when the permanent layer budget is exceeded.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const EPISTEME_VERSION = "v1";
export const EPISTEME_MARKER = `## PI-EPISTEME CONTEXT (${EPISTEME_VERSION})`;
export const SEP = "\n\n";

export function normalizeText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export function estimateTextTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ---------------------------------------------------------------------------
// Marker blocks
// ---------------------------------------------------------------------------

export interface EpistemeBlock {
  key: string;
  stepN?: number;
  milestoneN?: number;
  text: string;
}

export function epistemeBlock(key: string, body: string): string {
  return `/*EPISTEME::${key}::v1*/\n${normalizeText(body)}\n/*EPISTEME::END::${key}::v1*/`;
}

const BLOCK_SOURCE =
  /\/\*EPISTEME::(RESEARCH|PLAN-DELTA|PLAN|MILESTONE-(\d+)|STEP-([A-Za-z0-9][A-Za-z0-9_-]*))::v1\*\/([\s\S]*?)\/\*EPISTEME::END::\1::v1\*\//g;

export function extractEpistemeBlocks(text: string): EpistemeBlock[] {
  const re = new RegExp(BLOCK_SOURCE.source, "g");
  const blocks: EpistemeBlock[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const key = m[1];
    const body = normalizeText(m[4]);
    if (body.length === 0) continue;
    if (body.includes(`/*EPISTEME::${key}::v1*/`)) continue;
    const rawStep = m[3];
    const stepN =
      rawStep && /^\d+$/.test(rawStep) && Number.isSafeInteger(Number(rawStep))
        ? Number(rawStep)
        : undefined;
    blocks.push({
      key,
      stepN,
      milestoneN: m[2] === undefined ? undefined : Number(m[2]),
      text: body,
    });
  }
  return blocks;
}

export function stripEpistemeBlocks(text: string): string {
  return normalizeText(text.replace(new RegExp(BLOCK_SOURCE.source, "g"), ""));
}

export interface StepReport {
  key: string;
  n?: number;
  text: string;
}

export interface Milestone {
  n: number;
  text: string;
  completed: string[];
}

export interface EpistemeLayers {
  research?: string;
  plan?: string;
  planDelta?: string;
  /** False after a RESEARCH until a new base PLAN is emitted. */
  planFresh?: boolean;
  reports?: StepReport[];
  milestones?: Milestone[];
}

export function parseMilestoneCompleted(text: string): string[] {
  const match = text.match(/^Completed-Steps:[ \t]*(.*)$/m);
  if (!match) return [];
  return [...new Set(match[1].split(",").map((id) => id.trim()).filter(Boolean))];
}

export function buildMilestoneText(
  completed: readonly string[],
  digest: string,
): string {
  return `Completed-Steps: ${[...new Set(completed)].join(",")}\n\n${normalizeText(digest)}`;
}

export function blocksToLayers(
  blocks: EpistemeBlock[],
): EpistemeLayers | undefined {
  if (blocks.length === 0) return undefined;
  const layers: EpistemeLayers = { planFresh: false };
  let reports: StepReport[] = [];
  let milestones: Milestone[] = [];
  for (const b of blocks) {
    if (b.key === "RESEARCH") {
      layers.research = b.text;
      layers.plan = undefined;
      layers.planDelta = undefined;
      layers.planFresh = false;
      reports = [];
      milestones = [];
    } else if (b.key === "PLAN") {
      layers.plan = b.text;
      layers.planDelta = undefined;
      layers.planFresh = true;
    } else if (b.key === "PLAN-DELTA") {
      layers.planDelta = b.text;
    } else if (b.key.startsWith("STEP-")) {
      const key = b.key.slice(5);
      const i = reports.findIndex((r) => r.key === key);
      if (i >= 0) reports[i] = { key, n: b.stepN, text: b.text };
      else reports.push({ key, n: b.stepN, text: b.text });
    } else if (b.milestoneN !== undefined) {
      const milestone = {
        n: b.milestoneN,
        text: b.text,
        completed: parseMilestoneCompleted(b.text),
      };
      const i = milestones.findIndex((m) => m.n === b.milestoneN);
      if (i >= 0) milestones[i] = milestone;
      else milestones.push(milestone);
    }
  }
  reports.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  milestones.sort((a, b) => a.n - b.n);
  layers.reports = reports;
  layers.milestones = milestones;
  return layers;
}

export function extractLayers(text: string): EpistemeLayers | undefined {
  return blocksToLayers(extractEpistemeBlocks(text));
}

export function effectivePlan(layers: EpistemeLayers): string | undefined {
  return layers.planDelta ?? layers.plan;
}

/** The canonical blocks of a summary, in canonical order, rendered. */
export interface EpistemeSummaryBlock {
  key: string;
  block: string;
}

export function epistemeSummaryBlocks(
  layers: EpistemeLayers,
): EpistemeSummaryBlock[] {
  const out: EpistemeSummaryBlock[] = [];
  const push = (key: string, body: string): void => {
    out.push({ key, block: epistemeBlock(key, body) });
  };
  if (layers.research) push("RESEARCH", layers.research);
  if (layers.plan) push("PLAN", layers.plan);
  for (const m of layers.milestones ?? []) push(`MILESTONE-${m.n}`, m.text);
  for (const r of layers.reports ?? []) push(`STEP-${r.key ?? String(r.n)}`, r.text);
  if (layers.planDelta) push("PLAN-DELTA", layers.planDelta);
  return out;
}

export function buildEpistemeSummary(layers: EpistemeLayers): string {
  return [
    EPISTEME_MARKER,
    ...epistemeSummaryBlocks(layers).map((b) => b.block),
  ].join(SEP);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function stripEpistemeMarkersForDisplay(md: string): string {
  return md
    .replace(
      /(^|\n)[ \t]*\/\*EPISTEME::(?:END::)?(?:RESEARCH|PLAN-DELTA|PLAN|MILESTONE-\d+|STEP-[A-Za-z0-9][A-Za-z0-9_-]*)::v1\*\/[ \t]*\n/g,
      "$1",
    )
    .replace(
      /\/\*EPISTEME::(?:END::)?(?:RESEARCH|PLAN-DELTA|PLAN|MILESTONE-\d+|STEP-[A-Za-z0-9][A-Za-z0-9_-]*)::v1\*\//g,
      "",
    );
}

// ---------------------------------------------------------------------------
// Plan and completion state
// ---------------------------------------------------------------------------

// An item is a TOP-LEVEL bullet only. The plan drives progress tracking, and
// every item must eventually carry a STEP report: if indented sub-bullets or
// lines inside a code fence became items, a model that nests its plan would
// get phantom items it can never report on, and advance would deadlock.
const PLAN_ITEM_RE =
  /^[-*+]+\s+(?:\[([ xX])\]\s+)?(?:\[id:([A-Za-z0-9][A-Za-z0-9_-]*)\]\s+)?(.*)$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const INDENTED_TEXT_RE = /^[ \t]+\S/;
const INDENTED_BULLET_RE = /^[ \t]*[-*+]\s/;

export interface PlanItem {
  id: string;
  text: string;
  done: boolean;
  explicitId: boolean;
}

export function parsePlan(md: string): PlanItem[] {
  const items: PlanItem[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = PLAN_ITEM_RE.exec(line);
    if (m) {
      items.push({
        id: m[2] ?? String(items.length + 1),
        text: m[3].trim(),
        done: m[1]?.toLowerCase() === "x",
        explicitId: m[2] !== undefined,
      });
      continue;
    }
    // An indented, non-bullet line is a soft wrap of the previous item.
    if (!INDENTED_TEXT_RE.test(line) || INDENTED_BULLET_RE.test(line)) continue;
    const last = items.at(-1);
    const continuation = line.trim();
    if (last && continuation)
      last.text = `${last.text} ${continuation}`.trim();
  }
  return items;
}

export function planIdError(md: string): string | null {
  const items = parsePlan(md);
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.text) return `Plan item ${item.id} has no action.`;
    if (seen.has(item.id)) return `Duplicate plan item ID: ${item.id}.`;
    seen.add(item.id);
  }
  return null;
}

export function itemText(md: string, index: number): string | undefined {
  return parsePlan(md)[index]?.text;
}

export function itemId(md: string, index: number): string | undefined {
  return parsePlan(md)[index]?.id;
}

type ReportRef = { key?: string; n?: number };
type MilestoneRef = { completed: readonly string[] };

const reportKey = (report: ReportRef): string =>
  report.key ?? String(report.n);

export function completedStepIds(
  reports: readonly ReportRef[] = [],
  milestones: readonly MilestoneRef[] = [],
): Set<string> {
  const completed = new Set<string>();
  for (const milestone of milestones)
    for (const id of milestone.completed) completed.add(id);
  for (const report of reports) completed.add(reportKey(report));
  return completed;
}

/**
 * The IDs a rollover archives in a NEW milestone: the reported IDs that no
 * earlier MILESTONE already covers. Progress, step unlocking and completed-item
 * immutability all read `completedStepIds`, which unions every milestone, so a
 * per-epoch list loses nothing — while a cumulative one re-paid the same IDs in
 * every later epoch (quadratic growth of the permanent layer).
 */
export function newlyArchivedStepIds(
  reports: readonly ReportRef[] = [],
  milestones: readonly MilestoneRef[] = [],
): string[] {
  const alreadyArchived = completedStepIds([], milestones);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const report of reports) {
    const key = reportKey(report);
    if (alreadyArchived.has(key) || seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
  }
  return ids;
}

export function reportPlanCounts(
  md: string,
  reports: readonly ReportRef[],
  milestones: readonly MilestoneRef[] = [],
): { done: number; total: number } {
  const items = parsePlan(md);
  const completed = completedStepIds(reports, milestones);
  return {
    done: items.filter((item) => completed.has(item.id)).length,
    total: items.length,
  };
}

export function firstUnreportedPlanStep(
  md: string,
  reports: readonly ReportRef[],
  milestones: readonly MilestoneRef[] = [],
): number {
  const completed = completedStepIds(reports, milestones);
  return parsePlan(md).findIndex((item) => !completed.has(item.id));
}

export function planChangeError(
  prev: EpistemeLayers | undefined,
  next: EpistemeLayers,
): string | null {
  const prevPlan = prev ? effectivePlan(prev) : undefined;
  const nextPlan = effectivePlan(next);
  if (!prevPlan || !nextPlan) return null;
  const nextItems = parsePlan(nextPlan);
  const nextById = new Map(nextItems.map((item) => [item.id, item]));
  const completed = completedStepIds(prev?.reports ?? [], prev?.milestones ?? []);
  for (const item of parsePlan(prevPlan)) {
    if (!completed.has(item.id)) continue;
    const replacement = nextById.get(item.id);
    if (!replacement)
      return `Plan edit removes completed item ${item.id}; its STEP report must keep the same ID.`;
    if (replacement.text !== item.text)
      return `Plan edit changes completed item ${item.id}; completed items are immutable.`;
  }
  const archived = completedStepIds([], next.milestones ?? []);
  for (const report of next.reports ?? []) {
    if (!nextById.has(report.key) && !archived.has(report.key))
      return `STEP-${report.key} has no matching plan item ID.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export type WidgetColor = "accent" | "dim" | "success";

export interface WidgetSegment {
  text: string;
  color?: WidgetColor;
}

export function planItemLabel(md: string, index: number): string {
  const t = (itemText(md, index) ?? "").trim();
  const cut = t.indexOf(":");
  const label = cut > 0 ? t.slice(0, cut).trim() : t;
  return label.length > 56 ? `${label.slice(0, 55)}…` : label;
}

export function planDashboardSegments(
  plan: string | undefined,
  reports: readonly ReportRef[],
  hasResearch: boolean,
  milestones: readonly MilestoneRef[] = [],
): WidgetSegment[] {
  const brand: WidgetSegment = { text: " episteme", color: "accent" };
  if (!plan) {
    return [
      brand,
      {
        text: `  ${hasResearch ? "research done — plan pending" : "pre-plan"}`,
        color: "dim",
      },
    ];
  }
  const items = parsePlan(plan);
  const completed = completedStepIds(reports, milestones);
  const done = items.filter((item) => completed.has(item.id)).length;
  const nextIdx = firstUnreportedPlanStep(plan, reports, milestones);
  const segments: WidgetSegment[] = [
    brand,
    { text: `  ${done}/${items.length} `, color: "dim" },
  ];
  for (let i = 0; i < items.length; i++) {
    if (completed.has(items[i].id)) segments.push({ text: "✓", color: "success" });
    else if (i === nextIdx) segments.push({ text: "▶", color: "accent" });
    else segments.push({ text: "·", color: "dim" });
  }
  if (nextIdx >= 0) {
    segments.push({ text: `  next: ${items[nextIdx].id} `, color: "dim" });
    segments.push({ text: planItemLabel(plan, nextIdx) });
  } else {
    segments.push({ text: "  all done", color: "success" });
  }
  return segments;
}

export function modeSegments(
  enabled: boolean,
  paused = false,
): WidgetSegment[] {
  if (!enabled)
    return [
      { text: " episteme", color: "accent" },
      { text: "  off", color: "dim" },
    ];
  return [
    { text: " episteme", color: "accent" },
    { text: paused ? "  paused" : "  on", color: paused ? "dim" : "success" },
  ];
}

// ---------------------------------------------------------------------------
// TUI text fitting
// ---------------------------------------------------------------------------

const SGR_RE = /\x1b\[[0-9;]*m/g;

export function visibleWidth(s: string): number {
  return s.replace(SGR_RE, "").length;
}

export function fitLine(s: string, maxWidth: number): string {
  const w = Math.max(1, Math.floor(maxWidth));
  if (visibleWidth(s) <= w) return s;
  const limit = w - 1;
  let visible = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (visible >= limit) break;
    out += ch;
    visible += 1;
  }
  return `${out}…`;
}

// ---------------------------------------------------------------------------
// Session episteme directory
// ---------------------------------------------------------------------------

export interface EpistemePaths {
  dir: string;
  tmp: string;
}

export function epistemePaths(dir: string): EpistemePaths {
  return { dir, tmp: join(dir, "tmp") };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeSnapshot(path: string, title: string, body: string): void {
  ensureDir(dirname(path));
  const text = normalizeText(body);
  writeFileSync(path, `# Raw context snapshot — ${title}\n${SEP}${text}\n`, "utf8");
}

/**
 * Keep the newest `keep` snapshot files in `dir` and delete the rest, so a long
 * session cannot fill the disk with raw context dumps. A snapshot is a full
 * serialized span, so one per step is unbounded without this. `/episteme reset`
 * remains the way to clear everything at once.
 */
export function pruneSnapshots(dir: string, keep: number): number {
  if (!Number.isFinite(keep) || keep < 0) return 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const files: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      files.push({ path: full, mtimeMs: st.mtimeMs });
    } catch {
      // Gone or unreadable: never fatal for a cleanup pass.
    }
  }
  if (files.length <= keep) return 0;
  // Name breaks mtime ties (same-millisecond writes are ordered by name).
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
  let removed = 0;
  for (const file of files.slice(keep)) {
    try {
      rmSync(file.path, { force: true });
      removed += 1;
    } catch {
      // Ignore: bounded cleanup is best-effort.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

const EPISTEME_DIR_SUFFIX = ".pi_episteme";

export function cleanupOrphanedEpistemeDirs(sessionsDir: string): number {
  let removed = 0;
  for (const entry of readdirSyncSafe(sessionsDir)) {
    if (!entry.endsWith(EPISTEME_DIR_SUFFIX)) continue;
    const sessionFile = entry.slice(0, -EPISTEME_DIR_SUFFIX.length) + ".jsonl";
    if (existsSync(join(sessionsDir, sessionFile))) continue;
    rmSync(join(sessionsDir, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Prune age-old directories under `dir` (used for the ephemeral-session
 * fallback root, which has no session file to be matched against). Directories
 * newer than `maxAgeMs` are left alone.
 */
export function pruneStaleDirs(dir: string, maxAgeMs: number): number {
  let removed = 0;
  const now = Date.now();
  for (const entry of readdirSyncSafe(dir)) {
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      if (now - statSync(full).mtimeMs <= maxAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Unreadable or already gone: never fatal for a cleanup pass.
    }
  }
  return removed;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
