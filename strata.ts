// pi-strata — core strata logic.
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
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const STRATA_VERSION = "v1";
export const STRATA_MARKER = `## PI-STRATA CONTEXT (${STRATA_VERSION})`;
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

export interface StrataBlock {
  key: string;
  stepN?: number;
  milestoneN?: number;
  text: string;
}

export function strataBlock(key: string, body: string): string {
  return `/*STRATA::${key}::v1*/\n${normalizeText(body)}\n/*STRATA::END::${key}::v1*/`;
}

const BLOCK_SOURCE =
  /\/\*STRATA::(RESEARCH|PLAN-DELTA|PLAN|MILESTONE-(\d+)|STEP-([A-Za-z0-9][A-Za-z0-9_-]*))::v1\*\/([\s\S]*?)\/\*STRATA::END::\1::v1\*\//g;

export function extractStrataBlocks(text: string): StrataBlock[] {
  const re = new RegExp(BLOCK_SOURCE.source, "g");
  const blocks: StrataBlock[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const key = m[1];
    const body = normalizeText(m[4]);
    if (body.length === 0) continue;
    if (body.includes(`/*STRATA::${key}::v1*/`)) continue;
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

export function stripStrataBlocks(text: string): string {
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

export interface StrataLayers {
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
  blocks: StrataBlock[],
): StrataLayers | undefined {
  if (blocks.length === 0) return undefined;
  const layers: StrataLayers = { planFresh: false };
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

export function extractLayers(text: string): StrataLayers | undefined {
  return blocksToLayers(extractStrataBlocks(text));
}

export function effectivePlan(layers: StrataLayers): string | undefined {
  return layers.planDelta ?? layers.plan;
}

export function buildStrataSummary(layers: StrataLayers): string {
  const out: string[] = [STRATA_MARKER];
  if (layers.research) out.push(strataBlock("RESEARCH", layers.research));
  if (layers.plan) out.push(strataBlock("PLAN", layers.plan));
  for (const m of layers.milestones ?? [])
    out.push(strataBlock(`MILESTONE-${m.n}`, m.text));
  for (const r of layers.reports ?? []) {
    const key = r.key ?? String(r.n);
    out.push(strataBlock(`STEP-${key}`, r.text));
  }
  if (layers.planDelta) out.push(strataBlock("PLAN-DELTA", layers.planDelta));
  return out.join(SEP);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function stripStrataMarkersForDisplay(md: string): string {
  return md
    .replace(
      /(^|\n)[ \t]*\/\*STRATA::(?:END::)?(?:RESEARCH|PLAN-DELTA|PLAN|MILESTONE-\d+|STEP-[A-Za-z0-9][A-Za-z0-9_-]*)::v1\*\/[ \t]*\n/g,
      "$1",
    )
    .replace(
      /\/\*STRATA::(?:END::)?(?:RESEARCH|PLAN-DELTA|PLAN|MILESTONE-\d+|STEP-[A-Za-z0-9][A-Za-z0-9_-]*)::v1\*\//g,
      "",
    );
}

// ---------------------------------------------------------------------------
// Plan and completion state
// ---------------------------------------------------------------------------

const PLAN_ITEM_RE =
  /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(?:\[id:([A-Za-z0-9][A-Za-z0-9_-]*)\]\s+)?(.*)$/;

export interface PlanItem {
  id: string;
  text: string;
  done: boolean;
  explicitId: boolean;
}

export function parsePlan(md: string): PlanItem[] {
  const items: PlanItem[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(PLAN_ITEM_RE);
    if (!m) continue;
    items.push({
      id: m[2] ?? String(items.length + 1),
      text: m[3].trim(),
      done: m[1]?.toLowerCase() === "x",
      explicitId: m[2] !== undefined,
    });
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

export function firstUnchecked(md: string): number {
  return parsePlan(md).findIndex((t) => !t.done);
}

export function itemText(md: string, index: number): string | undefined {
  return parsePlan(md)[index]?.text;
}

export function itemId(md: string, index: number): string | undefined {
  return parsePlan(md)[index]?.id;
}

export function planCounts(md: string): { done: number; total: number } {
  const items = parsePlan(md);
  return { done: items.filter((t) => t.done).length, total: items.length };
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
  prev: StrataLayers | undefined,
  next: StrataLayers,
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
  const brand: WidgetSegment = { text: " strata", color: "accent" };
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
  mode: "strict" | "light" = "strict",
  paused = false,
): WidgetSegment[] {
  if (!enabled)
    return [
      { text: " strata", color: "accent" },
      { text: "  off", color: "dim" },
    ];
  return [
    { text: " strata", color: "accent" },
    { text: paused ? "  paused" : `  ${mode}`, color: paused ? "dim" : "success" },
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
// Session strata directory
// ---------------------------------------------------------------------------

export interface StrataPaths {
  dir: string;
  tmp: string;
}

export function strataPaths(dir: string): StrataPaths {
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

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

const STRATA_DIR_SUFFIX = ".pi_strata";

export function cleanupOrphanedStrataDirs(sessionsDir: string): number {
  let removed = 0;
  for (const entry of readdirSyncSafe(sessionsDir)) {
    if (!entry.endsWith(STRATA_DIR_SUFFIX)) continue;
    const sessionFile = entry.slice(0, -STRATA_DIR_SUFFIX.length) + ".jsonl";
    if (existsSync(join(sessionsDir, sessionFile))) continue;
    rmSync(join(sessionsDir, entry), { recursive: true, force: true });
    removed += 1;
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
