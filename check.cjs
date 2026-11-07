/**
 * pi-episteme self-test.
 *
 * No test framework, no dependencies: loads the TS sources through jiti
 * (shipped with pi-coding-agent) with the same package aliases pi uses at
 * runtime, then exercises:
 *   1. pure episteme logic (normalization, marker extraction, latest-wins
 *      folding, summary byte-stability, round-trips, plan parsing),
 *   2. extension wiring (factory registers events/tool/command),
 *   3. the episteme tool end-to-end (advance validation against the branch),
 *   4. the session_before_compact handler (plan/step/plain modes).
 *
 * NOTE: this file is CJS on purpose — pi's extension loader runs jiti in a
 * CJS context, and jiti's specifier fallback for pi-ai subpaths only works
 * there (an ESM test harness fails to resolve @earendil-works/pi-ai/utils/*).
 *
 * Run: node check.cjs   (or: npm test)
 * Set PI_ROOT to override the pi-coding-agent install location.
 */

"use strict";

const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const here = __dirname;
// pi-coding-agent is a peer dependency: resolve the local install from this
// project's node_modules; PI_ROOT overrides (e.g. a global pi install).
function resolvePiRoot() {
  // A plain directory check: pi-coding-agent's exports map has no "require"
  // condition, so require.resolve() refuses to find it from CJS.
  const local = join(here, "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(join(local, "package.json"))) return local;
  throw new Error(
    "pi-coding-agent not found in ./node_modules — install the peer deps (npm i) or set PI_ROOT to the pi-coding-agent install directory",
  );
}
const PI_ROOT = process.env.PI_ROOT ?? resolvePiRoot();

const piRequire = createRequire(join(PI_ROOT, "package.json"));
const { createJiti } = piRequire("jiti");
const PI_AI_DIST = join(PI_ROOT, "node_modules/@earendil-works/pi-ai/dist");

// Mirrors pi's own extension loader: jiti rooted at the loader module with the
// same alias table (dist/core/extensions/loader.js getAliases).
const jiti = createJiti(join(PI_ROOT, "dist/core/extensions/loader.js"), {
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_ROOT, "dist/index.js"),
    "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
    "@earendil-works/pi-ai": join(PI_AI_DIST, "compat.js"),
    "@earendil-works/pi-ai/compat": join(PI_AI_DIST, "compat.js"),
    "@earendil-works/pi-ai/oauth": join(PI_AI_DIST, "oauth.js"),
    "@earendil-works/pi-ai/providers/all": join(PI_AI_DIST, "providers/all.js"),
    typebox: piRequire.resolve("typebox"),
    "typebox/compile": piRequire.resolve("typebox/compile"),
    "typebox/value": piRequire.resolve("typebox/value"),
    "@sinclair/typebox": piRequire.resolve("typebox"),
    "@sinclair/typebox/compile": piRequire.resolve("typebox/compile"),
    "@sinclair/typebox/value": piRequire.resolve("typebox/value"),
  },
  tryNative: false,
});

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

// Marker block fixtures (exact tokens the model emits).
const R =
  "/*EPISTEME::RESEARCH::v1*/\nstack: node\nconstraints: local LLM\n/*EPISTEME::END::RESEARCH::v1*/";
const PLAN1 =
  "/*EPISTEME::PLAN::v1*/\n- [ ] write parser\n- [ ] add tests\n/*EPISTEME::END::PLAN::v1*/";
const PLAN1_DONE =
  "/*EPISTEME::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n/*EPISTEME::END::PLAN::v1*/";

const main = async () => {
  console.log("episteme.ts — pure logic");

  // NOTE: use the async import form — jiti's sync loader path lacks the
  // specifier fallback for aliased pi-ai subpaths and fails to load the
  // pi-coding-agent chain.
  const episteme = await jiti.import(join(here, "episteme.ts"));

  await test("normalizeText: CRLF, trailing ws, idempotent", () => {
    const raw = "line one  \r\nline two\r\n\r\n  padded  \n";
    const once = episteme.normalizeText(raw);
    assert.equal(once, "line one\nline two\n\n  padded");
    assert.equal(episteme.normalizeText(once), once);
  });

  await test("extractEpistemeBlocks: well-formed blocks with bodies and step numbers", () => {
    const text = `intro\n${R}\nmid\n${PLAN1}\n/*EPISTEME::STEP-2::v1*/\nstep two report\n/*EPISTEME::END::STEP-2::v1*/\nend`;
    const blocks = episteme.extractEpistemeBlocks(text);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].key, "RESEARCH");
    assert.equal(blocks[0].text, "stack: node\nconstraints: local LLM");
    assert.equal(blocks[1].key, "PLAN");
    assert.equal(blocks[2].key, "STEP-2");
    assert.equal(blocks[2].stepN, 2);
    assert.equal(blocks[2].text, "step two report");
  });

  await test("blocksToLayers: latest wins per phase key, steps sorted", () => {
    const layers = episteme.blocksToLayers([
      { key: "PLAN", text: "- [ ] a" },
      { key: "RESEARCH", text: "r1" },
      { key: "STEP-1", stepN: 1, text: "old" },
      { key: "STEP-2", stepN: 2, text: "did b" },
      { key: "PLAN", text: "- [x] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "new" },
    ]);
    assert.equal(layers.plan, "- [x] a\n- [ ] b");
    assert.equal(layers.research, "r1");
    // no RESEARCH after the reports -> same cycle: the PLAN was replaced and
    // every report survived, regardless of where the PLAN block stood
    assert.deepEqual(layers.reports, [
      { key: "1", n: 1, text: "new" },
      { key: "2", n: 2, text: "did b" },
    ]);
    assert.equal(episteme.blocksToLayers([]), undefined);
  });

  await test("blocksToLayers: new RESEARCH+PLAN drops the previous cycle's reports", () => {
    const layers = episteme.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
      { key: "STEP-2", stepN: 2, text: "did b" },
      { key: "RESEARCH", text: "r2" },
      { key: "PLAN", text: "- [ ] c\n- [ ] d\n- [ ] e" },
    ]);
    assert.equal(layers.research, "r2");
    assert.equal(layers.plan, "- [ ] c\n- [ ] d\n- [ ] e");
    assert.deepEqual(layers.reports, []);
  });

  await test("blocksToLayers: a new PLAN alone replaces the plan, keeps the reports", () => {
    const layers = episteme.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
      { key: "PLAN", text: "- [ ] x\n- [ ] y" },
    ]);
    assert.equal(layers.research, "r1");
    assert.equal(layers.plan, "- [ ] x\n- [ ] y");
    assert.deepEqual(layers.reports, [{ key: "1", n: 1, text: "did a" }]);
  });

  await test("blocksToLayers: a PLAN status update is order-independent", () => {
    // Same cycle, two placements of the re-emitted PLAN: ticking a checkbox
    // must not depend on whether the model wrote the report before or after
    // the plan block (the previous semantics made STEP-1 vanish in the first
    // order, which was unrecoverable after a plain compaction).
    const planFirst = episteme.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [x] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
    ]);
    const reportFirst = episteme.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
      { key: "PLAN", text: "- [x] a\n- [ ] b" },
    ]);
    for (const layers of [planFirst, reportFirst]) {
      assert.equal(layers.plan, "- [x] a\n- [ ] b");
      assert.deepEqual(layers.reports, [{ key: "1", n: 1, text: "did a" }]);
    }
  });

  await test("blocksToLayers: reports after the new cycle boundary are kept", () => {
    const layers = episteme.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a" },
      { key: "STEP-1", stepN: 1, text: "old a" },
      { key: "RESEARCH", text: "r2" },
      { key: "PLAN", text: "- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "new b" },
    ]);
    assert.equal(layers.research, "r2");
    assert.equal(layers.plan, "- [ ] b");
    assert.deepEqual(layers.reports, [{ key: "1", n: 1, text: "new b" }]);
  });

  await test("blocksToLayers: no new RESEARCH/PLAN -> reports untouched", () => {
    const layers = episteme.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
      { key: "STEP-2", stepN: 2, text: "did b" },
    ]);
    assert.deepEqual(layers.reports, [
      { key: "1", n: 1, text: "did a" },
      { key: "2", n: 2, text: "did b" },
    ]);
  });

  await test("extractEpistemeBlocks: malformed pairs skipped, empty bodies dropped", () => {
    const text = [
      "/*EPISTEME::PLAN::v1*/ unclosed plan text",
      "/*EPISTEME::PLAN::v1*/ bad\n/*EPISTEME::PLAN::v1*/ re-open\n/*EPISTEME::END::PLAN::v1*/",
      "/*EPISTEME::RESEARCH::v1*/\n   \n/*EPISTEME::END::RESEARCH::v1*/",
      "/*EPISTEME::RESEARCH::v1*/\nvalid research\n/*EPISTEME::END::RESEARCH::v1*/",
    ].join("\n");
    const blocks = episteme.extractEpistemeBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].key, "RESEARCH");
    assert.equal(blocks[0].text, "valid research");
  });

  await test("buildEpistemeSummary: marker line, blocks in fixed order, strict seams", () => {
    const layers = {
      research: "r",
      plan: "- [ ] a",
      reports: [{ n: 1, text: "rep" }],
    };
    const s = episteme.buildEpistemeSummary(layers);
    assert.ok(
      s.startsWith(
        "## PI-EPISTEME CONTEXT (v1)\n\n/*EPISTEME::RESEARCH::v1*/\nr\n/*EPISTEME::END::RESEARCH::v1*/",
      ),
    );
    assert.ok(
      s.includes("/*EPISTEME::PLAN::v1*/\n- [ ] a\n/*EPISTEME::END::PLAN::v1*/"),
    );
    assert.ok(
      s.includes("/*EPISTEME::STEP-1::v1*/\nrep\n/*EPISTEME::END::STEP-1::v1*/"),
    );
    // only \n\n between blocks — no single-newline seams
    assert.ok(!s.includes("*/\n/*"));
    assert.equal(episteme.buildEpistemeSummary({ ...layers }), s);
  });

  await test("byte-stability across steps: research bytes survive plan/report changes", () => {
    const research = "Stack: node, ts\nConstraints: local LLM";
    const a = episteme.buildEpistemeSummary({
      research,
      plan: "- [ ] a\n- [ ] b",
      reports: [{ n: 1, text: "did a" }],
    });
    const b = episteme.buildEpistemeSummary({
      research,
      plan: "- [x] a\n- [ ] b",
      reports: [
        { n: 1, text: "did a" },
        { n: 2, text: "did b" },
      ],
    });
    // marker + research block identical in both
    assert.ok(b.startsWith(a.slice(0, a.indexOf("/*EPISTEME::PLAN"))));
    assert.ok(b.includes("/*EPISTEME::STEP-2::v1*/\ndid b"));
  });

  await test("summary round-trip: build -> extractLayers -> build is identical", () => {
    const layers = {
      research: "R line 1\nR line 2",
      plan: "- [x] a\n- [ ] b",
      reports: [
        { n: 1, text: "rep one" },
        { n: 3, text: "rep three" },
      ],
    };
    const s = episteme.buildEpistemeSummary(layers);
    const parsed = episteme.extractLayers(s);
    assert.ok(parsed);
    assert.equal(parsed.research, layers.research);
    assert.equal(parsed.plan, layers.plan);
    assert.deepEqual(
      parsed.reports.map((r) => [r.n, r.text]),
      [
        [1, "rep one"],
        [3, "rep three"],
      ],
    );
    assert.equal(episteme.buildEpistemeSummary(parsed), s);
  });

  await test("stable IDs: round-trip, effective PLAN-DELTA and canonical order", () => {
    const layers = {
      research: "research",
      plan: "- [id:S1] first\n- [id:S2] second",
      planDelta: "- [id:S1] first\n- [id:S2] second\n- [id:S3] third",
      milestones: [{ n: 1, text: "Completed-Steps: S0\n\nold digest", completed: ["S0"] }],
      reports: [{ key: "S1", text: "first done" }, { key: "S2", text: "second done" }],
    };
    const summary = episteme.buildEpistemeSummary(layers);
    const parsed = episteme.extractLayers(summary);
    assert.equal(episteme.buildEpistemeSummary(parsed), summary);
    assert.equal(parsed.planFresh, true);
    assert.deepEqual(parsed.reports.map((report) => [report.key, report.text]), [["S1", "first done"], ["S2", "second done"]]);
    assert.equal(episteme.effectivePlan(layers), layers.planDelta);
    assert.ok(summary.indexOf("MILESTONE-1") < summary.indexOf("STEP-S1"));
    assert.ok(summary.indexOf("STEP-S2") < summary.indexOf("PLAN-DELTA"));
    assert.deepEqual([...episteme.completedStepIds(layers.reports, layers.milestones)], ["S0", "S1", "S2"]);
    assert.equal(episteme.reportPlanCounts(episteme.effectivePlan(layers), layers.reports, layers.milestones).done, 2);
  });

  await test("plan validation: duplicate IDs and completed-item edits are rejected", () => {
    assert.match(episteme.planIdError("- [id:S1] a\n- [id:S1] b"), /Duplicate/);
    assert.equal(episteme.planIdError("- [id:S1] a\n- [id:S2] b"), null);
    const prev = episteme.extractLayers(episteme.buildEpistemeSummary({
      research: "r",
      plan: "- [id:S1] a\n- [id:S2] b",
      reports: [{ key: "S1", text: "done" }],
    }));
    for (const planDelta of ["- [id:S2] b", "- [id:S1] changed\n- [id:S2] b"]) {
      const next = { ...prev, planDelta };
      assert.match(episteme.planChangeError(prev, next), /completed item S1/);
    }
    const reordered = { ...prev, planDelta: "- [id:S2] b\n- [id:S1] a" };
    assert.equal(episteme.planChangeError(prev, reordered), null);
    const unknown = { ...prev, reports: [{ key: "S9", text: "unknown" }] };
    assert.match(episteme.planChangeError(prev, unknown), /no matching plan item/);
  });

  await test("new RESEARCH requires a fresh PLAN and clears later layers", () => {
    const old = episteme.buildEpistemeSummary({
      research: "old",
      plan: "- [id:S1] old",
      reports: [{ key: "S1", text: "old done" }],
      milestones: [{ n: 1, text: "Completed-Steps: S0", completed: ["S0"] }],
    });
    const fresh = episteme.extractLayers(`${old}\n\n${R}`);
    assert.equal(fresh.plan, undefined);
    assert.equal(fresh.planFresh, false);
    assert.deepEqual(fresh.reports, []);
    assert.deepEqual(fresh.milestones, []);
    const withPlan = episteme.extractLayers(`${old}\n\n${R}\n\n${PLAN1}`);
    assert.equal(withPlan.planFresh, true);
    assert.equal(withPlan.plan, "- [ ] write parser\n- [ ] add tests");
  });

  await test("extractLayers rejects non-episteme text", () => {
    assert.equal(episteme.extractLayers("## Goal\nrandom summary"), undefined);
  });

  await test("stripEpistemeMarkersForDisplay: anchors hidden, bodies and prose kept", () => {
    const md = `Привет! Иду к плану.\n\n${R}\n\nТеперь план:\n\n${PLAN1}\n\ninline /*EPISTEME::STEP-1::v1*/ body /*EPISTEME::END::STEP-1::v1*/ after\n\nФинал.`;
    const out = episteme.stripEpistemeMarkersForDisplay(md);
    assert.ok(!out.includes("EPISTEME::"), "no anchors left");
    for (const kept of [
      "Привет! Иду к плану.",
      "stack: node",
      "constraints: local LLM",
      "- [ ] write parser",
      "- [ ] add tests",
      "body",
      "Финал.",
    ]) {
      assert.ok(out.includes(kept), `kept: ${kept}`);
    }
    // idempotent; clean text passes through unchanged
    assert.equal(episteme.stripEpistemeMarkersForDisplay(out), out);
    assert.equal(
      episteme.stripEpistemeMarkersForDisplay("plain\n\n- [ ] item"),
      "plain\n\n- [ ] item",
    );
    // a partially streamed marker token is not a full token yet — untouched
    assert.ok(
      episteme
        .stripEpistemeMarkersForDisplay("x /*EPISTEME::RESEARC")
        .includes("/*EPISTEME::RESEARC"),
    );
  });

  await test("plan: flat list — indented sub-bullets and fenced lines are not items", () => {
    const raw =
      "- [X] first\n  - sub-note under first\n+ [x] third\nprose line\n" +
      "- [ ]   spaced  \n  continued wording\n```\n- item inside a fence\n```";
    const items = episteme.parsePlan(raw);
    assert.deepEqual(
      items.map((i) => [i.id, i.done, i.text]),
      [
        ["1", true, "first"],
        ["2", true, "third"],
        ["3", false, "spaced continued wording"],
      ],
    );
    assert.equal(episteme.itemText(raw, 1), "third");
    assert.deepEqual(
      episteme.reportPlanCounts(raw, [{ n: 1 }, { n: 3 }, { n: 99 }]),
      { done: 2, total: 3 },
    );
    assert.equal(episteme.firstUnreportedPlanStep(raw, [{ n: 1 }, { n: 3 }]), 1);
    // a nested plan must not produce phantom items that need a STEP report
    const nested =
      "- [id:S1] implement parser\n  - handle unicode\n  - handle CRLF\n- [id:S2] run tests";
    assert.deepEqual(
      episteme.parsePlan(nested).map((i) => i.id),
      ["S1", "S2"],
    );
    assert.equal(
      episteme.firstUnreportedPlanStep(nested, [{ key: "S1" }]),
      1,
    );
  });

  const joinSegments = (segments) => segments.map((s) => s.text).join("");

  await test("planItemLabel: colon cut, fallback to full text, 56 cap", () => {
    const md =
      "- [ ] Step 1 (Makefile): add build targets\n- [ ] just a long item without any colon in it at all here";
    assert.equal(episteme.planItemLabel(md, 0), "Step 1 (Makefile)");
    assert.equal(
      episteme.planItemLabel(md, 1),
      "just a long item without any colon in it at all here",
    );
    const long = "x".repeat(70);
    assert.equal(
      episteme.planItemLabel(`- [ ] ${long}`, 0),
      `${"x".repeat(55)}…`,
    );
    // a colon in the first position is not a boundary
    assert.equal(episteme.planItemLabel("- [ ] :nope", 0), ":nope");
  });

  await test("planDashboardSegments: pi-lens style line (brand, counter, bar, next)", () => {
    const plan = "- [x] a\n- [x] b\n- [ ] c\n- [ ] d";
    const segs = episteme.planDashboardSegments(plan, [{ n: 1 }, { n: 2 }], true);
    assert.equal(joinSegments(segs), " episteme  2/4 ✓✓▶·  next: 3 c");
    assert.equal(segs[0].color, "accent"); // brand
    assert.equal(segs[1].color, "dim"); // counter
    // bar: done=success, next=accent, todo=dim (after brand and counter)
    const bar = segs.slice(2, 6);
    assert.deepEqual(
      bar.map((s) => [s.text, s.color]),
      [
        ["✓", "success"],
        ["✓", "success"],
        ["▶", "accent"],
        ["·", "dim"],
      ],
    );
    // all done
    const done = episteme.planDashboardSegments(
      plan,
      [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
      true,
    );
    assert.equal(joinSegments(done), " episteme  4/4 ✓✓✓✓  all done");
    // no plan yet
    assert.equal(
      joinSegments(episteme.planDashboardSegments(undefined, [], true)),
      " episteme  research done — plan pending",
    );
    assert.equal(
      joinSegments(episteme.planDashboardSegments(undefined, [], false)),
      " episteme  pre-plan",
    );
  });

  await test("modeSegments: on=success, paused/off=dim", () => {
    assert.deepEqual(episteme.modeSegments(true), [
      { text: " episteme", color: "accent" },
      { text: "  on", color: "success" },
    ]);
    assert.deepEqual(episteme.modeSegments(true, true), [
      { text: " episteme", color: "accent" },
      { text: "  paused", color: "dim" },
    ]);
    assert.deepEqual(episteme.modeSegments(false), [
      { text: " episteme", color: "accent" },
      { text: "  off", color: "dim" },
    ]);
  });

  await test("visibleWidth/fitLine: ANSI-aware width and truncation", () => {
    const dim = "\u001b[2m";
    const reset = "\u001b[0m";
    assert.equal(episteme.visibleWidth(`${dim}abcd${reset}ef`), 6);
    assert.equal(episteme.visibleWidth("plain"), 5);
    // short lines pass through untouched
    assert.equal(
      episteme.fitLine(`${dim}ab${reset}cd`, 10),
      `${dim}ab${reset}cd`,
    );
    // long plain lines: truncated with an ellipsis, exactly width cells
    const long = "x".repeat(40);
    const fitted = episteme.fitLine(long, 10);
    assert.equal(fitted, `${"x".repeat(9)}…`);
    assert.equal(episteme.visibleWidth(fitted), 10);
    // colored lines: escapes stay intact, not counted
    const colored = `${dim}${"y".repeat(40)}${reset}`;
    const fittedColor = episteme.fitLine(colored, 10);
    assert.equal(fittedColor, `${dim}${"y".repeat(9)}…`);
    assert.equal(episteme.visibleWidth(fittedColor), 10);
  });

  const workDir = mkdtempSync(join(tmpdir(), "pi-episteme-test-"));
  const sDir = join(workDir, "session.pi_episteme");

  await test("writeSnapshot: writes a disposable raw snapshot", () => {
    const snapPath = join(sDir, "tmp", "step_1_raw.md");
    episteme.writeSnapshot(snapPath, "step 1", "raw text  \r\n");
    assert.ok(existsSync(snapPath));
    assert.ok(readFileSync(snapPath, "utf8").includes("raw text"));
  });

  await test("cleanupOrphanedEpistemeDirs removes episteme dirs of deleted sessions", () => {
    const sessDir = join(workDir, "sessions");
    mkdirSync(sessDir, { recursive: true });
    const mk = (name) => {
      mkdirSync(join(sessDir, name, "tmp"), { recursive: true });
      writeFileSync(join(sessDir, name, "tmp", "step_1_raw.md"), "raw\n");
    };
    writeFileSync(join(sessDir, "a.jsonl"), "{}");
    mk("a.pi_episteme");
    mk("b.pi_episteme"); // b.jsonl is gone -> orphan
    writeFileSync(join(sessDir, "c.jsonl"), "{}");
    mk("c.pi_episteme");
    writeFileSync(join(sessDir, "d.txt"), "not episteme");
    const removed = episteme.cleanupOrphanedEpistemeDirs(sessDir);
    assert.equal(removed, 1);
    assert.ok(existsSync(join(sessDir, "a.pi_episteme")));
    assert.ok(!existsSync(join(sessDir, "b.pi_episteme")));
    assert.ok(existsSync(join(sessDir, "c.pi_episteme")));
    assert.ok(existsSync(join(sessDir, "d.txt")));
  });

  await test("pruneStaleDirs: only age-old directories go", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-episteme-eph-"));
    const young = join(root, "young");
    const old = join(root, "old");
    mkdirSync(join(young, "tmp"), { recursive: true });
    mkdirSync(old, { recursive: true });
    writeFileSync(join(root, "loose.txt"), "x");
    const past = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
    require("node:fs").utimesSync(old, past, past);
    assert.equal(episteme.pruneStaleDirs(root, 7 * 24 * 3600 * 1000), 1);
    assert.ok(existsSync(young), "recent dir kept");
    assert.ok(!existsSync(old), "stale dir pruned");
    assert.ok(existsSync(join(root, "loose.txt")), "files are never touched");
    assert.equal(episteme.pruneStaleDirs(join(root, "nope"), 1), 0);
  });

  console.log("compaction.ts — session_before_compact");

  const { handleSessionBeforeCompact, previousLlmTail } = await jiti.import(
    join(here, "compaction.ts"),
  );

  // LLM-message fixtures for the summarized span.
  const userMsg = (text, ts) => ({
    role: "user",
    content: text,
    timestamp: ts ?? 1,
  });
  const assistantMsg = (text, ts) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: ts ?? 2,
  });

  const makeEvent = (opts = {}) => ({
    type: "session_before_compact",
    reason: opts.reason ?? "manual",
    willRetry: opts.willRetry ?? false,
    customInstructions: "test",
    signal: opts.signal ?? new AbortController().signal,
    branchEntries: opts.branchEntries ?? [
      { type: "session", id: "h" },
      { type: "message", id: "m1", message: userMsg("task text", 1) },
      { type: "message", id: "m2", message: assistantMsg("response text", 2) },
    ],
    preparation: {
      firstKeptEntryId: opts.firstKept ?? "m2",
      messagesToSummarize: opts.messages ?? [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1234,
      previousSummary: opts.previousSummary,
      fileOps: { readFiles: [], modifiedFiles: [] },
      settings: { reserveTokens: 16384, keepRecentTokens: 20000 },
    },
  });

  const makeRt = (pending) => ({
    epistemeDir: sDir,
    pending: pending
      ? { ...pending, boundaryId: pending.boundaryId ?? "phase-boundary" }
      : null,
  });

  const makeCtx = (extra = {}) => ({
    cwd: workDir,
    hasUI: false,
    ui: { notify: () => {} },
    model: undefined,
    modelRegistry: undefined,
    ...extra,
  });

  await test("not a episteme session -> undefined (default compaction)", async () => {
    const res = await handleSessionBeforeCompact(
      makeEvent({
        messages: [userMsg("task"), assistantMsg("hello, no markers here")],
      }),
      makeCtx(),
      makeRt(null),
    );
    assert.equal(res, undefined);
  });

  await test("plan mode: first compaction from conversation blocks", async () => {
    const event = makeEvent({
      messages: [
        userMsg("build a parser"),
        assistantMsg(`Investigation:\n${R}\n\nPlan:\n${PLAN1}`),
      ],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "plan" }),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.firstKeptEntryId, "phase-boundary");
    assert.equal(res.compaction.tokensBefore, 1234);
    assert.ok(res.compaction.summary.startsWith("## PI-EPISTEME CONTEXT (v1)"));
    assert.ok(
      res.compaction.summary.includes(
        "/*EPISTEME::RESEARCH::v1*/\nstack: node\nconstraints: local LLM",
      ),
    );
    assert.ok(
      res.compaction.summary.includes(
        "/*EPISTEME::PLAN::v1*/\n- [ ] write parser\n- [ ] add tests",
      ),
    );
    assert.equal(res.compaction.details.episteme.mode, "plan");
  });

  await test("latest wins: newer PLAN block overrides the summary's plan", async () => {
    const prevSummary = episteme.buildEpistemeSummary({
      research: "stack: node",
      plan: "- [ ] write parser\n- [ ] add tests",
    });
    const planV2 =
      "/*EPISTEME::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n- [ ] ship\n/*EPISTEME::END::PLAN::v1*/";
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg(`Plan updated:\n${planV2}`)],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "plan" }),
    );
    assert.ok(res?.compaction);
    assert.ok(
      res.compaction.summary.includes(
        "/*EPISTEME::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n- [ ] ship",
      ),
    );
    // research survived from the previous summary
    assert.ok(
      res.compaction.summary.includes("/*EPISTEME::RESEARCH::v1*/\nstack: node"),
    );
    // the stale plan bytes are gone
    assert.ok(
      !res.compaction.summary.includes(
        "- [ ] write parser\n- [ ] add tests\n/*EPISTEME::END::PLAN::v1*/",
      ),
    );
  });

  await test("PLAN re-emitted mid-cycle keeps the step reports and stays byte-stable", async () => {
    const prevSummary = episteme.buildEpistemeSummary({
      research: "stack: node",
      plan: "- [ ] write parser\n- [ ] add tests",
      reports: [{ n: 1, text: "did write parser; tests green" }],
    });
    // the model ticks the finished item; no new RESEARCH -> same cycle
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [
        assistantMsg(
          "Status update:\n/*EPISTEME::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n/*EPISTEME::END::PLAN::v1*/",
        ),
      ],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.deepEqual(res.compaction.details.episteme.reportFiles, [1]);
    assert.ok(
      res.compaction.summary.includes("did write parser; tests green"),
    );
    // Re-compacting may refresh the ephemeral raw fallback, but not the layers.
    const again = await handleSessionBeforeCompact(
      makeEvent({
        previousSummary: res.compaction.summary,
        messages: [assistantMsg("still working")],
      }),
      makeCtx(),
      makeRt(null),
    );
    assert.equal(
      episteme.buildEpistemeSummary(episteme.extractLayers(again.compaction.summary)),
      episteme.buildEpistemeSummary(episteme.extractLayers(res.compaction.summary)),
    );
  });

  await test("new task: plan compaction drops the previous cycle's step reports", async () => {
    const prevSummary = episteme.buildEpistemeSummary({
      research: "task one research",
      plan: "- [ ] write parser\n- [ ] add tests",
      reports: [
        { n: 1, text: "did write parser" },
        { n: 2, text: "did add tests" },
      ],
    });
    const r2 =
      "/*EPISTEME::RESEARCH::v1*/\nstack: node\n/*EPISTEME::END::RESEARCH::v1*/";
    const plan2 =
      "/*EPISTEME::PLAN::v1*/\n- [ ] build\n- [ ] test\n- [ ] ship\n/*EPISTEME::END::PLAN::v1*/";
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg(`New task.\n${r2}\n${plan2}`)],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "plan" }),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plan");
    // no stale step reports from the previous task
    assert.ok(!res.compaction.summary.includes("/*EPISTEME::STEP-1"));
    assert.ok(!res.compaction.summary.includes("/*EPISTEME::STEP-2"));
    assert.ok(!res.compaction.summary.includes("did write parser"));
    // the new cycle's blocks are present
    assert.ok(
      res.compaction.summary.includes("/*EPISTEME::RESEARCH::v1*/\nstack: node"),
    );
    assert.ok(
      res.compaction.summary.includes("- [ ] build\n- [ ] test\n- [ ] ship"),
    );
    assert.deepEqual(res.compaction.details.episteme.reportFiles, []);
  });

  await test("previousLlmTail: strips the episteme prefix, keeps the pi LLM tail", () => {
    assert.equal(previousLlmTail(undefined), undefined);
    const epistemeOnly = episteme.buildEpistemeSummary({
      research: "stack: node",
      plan: "- [ ] a",
    });
    assert.equal(previousLlmTail(epistemeOnly), undefined);
    const tail = "## Goal\nbuild a parser\n\n## Progress\n- in progress: b";
    assert.equal(previousLlmTail(`${epistemeOnly}\n\n${tail}`), tail);
    const tailWithMarkers = `${tail}\n\n${R}`;
    assert.equal(previousLlmTail(`${epistemeOnly}\n\n${tailWithMarkers}`), tailWithMarkers);
    // non-episteme summaries are passed through untouched
    const nonEpisteme = "## Goal\nold pi summary";
    assert.equal(previousLlmTail(nonEpisteme), nonEpisteme);
  });

  await test("plain mode: mid-step compaction keeps the layers, no extras", async () => {
    const prevSummary = episteme.buildEpistemeSummary({
      research: "stack: node",
      plan: "- [x] a\n- [ ] b",
    });
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg("working on b...")],
    });
    // no model in ctx -> deterministic layer dump only
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
    assert.equal(res.compaction.details.episteme.llmSummary, false);
    // Pi's default tail cut is kept untouched
    assert.equal(res.compaction.firstKeptEntryId, "m2");
    assert.ok(res.compaction.summary.includes("/*EPISTEME::RESEARCH::v1*/"));
    assert.ok(res.compaction.summary.includes("/*EPISTEME::PLAN::v1*/"));
  });

  await test("plain mode: pi LLM summary is appended on top of the episteme sections", async () => {
    const prevSummary = episteme.buildEpistemeSummary({
      research: "stack: node",
      plan: "- [x] a\n- [ ] b",
    });
    const oldTail =
      "## Goal\nbuild a parser\n\n## Progress\n### In Progress\n- [ ] b: half done";
    const event = makeEvent({
      previousSummary: `${prevSummary}\n\n${oldTail}`,
      messages: [assistantMsg("working on b...")],
    });
    let seen; // the preparation the summarizer received
    const usage = {
      input: 3,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const summarizer = async (prep) => {
      seen = prep;
      return {
        summary:
          "## Goal\nbuild a parser\n\n## Progress\n### Done\n- [x] a\n### In Progress\n- [ ] b",
        usage,
      };
    };
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
      { summarizePlain: summarizer },
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
    assert.equal(res.compaction.details.episteme.llmSummary, true);
    // the episteme prefix is byte-identical, the LLM tail follows it
    assert.equal(
      res.compaction.summary.slice(0, prevSummary.length),
      prevSummary,
    );
    assert.ok(res.compaction.summary.includes("### In Progress\n- [ ] b"));
    assert.equal(res.compaction.usage, usage);
    // the LLM merges its own previous tail, never the episteme sections
    assert.equal(seen.previousSummary, oldTail);
    assert.equal(seen.messagesToSummarize.length, 1);
  });

  await test("plain mode: summarizer failure preserves a bounded raw checkpoint", async () => {
    let warnings = 0;
    const ctx = makeCtx({
      hasUI: true,
      ui: {
        notify: (_message, type) => {
          if (type === "warning") warnings += 1;
        },
      },
    });
    const layers = { research: "stack: node", plan: "- [ ] a" };
    const event = makeEvent({
      previousSummary: episteme.buildEpistemeSummary(layers),
      messages: [userMsg("x".repeat(13000)), assistantMsg("working...")],
    });
    const res = await handleSessionBeforeCompact(event, ctx, makeRt(null), {
      summarizePlain: async () => {
        throw new Error("llm down");
      },
    });
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
    assert.equal(res.compaction.details.episteme.llmSummary, false);
    assert.equal(res.compaction.details.episteme.rawFallback, true);
    assert.ok(res.compaction.summary.startsWith(episteme.buildEpistemeSummary(layers)));
    assert.ok(res.compaction.summary.includes("## PI-EPISTEME RAW CHECKPOINT"));
    assert.ok(res.compaction.summary.includes("working..."));
    assert.ok(res.compaction.summary.length < 13000);
    assert.equal(warnings, 1);
  });

  await test("plain mode: aborted summarization cancels the compaction", async () => {
    const ac = new AbortController();
    ac.abort();
    const event = makeEvent({
      previousSummary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] a",
      }),
      messages: [assistantMsg("working...")],
      signal: ac.signal,
    });
    await assert.rejects(
      handleSessionBeforeCompact(event, makeCtx(), makeRt(null), {
        summarizePlain: async (_prep, _ctx, signal) => {
          if (signal.aborted) throw new Error("aborted");
          return { summary: "x" };
        },
      }),
      /aborted/,
    );
  });

  await test("plain mode: blocks kept in Pi's recent tail are not paid for twice", async () => {
    const event = makeEvent({
      firstKept: "m2",
      messages: [assistantMsg("working; old logs are being compacted")],
      branchEntries: [
        { type: "session", id: "h" },
        { type: "message", id: "m1", message: userMsg("task text", 1) },
        {
          type: "message",
          id: "m2",
          message: assistantMsg(`${R}\n${PLAN1}`, 2),
        },
      ],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
    assert.deepEqual(res.compaction.details.episteme.dedupedWithTail, [
      "RESEARCH",
      "PLAN",
    ]);
    assert.ok(!res.compaction.summary.includes("/*EPISTEME::PLAN::v1*/"));
    // every layer is still in the context exactly once: canonical summary +
    // the retained tail pi keeps, so nothing was dropped
    const seen = episteme.extractLayers(
      [res.compaction.summary, `${R}\n${PLAN1}`].join("\n\n"),
    );
    assert.ok(seen.research.includes("stack: node"));
    assert.ok(seen.plan.includes("- [ ] write parser"));
  });

  await test("previousLlmTail parses a deduped (subset) canonical prefix", () => {
    const subset = [
      episteme.EPISTEME_MARKER,
      episteme.epistemeBlock("RESEARCH", "goal: x"),
      "pi ephemeral summary about tool output",
    ].join("\n\n");
    // the PLAN block lives only in the retained tail, so the stored summary is
    // a subset; the tail splitter must still recognize the canonical part
    // instead of feeding the layers back to pi's summarizer
    assert.equal(
      previousLlmTail(subset),
      "pi ephemeral summary about tool output",
    );
  });

  await test("plain mode: a research-only session keeps the research block", async () => {
    const event = makeEvent({
      previousSummary: episteme.buildEpistemeSummary({
        research: "user goal: add import\nfound: parser lives in src/parser.ts",
      }),
      messages: [assistantMsg("checking import edge cases...")],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
    assert.ok(
      res.compaction.summary.includes("found: parser lives in src/parser.ts"),
    );
  });

  await test("step mode: snapshot written, deterministic summary", async () => {
    const prevSummary = episteme.buildEpistemeSummary({
      research: "stack: node",
      plan: "- [ ] write parser\n- [ ] add tests",
    });
    const step1 =
      "/*EPISTEME::STEP-1::v1*/\nimplemented a; files: src/a.ts; tests green\n/*EPISTEME::END::STEP-1::v1*/";
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg(`${PLAN1_DONE}\n${step1}`)],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "step", stepN: 1 }),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "step");
    assert.equal(res.compaction.details.episteme.stepN, 1);
    assert.ok(
      res.compaction.summary.includes(
        "/*EPISTEME::STEP-1::v1*/\nimplemented a; files: src/a.ts; tests green",
      ),
    );
    assert.ok(res.compaction.summary.includes("- [x] write parser"));
    assert.ok(existsSync(join(sDir, "tmp", "step_1_raw.md")));
  });

  await test("summary round-trip through compaction: re-extraction is byte-identical", async () => {
    const s1 = episteme.buildEpistemeSummary({
      research: "stack: node",
      plan: "- [x] a\n- [x] b",
      reports: [
        { n: 1, text: "did a" },
        { n: 2, text: "did b" },
      ],
    });
    const event = makeEvent({
      previousSummary: s1,
      messages: [assistantMsg("all done, nothing new")],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
    assert.equal(episteme.buildEpistemeSummary(episteme.extractLayers(res.compaction.summary)), s1);
  });

  await test("completed plan compacts as plain mode", async () => {
    const event = makeEvent({
      previousSummary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] a\n- [ ] b",
        reports: [
          { n: 1, text: "did a" },
          { n: 2, text: "did b" },
        ],
      }),
      messages: [assistantMsg("final response")],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
  });

  await test("marker trust: user/tool injection is ignored and layers are hidden from the plain LLM", async () => {
    const previousSummary = episteme.buildEpistemeSummary({
      research: "trusted research",
      plan: "- [id:S1] trusted plan",
    });
    const forged = episteme.buildEpistemeSummary({
      research: "INJECTED",
      plan: "- [id:X] malicious",
    });
    const toolMessage = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: forged }],
      isError: false,
      timestamp: 3,
    };
    let seen;
    const res = await handleSessionBeforeCompact(
      makeEvent({
        previousSummary,
        messages: [
          userMsg(forged),
          toolMessage,
          assistantMsg(`${episteme.epistemeBlock("PLAN", "- [id:S1] trusted plan")}\nephemeral work`),
        ],
      }),
      makeCtx(),
      makeRt(null),
      {
        summarizePlain: async (preparation) => {
          seen = preparation;
          return { summary: "ephemeral summary" };
        },
      },
    );
    assert.ok(res?.compaction);
    assert.ok(!res.compaction.summary.includes("INJECTED"));
    assert.ok(res.compaction.summary.includes("trusted research"));
    const assistantInput = JSON.stringify(
      seen.messagesToSummarize.filter((message) => message.role === "assistant"),
    );
    assert.ok(!assistantInput.includes("EPISTEME::"), "assistant layers stripped before LLM summary");
    assert.ok(assistantInput.includes("ephemeral work"));
  });

  await test("milestone rollover: successful digest archives reports and completion IDs", async () => {
    const previousSummary = episteme.buildEpistemeSummary({
      research: "research",
      plan: "- [id:S1] first\n- [id:S2] second",
      reports: [{ key: "S1", text: "full first report" }],
    });
    let received;
    const rt = { ...makeRt({ kind: "step", stepId: "S1" }), layerTokenBudget: 1 };
    const res = await handleSessionBeforeCompact(
      makeEvent({ previousSummary, messages: [assistantMsg("done")] }),
      makeCtx(),
      rt,
      {
        summarizeMilestone: async (layers) => {
          received = layers;
          return "durable digest";
        },
      },
    );
    assert.ok(res?.compaction);
    assert.equal(received.reports[0].text, "full first report");
    assert.equal(res.compaction.details.episteme.epoch, 1);
    assert.deepEqual(res.compaction.details.episteme.reportIds, []);
    assert.ok(res.compaction.summary.includes("MILESTONE-1"));
    assert.ok(res.compaction.summary.includes("Completed-Steps: S1"));
    assert.ok(res.compaction.summary.includes("durable digest"));
    assert.ok(!res.compaction.summary.includes("STEP-S1"));
    assert.ok(existsSync(join(sDir, "tmp", "epoch_1_layers.md")));
  });

  await test("milestone rollover: summarizer failure retains full reports", async () => {
    const previousSummary = episteme.buildEpistemeSummary({
      research: "research",
      plan: "- [id:S1] first",
      reports: [{ key: "S1", text: "must survive" }],
    });
    const failDir = mkdtempSync(join(tmpdir(), "pi-episteme-epoch-"));
    const rt = { ...makeRt(null), epistemeDir: failDir, layerTokenBudget: 1 };
    const res = await handleSessionBeforeCompact(
      makeEvent({ previousSummary, messages: [assistantMsg("work")] }),
      makeCtx(),
      rt,
      {
        summarizePlain: async () => ({ summary: "tail" }),
        summarizeMilestone: async () => { throw new Error("milestone unavailable"); },
      },
    );
    assert.ok(res?.compaction);
    assert.ok(res.compaction.summary.includes("STEP-S1"));
    assert.ok(res.compaction.summary.includes("must survive"));
    assert.ok(!res.compaction.summary.includes("MILESTONE-1"));
    assert.ok(
      !existsSync(join(failDir, "tmp", "epoch_1_layers.md")),
      "no epoch archive for a rollover that never happened",
    );
  });

  await test("plain compaction does not pay twice for a block the tail keeps", async () => {
    const layers = {
      research: "research body",
      plan: "- [id:S1] first",
      reports: [{ key: "S1", text: "report body" }],
    };
    const previousSummary = episteme.buildEpistemeSummary(layers);
    const stepBlock = episteme.epistemeBlock("STEP-S1", "report body");
    const res = await handleSessionBeforeCompact(
      makeEvent({
        previousSummary,
        messages: [assistantMsg("ephemeral work")],
        firstKept: "m2",
        branchEntries: [
          { type: "session", id: "h" },
          { type: "message", id: "m1", message: userMsg("task", 1) },
          {
            type: "message",
            id: "m2",
            message: assistantMsg(`Done.\n\n${stepBlock}`, 2),
          },
        ],
      }),
      makeCtx(),
      makeRt(null),
      { summarizePlain: async () => ({ summary: "ephemeral tail" }) },
    );
    assert.ok(res?.compaction);
    assert.ok(
      !res.compaction.summary.includes("STEP-S1"),
      "the duplicated report is left out of the summary",
    );
    assert.ok(
      res.compaction.summary.includes("- [id:S1] first"),
      "blocks that are not in the tail stay canonical",
    );
    assert.deepEqual(res.compaction.details.episteme.dedupedWithTail, [
      "STEP-S1",
    ]);
    assert.equal(res.compaction.firstKeptEntryId, "m2", "the tail is still kept");
    // and the tail copy still folds back into the layers on the next pass
    const folded = episteme.extractLayers(
      [res.compaction.summary, stepBlock].join("\n\n"),
    );
    assert.deepEqual(folded.reports.map((r) => r.key), ["S1"]);
  });

  await test("pi integration: non-context phase sentinel leaves only the episteme summary", async () => {
    const { buildContextEntries, buildSessionContext } = await jiti.import(join(PI_ROOT, "dist/index.js"));
    const summary = episteme.buildEpistemeSummary({ research: "r", plan: "- [id:S1] a" });
    const entries = [
      { type: "session", id: "root", timestamp: new Date().toISOString(), version: 3 },
      { type: "message", id: "m1", parentId: "root", timestamp: new Date().toISOString(), message: userMsg("raw user task") },
      { type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString(), message: assistantMsg("raw tool setup") },
      { type: "custom", id: "phase-boundary", parentId: "m2", timestamp: new Date().toISOString(), customType: "episteme-phase-boundary", data: { kind: "plan" } },
      { type: "compaction", id: "c1", parentId: "phase-boundary", timestamp: new Date().toISOString(), summary, firstKeptEntryId: "phase-boundary", tokensBefore: 100 },
    ];
    const contextEntries = buildContextEntries(entries, "c1");
    assert.deepEqual(contextEntries.map((entry) => entry.id), ["c1", "phase-boundary"]);
    const context = buildSessionContext(entries, "c1");
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].role, "compactionSummary");
    assert.equal(context.messages[0].summary, summary);
    assert.ok(!JSON.stringify(context.messages).includes("raw user task"));
    assert.ok(!JSON.stringify(context.messages).includes("raw tool setup"));
  });

  console.log("config.ts — env > config > default");

  const config = await jiti.import(join(here, "config.ts"));
  const EPISTEME_ENV = [
    "PI_EPISTEME_AUTO_CONTINUE",
    "PI_EPISTEME_HIDE_ANCHORS",
    "PI_EPISTEME_LAYER_TOKEN_BUDGET",
  ];
  const savedEnv = Object.fromEntries(
    EPISTEME_ENV.map((k) => [k, process.env[k]]),
  );
  const clearEpistemeEnv = () => {
    for (const k of EPISTEME_ENV) delete process.env[k];
  };
  const noSettings = join(workDir, "no-such-settings.json");
  const globalSettings = join(workDir, "global-settings.json");
  const projectSettings = join(workDir, ".pi", "settings.json");
  const writeSettings = (file, obj) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj));
  };

  try {
    await test("defaults: no env, no settings files", () => {
      clearEpistemeEnv();
      assert.deepEqual(config.resolveEpistemeSettings(workDir, noSettings), {
        autoContinue: true,
        hideAnchors: true,
        layerTokenBudget: 16384,
      });
    });

    await test("global config file applies", () => {
      clearEpistemeEnv();
      writeSettings(globalSettings, { piEpisteme: { autoContinue: false } });
      assert.deepEqual(config.resolveEpistemeSettings(workDir, globalSettings), {
        autoContinue: false,
        hideAnchors: true,
        layerTokenBudget: 16384,
      });
    });

    await test("project config overrides global per field", () => {
      clearEpistemeEnv();
      writeSettings(globalSettings, {
        piEpisteme: { autoContinue: false },
      });
      writeSettings(projectSettings, {
        piEpisteme: { autoContinue: true },
      });
      assert.deepEqual(config.resolveEpistemeSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: true,
        layerTokenBudget: 16384,
      });
    });

    await test("env overrides config", () => {
      process.env.PI_EPISTEME_AUTO_CONTINUE = "0";
      assert.deepEqual(config.resolveEpistemeSettings(workDir, globalSettings), {
        autoContinue: false,
        hideAnchors: true,
        layerTokenBudget: 16384,
      });
    });

    await test("hideAnchors: config applies, env 0/1 override", () => {
      clearEpistemeEnv();
      writeSettings(globalSettings, { piEpisteme: { hideAnchors: false } });
      assert.deepEqual(config.resolveEpistemeSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: false,
        layerTokenBudget: 16384,
      });
      process.env.PI_EPISTEME_HIDE_ANCHORS = "1";
      assert.equal(
        config.resolveEpistemeSettings(workDir, globalSettings).hideAnchors,
        true,
      );
      process.env.PI_EPISTEME_HIDE_ANCHORS = "0";
      assert.equal(
        config.resolveEpistemeSettings(workDir, globalSettings).hideAnchors,
        false,
      );
    });

    await test("legacy enabled in config is ignored (session state now)", () => {
      clearEpistemeEnv();
      writeSettings(globalSettings, { piEpisteme: { enabled: false } });
      // `enabled` is no longer a config field — it must not leak into the
      // resolved settings at all (the mode is per-session, off by default)
      assert.deepEqual(config.resolveEpistemeSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: true,
        layerTokenBudget: 16384,
      });
    });

    await test("invalid values fall through to lower levels", () => {
      clearEpistemeEnv();
      writeSettings(globalSettings, {
        piEpisteme: {
          autoContinue: "yes", // not a boolean -> ignored
          hideAnchors: "yes", // not a boolean -> ignored
        },
      });
      assert.deepEqual(config.resolveEpistemeSettings(workDir, globalSettings), {
        autoContinue: true, // invalid config -> default
        hideAnchors: true, // invalid config -> default
        layerTokenBudget: 16384,
      });
      process.env.PI_EPISTEME_AUTO_CONTINUE = "1";
      assert.equal(
        config.resolveEpistemeSettings(workDir, globalSettings).autoContinue,
        true,
      );
    });

    await test("layer budget: config, env zero and invalid fallback", () => {
      clearEpistemeEnv();
      writeSettings(globalSettings, { piEpisteme: { layerTokenBudget: 256 } });
      assert.equal(config.resolveEpistemeSettings(workDir, globalSettings).layerTokenBudget, 256);
      process.env.PI_EPISTEME_LAYER_TOKEN_BUDGET = "0";
      assert.equal(config.resolveEpistemeSettings(workDir, globalSettings).layerTokenBudget, 0);
      process.env.PI_EPISTEME_LAYER_TOKEN_BUDGET = "-1";
      assert.equal(config.resolveEpistemeSettings(workDir, globalSettings).layerTokenBudget, 256);
      process.env.PI_EPISTEME_LAYER_TOKEN_BUDGET = "1.5";
      assert.equal(config.resolveEpistemeSettings(workDir, globalSettings).layerTokenBudget, 256);
      // an integer that is not a safe integer must not pass as "huge budget"
      process.env.PI_EPISTEME_LAYER_TOKEN_BUDGET = "99999999999999999999";
      assert.equal(
        config.resolveEpistemeSettings(workDir, globalSettings).layerTokenBudget,
        256,
      );
    });

    await test("strict boolean env: invalid values fall through to config", () => {
      clearEpistemeEnv();
      writeSettings(projectSettings, {});
      writeSettings(globalSettings, { piEpisteme: { autoContinue: false, hideAnchors: false } });
      for (const value of ["yes", "2", "TRUEISH"]) {
        process.env.PI_EPISTEME_AUTO_CONTINUE = value;
        process.env.PI_EPISTEME_HIDE_ANCHORS = value;
        const settings = config.resolveEpistemeSettings(workDir, globalSettings);
        assert.equal(settings.autoContinue, false);
        assert.equal(settings.hideAnchors, false);
      }
      process.env.PI_EPISTEME_AUTO_CONTINUE = " ON ";
      process.env.PI_EPISTEME_HIDE_ANCHORS = " True ";
      const settings = config.resolveEpistemeSettings(workDir, globalSettings);
      assert.equal(settings.autoContinue, true);
      assert.equal(settings.hideAnchors, true);
    });

    await test("invalid settings.json / missing key are ignored", () => {
      clearEpistemeEnv();
      writeSettings(globalSettings, "{ not json");
      writeSettings(projectSettings, { theme: "dark" });
      assert.deepEqual(config.resolveEpistemeSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: true,
        layerTokenBudget: 16384,
      });
    });
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log("prompts.ts — model-facing texts");

  const prompts = await jiti.import(join(here, "prompts.ts"));

  await test("prompts: flat-list rule, single-agent protocol, byte-identical layer-0 body", () => {
    const instructions = prompts.buildEpistemeInstructions("/d.pi_episteme");
    assert.match(instructions, /FLAT lists/);
    assert.match(instructions, /only top-level bullets are tracked/);
    assert.ok(instructions.includes("/d.pi_episteme/tmp/step_ID_raw.md"));
    assert.ok(instructions.includes("/*EPISTEME::RESEARCH::v1*/"));
    // the session's own agent is the only executor: no subagent run is offered
    assert.match(instructions, /You execute the plan yourself/);
    assert.match(instructions, /no subagent runs/);
    assert.ok(
      !/orchestrat/i.test(instructions),
      "instructions must not mention orchestration at all",
    );
    assert.ok(!/strict|light mode/i.test(instructions), "no mode wording left");
    // the injected message must carry the layer-0 body unchanged, or the model
    // follows one protocol and gets another when the system prompt takes over
    assert.ok(
      prompts
        .buildEpistemeActivationMessage("/d.pi_episteme")
        .endsWith(instructions),
    );
    assert.match(prompts.buildEpistemeRevocationMessage(), /mode is now OFF/);
    assert.ok(
      prompts
        .buildContinueMessage("S3", "run tests")
        .includes('execute S3: "run tests"'),
    );
  });

  console.log("index.ts — extension wiring + tool");

  const factory = (await jiti.import(join(here, "index.ts"))).default;
  const handlers = {};
  const tools = {};
  const commands = {};
  const transformers = [];
  const sentMessages = [];
  const continuedMessages = [];
  const mockPi = {
    on: (name, handler) => {
      handlers[name] ??= [];
      handlers[name].push(handler);
    },
    registerTool: (t) => {
      tools[t.name] = t;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    registerMarkdownTransformer: (fn) => {
      transformers.push(fn);
    },
    registerMessageRenderer: () => {},
    sendUserMessage: (message) => continuedMessages.push(message),
    appendEntry: (customType, data) => {
      branch.push({
        type: "custom",
        id: `boundary-${branch.length + 1}`,
        customType,
        data,
      });
    },
    sendMessage: (msg, opts) => {
      sentMessages.push({ msg, opts });
    },
  };

  factory(mockPi);

  await test("factory registers all events, tool and command", () => {
    for (const name of [
      "session_start",
      "before_agent_start",
      "session_before_compact",
      "agent_settled",
      "turn_end",
      "session_compact",
    ]) {
      assert.ok(handlers[name]?.length, `missing handler: ${name}`);
    }
    assert.ok(tools.episteme, "missing tool: episteme");
    assert.ok(commands.episteme, "missing command: /episteme");
    assert.ok(commands["episteme-on"], "missing command: /episteme-on");
    assert.ok(commands["episteme-off"], "missing command: /episteme-off");
    assert.equal(
      commands["episteme-orchestrate"],
      undefined,
      "GVS orchestration command must be gone",
    );
    assert.deepEqual(
      [...tools.episteme.parameters.properties.action.enum].sort(),
      ["advance", "status"],
      "the tool exposes advance/status only",
    );
    assert.ok(transformers.length >= 1, "missing markdown transformer");
  });

  // Mutable branch shared by the tool tests (branchText scans it).
  const branch = [];
  const branchMsg = (text, id) => ({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  });

  const tCtx = {
    cwd: workDir,
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: {
      getSessionFile: () => join(workDir, "2026.jsonl"),
      getSessionId: () => "test-session",
      getBranch: () => branch,
      getLeafId: () => branch[branch.length - 1]?.id ?? null,
    },
    getContextUsage: () => ({
      tokens: null,
      contextWindow: 8000,
      percent: null,
    }),
    compact: () => {},
  };
  const tDir = join(workDir, "2026.pi_episteme");
  const tP = episteme.epistemePaths(tDir);

  // establish the session (sets rt.epistemeDir from the session file path)
  handlers.session_start[0]({ type: "session_start" }, tCtx);

  // Drain a pending phase the way a failing turn end does, so a phase accepted
  // by one test cannot leak into the next (advance allows one phase at a time).
  const clearPending = async () => {
    await handlers.agent_settled[0](
      { type: "agent_settled" },
      {
        ...tCtx,
        compact: (opts) =>
          opts.onError(new Error("Nothing to compact (session too small)")),
      },
    );
  };

  // Anchor-display tests: pin the effective config (project settings file +
  // a session_start re-resolve) so the assertions never depend on the
  // machine's real global settings.
  writeFileSync(join(workDir, "2026.jsonl"), "");
  writeSettings(projectSettings, { piEpisteme: { hideAnchors: true } });
  handlers.session_start[0]({ type: "session_start" }, tCtx);

  await test("markdown transformer hides EPISTEME anchors (display-only)", () => {
    const t = transformers[transformers.length - 1];
    const ctx = {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 100,
    };
    const md = `Привет!\n\n${R}\n\n${PLAN1}`;
    const out = t(md, ctx);
    assert.ok(!out.includes("EPISTEME::"), "anchors hidden in assistant text");
    assert.ok(out.includes("stack: node"), "research body kept");
    assert.ok(out.includes("- [ ] write parser"), "plan body kept");
    // thinking blocks are transformed like assistant text (incl. streaming)
    assert.ok(
      !t(R, {
        messageType: "assistant-thinking",
        isStreaming: true,
        availableWidth: 100,
      }).includes("EPISTEME::"),
    );
    // user messages are untouched
    assert.equal(
      t(md, { messageType: "user", isStreaming: false, availableWidth: 100 }),
      md,
    );
    // idempotent on re-render (terminal resize re-runs the chain)
    assert.equal(t(out, ctx), out);
  });

  await test("hideAnchors: config toggle re-resolved on session_start", async () => {
    const t = transformers[transformers.length - 1];
    const ctx = {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 100,
    };
    const md = `x\n\n${R}`;
    const statusText = async () => {
      const r = await tools.episteme.execute(
        "s-anchor",
        { action: "status" },
        undefined,
        undefined,
        tCtx,
      );
      return r.content[0].text;
    };
    const savedEnv = process.env.PI_EPISTEME_HIDE_ANCHORS;
    try {
      // project config: show the anchors
      delete process.env.PI_EPISTEME_HIDE_ANCHORS;
      writeSettings(projectSettings, { piEpisteme: { hideAnchors: false } });
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(t(md, ctx).includes("EPISTEME::"), "hideAnchors=false shows");
      assert.ok((await statusText()).includes("anchors=shown"));

      // project config: hide the anchors again
      writeSettings(projectSettings, { piEpisteme: { hideAnchors: true } });
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(!t(md, ctx).includes("EPISTEME::"), "hideAnchors=true hides");
      assert.ok((await statusText()).includes("anchors=hidden"));

      // env "0" overrides config true
      process.env.PI_EPISTEME_HIDE_ANCHORS = "0";
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(t(md, ctx).includes("EPISTEME::"), "env 0 shows");

      // env "1" overrides config false
      writeSettings(projectSettings, { piEpisteme: { hideAnchors: false } });
      process.env.PI_EPISTEME_HIDE_ANCHORS = "1";
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(!t(md, ctx).includes("EPISTEME::"), "env 1 hides");
    } finally {
      if (savedEnv === undefined) delete process.env.PI_EPISTEME_HIDE_ANCHORS;
      else process.env.PI_EPISTEME_HIDE_ANCHORS = savedEnv;
      // leave the session in the default hidden state for later tests
      writeSettings(projectSettings, { piEpisteme: { hideAnchors: true } });
      handlers.session_start[0]({ type: "session_start" }, tCtx);
    }
  });

  await test("reload: compaction rehydrates session state without session_start", async () => {
    const reloadedHandlers = {};
    const reloadedCommands = {};
    factory({
      on: (name, handler) => {
        reloadedHandlers[name] ??= [];
        reloadedHandlers[name].push(handler);
      },
      registerTool: () => {},
      registerCommand: (name, def) => {
        reloadedCommands[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
    });
    // a /reload starts a fresh runtime: the mode is off again — opt in
    await reloadedCommands["episteme-on"].handler("", tCtx);
    const res = await reloadedHandlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      tCtx,
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.episteme.mode, "plain");
  });

  await test("before_agent_start injects static instructions (layer 0)", async () => {
    // the session started off (default): opt in for this test
    await commands["episteme-on"].handler("", tCtx);
    const res = handlers.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE SYSTEM",
      systemPromptOptions: {},
    });
    assert.ok(res.systemPrompt.startsWith("BASE SYSTEM\n\n"));
    assert.ok(res.systemPrompt.includes("PI-EPISTEME"));
    assert.ok(res.systemPrompt.includes("/*EPISTEME::RESEARCH::v1*/"));
    assert.ok(res.systemPrompt.includes("/*EPISTEME::PLAN::v1*/"));
    assert.ok(res.systemPrompt.includes("/*EPISTEME::STEP-ID::v1*/"));
    assert.ok(res.systemPrompt.includes(tP.tmp));
    // static: two calls give identical bytes
    assert.equal(
      res.systemPrompt,
      handlers.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE SYSTEM",
        systemPromptOptions: {},
      }).systemPrompt,
    );
  });

  const exec = tools.episteme.execute;

  // Widgets are pi-lens-style component factories now: render them with a
  // plain (colorless) theme to get the line text.
  const plainTheme = { fg: (_color, text) => text };
  const renderWidget = (content, width = 200) =>
    typeof content === "function"
      ? content({}, plainTheme).render(width)
      : content;

  await test("state: off by default; /episteme-on enables it for the session only", async () => {
    const notifs = [];
    const widgets = {};
    const cmdCtx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (msg, level) => notifs.push([msg, level]),
        setWidget: (key, content, opts) => {
          widgets[key] = [content, opts];
        },
        confirm: async () => true,
      },
    };
    // fresh session: the mode is off by default (no settings/env involved)
    handlers.session_start[0]({ type: "session_start" }, cmdCtx);
    assert.deepEqual(renderWidget(widgets["episteme-mode"][0]), [" episteme  off"]);
    assert.equal(widgets["episteme-mode"][1].placement, "belowEditor");

    // no layer-0 instructions
    assert.equal(
      handlers.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      }),
      undefined,
    );

    // pi's default compaction (no episteme summary)
    const res = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      cmdCtx,
    );
    assert.equal(res, undefined);

    // advance is refused
    const e = await exec(
      "dis-1",
      { action: "advance" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(e.isError);
    assert.ok(e.content[0].text.includes("disabled"));
    assert.ok(e.content[0].text.includes("/episteme-on"));

    // status reports the mode
    const s = await exec(
      "dis-2",
      { action: "status" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(s.content[0].text.includes("state: off"));

    // /episteme-on: session-scoped enable, no settings file is written
    const settingsBefore = readFileSync(projectSettings, "utf8");
    await commands["episteme-on"].handler("", cmdCtx);
    assert.equal(
      readFileSync(projectSettings, "utf8"),
      settingsBefore,
      "no settings file written",
    );
    assert.deepEqual(renderWidget(widgets["episteme-mode"][0]), [" episteme  on"]);
    assert.ok(notifs.some(([m, l]) => l === "info" && m.includes("enabled")));

    // episteme compaction and instructions come back
    const res2 = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      cmdCtx,
    );
    assert.ok(res2?.compaction, "episteme compaction back when enabled");
    assert.ok(
      handlers.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      }).systemPrompt.includes("PI-EPISTEME"),
    );
    const s2 = await exec(
      "dis-3",
      { action: "status" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(s2.content[0].text.includes("state: on"));

    // a new session starts off again (the mode is not persisted)
    handlers.session_start[0]({ type: "session_start" }, cmdCtx);
    assert.deepEqual(renderWidget(widgets["episteme-mode"][0]), [" episteme  off"]);
  });

  await test("episteme-on: idempotent when already on", async () => {
    const notifs = [];
    const cmdCtx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (msg) => notifs.push(msg),
        setWidget: () => {},
        confirm: async () => true,
      },
    };
    await commands["episteme-on"].handler("", cmdCtx);
    await commands["episteme-on"].handler("", cmdCtx);
    assert.ok(notifs.some((m) => m.includes("already on")));
    const s = await exec(
      "dis-4",
      { action: "status" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(s.content[0].text.includes("state: on"));
  });

  await test("episteme-on on an existing session defers the system prompt (KV-cache guard)", async () => {
    const sent = [];
    const h = {};
    const cmds = {};
    const toolsA = {};
    factory({
      on: (name, handler) => {
        h[name] ??= [];
        h[name].push(handler);
      },
      registerTool: (t) => {
        toolsA[t.name] = t;
      },
      registerCommand: (name, def) => {
        cmds[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg, opts) => sent.push({ msg, opts }),
    });
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (message, level) => notes.push([level, message]),
        setWidget: () => {},
        confirm: async () => true,
      },
    };
    h.session_start[0]({ type: "session_start" }, ctx);
    // the session already carries context (a message in the branch):
    branch.length = 0;
    branch.push(branchMsg("earlier work", "e1"));
    await cmds["episteme-on"].handler("", ctx);
    // standing instructions queued for the next turn (end of the context):
    assert.equal(sent.length, 1, "one instructions message queued");
    assert.deepEqual(sent[0].opts, { deliverAs: "nextTurn" });
    assert.equal(sent[0].msg.customType, "episteme-instructions");
    assert.equal(sent[0].msg.display, true);
    assert.ok(sent[0].msg.content.includes("/*EPISTEME::RESEARCH::v1*/"));
    assert.ok(sent[0].msg.content.includes(tP.tmp));
    assert.ok(
      notes.some(
        ([level, message]) =>
          level === "info" && message.includes("standing instructions queued"),
      ),
    );
    // the system prompt is untouched until the next compaction:
    assert.equal(
      h.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE SYSTEM",
        systemPromptOptions: {},
      }),
      undefined,
    );
    const statusA = (id) =>
      toolsA.episteme.execute(
        id,
        { action: "status" },
        undefined,
        undefined,
        ctx,
      );
    const s1 = await statusA("kv-1");
    assert.ok(s1.content[0].text.includes("sysprompt: deferred"));
    // the next compaction rewrites the context: the deferral is lifted and
    // the system prompt picks the instructions up from the next turn on:
    h.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "cA",
          summary: "s",
          firstKeptEntryId: "m2",
          tokensBefore: 1,
          fromHook: true,
          details: {},
        },
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    const res = h.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE SYSTEM",
      systemPromptOptions: {},
    });
    assert.ok(res.systemPrompt.startsWith("BASE SYSTEM\n\n"));
    assert.ok(res.systemPrompt.includes("PI-EPISTEME"));
    const s2 = await statusA("kv-2");
    assert.ok(s2.content[0].text.includes("sysprompt: active"));
    assert.ok(
      notes.some(
        ([level, message]) =>
          level === "info" && message.includes("moved to the system prompt"),
      ),
    );
  });

  await test("episteme-on queues instructions for an existing headless session", async () => {
    const sent = [];
    const h = {};
    const cmds = {};
    factory({
      on: (name, handler) => {
        h[name] ??= [];
        h[name].push(handler);
      },
      registerTool: () => {},
      registerCommand: (name, def) => {
        cmds[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg, opts) => sent.push({ msg, opts }),
    });
    const ctx = { ...tCtx, hasUI: false };
    h.session_start[0]({ type: "session_start" }, ctx);
    branch.length = 0;
    branch.push(branchMsg("earlier work", "headless-1"));

    await cmds["episteme-on"].handler("", ctx);

    assert.equal(sent.length, 1, "instructions queued without a TUI");
    assert.deepEqual(sent[0].opts, { deliverAs: "nextTurn" });
    assert.equal(sent[0].msg.customType, "episteme-instructions");
    assert.ok(sent[0].msg.content.includes("/*EPISTEME::STEP-ID::v1*/"));
  });

  await test("episteme-on on an empty session updates the system prompt immediately", async () => {
    const sent = [];
    const h = {};
    const cmds = {};
    factory({
      on: (name, handler) => {
        h[name] ??= [];
        h[name].push(handler);
      },
      registerTool: () => {},
      registerCommand: (name, def) => {
        cmds[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg, opts) => sent.push({ msg, opts }),
    });
    h.session_start[0]({ type: "session_start" }, tCtx);
    branch.length = 0; // fresh session: no LLM context yet
    await cmds["episteme-on"].handler("", tCtx);
    assert.equal(sent.length, 0, "no message queued on a fresh session");
    const res = h.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE SYSTEM",
      systemPromptOptions: {},
    });
    assert.ok(res.systemPrompt.startsWith("BASE SYSTEM\n\n"));
    assert.ok(res.systemPrompt.includes("PI-EPISTEME"));
  });

  await test("advance: validation errors (no blocks / no plan / step without report / unchecked item)", async () => {
    branch.length = 0;
    const e0 = await exec(
      "a0",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(e0.isError, "no EPISTEME:: blocks at all");

    branch.push(branchMsg(`Investigation:\n${R}`, "b1"));
    const e1 = await exec(
      "a1",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(e1.isError, "research only, no PLAN");

    branch.push(branchMsg(`Plan:\n${PLAN1}`, "b2"));
    const e2 = await exec(
      "a2",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(e2.isError, "no STEP-1 block");

    const step1 = "/*EPISTEME::STEP-1::v1*/\nreport\n/*EPISTEME::END::STEP-1::v1*/";
    branch.push(branchMsg(`${PLAN1}\n${step1}`, "b3"));
    const e3 = await exec(
      "a3",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!e3.isError, "STEP-1 report is the completion record");
    await clearPending();
  });

  await test("advance: plan accepted -> first compaction queued", async () => {
    branch.length = 0;
    branch.push(branchMsg(`Investigation:\n${R}\n\nPlan:\n${PLAN1}`, "b4"));
    const r = await exec(
      "a4",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.includes("write parser"));
    assert.ok(r.content[0].text.includes("Next: execute 1"));
    await clearPending();
  });

  await test("advance step: accepted with immutable plan + STEP block", async () => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "c1",
      summary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
      }),
    });
    branch.push(
      branchMsg(
        `/*EPISTEME::STEP-1::v1*/
implemented parser; files: src/parser.ts; tests green
/*EPISTEME::END::STEP-1::v1*/`,
        "b5",
      ),
    );
    const r = await exec(
      "a5",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.includes("step_1_raw.md"));
    assert.ok(r.content[0].text.includes("add tests"));
    await clearPending();
  });

  await test("status: reports extracted plan state", async () => {
    const r = await exec(
      "a6",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.includes("research: yes"));
    assert.ok(r.content[0].text.includes("state: on"));
    assert.ok(r.content[0].text.includes("plan: 1/2"));
    assert.ok(r.content[0].text.includes("reports: [1]"));
  });

  await test("agent_settled fires queued compact", async () => {
    // Self-contained: accept the phase here rather than inheriting the pending
    // request of the previous test.
    const accepted = await exec(
      "a6q",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!accepted.isError, accepted.content[0].text);
    let compacted = null;
    const settleCtx = { ...tCtx, compact: (opts) => (compacted = opts) };
    await handlers.agent_settled[0]({ type: "agent_settled" }, settleCtx);
    assert.ok(compacted);
    assert.ok(compacted.customInstructions.startsWith("step:1"));
    await clearPending();
  });

  await test("queued step survives agent_settled and is consumed by compaction", async () => {
    // Accept the phase and let agent_settled queue it, as a real turn does.
    const accepted = await exec(
      "a6r",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!accepted.isError, accepted.content[0].text);
    await handlers.agent_settled[0](
      { type: "agent_settled" },
      { ...tCtx, compact: () => {} },
    );
    const event = makeEvent({
      previousSummary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
      }),
      messagesToSummarize: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `${PLAN1_DONE}\n/*EPISTEME::STEP-1::v1*/\nreport\n/*EPISTEME::END::STEP-1::v1*/`,
            },
          ],
        },
      ],
    });
    const res = await handlers.session_before_compact[0](event, tCtx);
    assert.equal(res.compaction.details.episteme.mode, "step");
    assert.equal(res.compaction.details.episteme.stepN, 1);
    const status = await exec(
      "a7",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(status.content[0].text.includes("pending: none"));
  });

  await test("failed small-session phase compaction clears the pending marker", async () => {
    branch.length = 0;
    branch.push(branchMsg(`${R}\n${PLAN1}`, "b-small"));
    const accepted = await exec(
      "a-small",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!accepted.isError);
    let requested = null;
    const ctx = { ...tCtx, compact: (opts) => (requested = opts) };
    await handlers.agent_settled[0]({ type: "agent_settled" }, ctx);
    assert.ok(requested?.onError);
    requested.onError(new Error("Nothing to compact (session too small)"));
    const status = await exec(
      "a-small-status",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(status.content[0].text.includes("pending: none"));
  });

  // These tests queue a phase compaction; release the marker through pi's own
  // clearing path (failed manual compaction) so it cannot leak downstream.
  await test("advance: a re-emitted PLAN keeps the reports and stays silent", async () => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "c7",
      summary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
        reports: [{ n: 1, text: "did parser" }],
      }),
    });
    branch.push(
      branchMsg(
        "/*EPISTEME::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n/*EPISTEME::END::PLAN::v1*/",
        "b7",
      ),
    );
    const r = await exec(
      "a7",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    const text = r.content[0].text;
    assert.ok(!r.isError, text);
    // reports survived the plan update, so step 1 validates and nothing is
    // announced (same cycle, same item positions)
    assert.ok(!text.includes("cycle"), text);
    assert.ok(!text.includes("item count"), text);
    const st = await exec("a7s", { action: "status" }, undefined, undefined, tCtx);
    assert.ok(st.content[0].text.includes("reports: [1]"));
    await clearPending();
  });

  await test("advance: a new RESEARCH cycle names the dropped reports", async () => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "c8",
      summary: episteme.buildEpistemeSummary({
        research: "old task research",
        plan: "- [ ] a\n- [ ] b",
        reports: [
          { n: 1, text: "did a" },
          { n: 2, text: "did b" },
        ],
      }),
    });
    branch.push(
      branchMsg(
        "New task.\n/*EPISTEME::RESEARCH::v1*/\nnext task research\n/*EPISTEME::END::RESEARCH::v1*/\n/*EPISTEME::PLAN::v1*/\n- [ ] c\n- [ ] d\n/*EPISTEME::END::PLAN::v1*/",
        "b8",
      ),
    );
    const r = await exec(
      "a8",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    const text = r.content[0].text;
    assert.ok(!r.isError, text);
    assert.ok(text.includes("new task cycle"), text);
    assert.ok(text.includes("[1,2]"), text);
    await clearPending();
  });

  await test("advance: legacy plan insertion no longer remaps a completed report", async () => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "c9",
      summary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [x] a\n- [ ] b",
        reports: [{ n: 1, text: "did a" }],
      }),
    });
    branch.push(
      branchMsg(
        "/*EPISTEME::PLAN::v1*/\n- [x] a\n- [ ] insert extra\n- [ ] b\n/*EPISTEME::END::PLAN::v1*/",
        "b9",
      ),
    );
    const r = await exec(
      "a9",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    const text = r.content[0].text;
    assert.ok(!r.isError, text);
    assert.ok(text.includes("Next: execute 2"), text);
    await clearPending();
    assert.ok(!text.includes("new task cycle"), text);
  });

  await test("turn_end updates the plan dashboard widget", async () => {
    branch.length = 0;
    branch.push(branchMsg(`Plan:\n${PLAN1}`, "w1"));
    branch.push(
      branchMsg(
        `${PLAN1}\n/*EPISTEME::STEP-1::v1*/\nparser done\n/*EPISTEME::END::STEP-1::v1*/`,
        "w2",
      ),
    );
    const widgets = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: (key, lines) => widgets.push([key, lines]),
      },
    };
    const lastSet = (key) => {
      for (let i = widgets.length - 1; i >= 0; i--)
        if (widgets[i][0] === key) return widgets[i];
      return null;
    };
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.deepEqual(renderWidget(lastSet("episteme")[1]), [
      " episteme  1/2 ✓▶  next: 2 add tests",
    ]);
    // the mode indicator is redundant while the dashboard is visible
    assert.deepEqual(lastSet("episteme-mode"), ["episteme-mode", undefined]);
    // non-episteme branch: dashboard hidden, mode indicator back
    branch.length = 0;
    branch.push(branchMsg("hello", "w3"));
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.equal(lastSet("episteme")[1], undefined);
    assert.deepEqual(renderWidget(lastSet("episteme-mode")[1]), [" episteme  on"]);
  });

  await test("turn_end widget: next label is the item part before the first colon", async () => {
    branch.length = 0;
    branch.push(
      branchMsg(
        `Plan:\n/*EPISTEME::PLAN::v1*/\n- [ ] Step 1 (Makefile): add build and test targets to the Makefile\n- [ ] ship\n/*EPISTEME::END::PLAN::v1*/`,
        "w4",
      ),
    );
    const widgets = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: (key, lines) => widgets.push([key, lines]),
      },
    };
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    // the first set of the turn is the dashboard (the mode widget is
    // cleared behind it — redundant while the dashboard is visible)
    assert.deepEqual(renderWidget(widgets[0][1]), [
      " episteme  0/2 ▶·  next: 1 Step 1 (Makefile)",
    ]);
    // narrow terminal: the line is fitted to the width, not wrapped
    const narrow = renderWidget(widgets[0][1], 20);
    assert.equal(episteme.visibleWidth(narrow[0]), 20);
    assert.ok(narrow[0].endsWith("…"));
  });

  await test("turn_end widget: colon-less next label is truncated at 56", async () => {
    // no colon in the item: the full text is the label (the colon is
    // replaced by a comma on purpose — a colon would cut it first)
    const long =
      "update the blocksToLayers test in check.cjs, the report before the new PLAN is now dropped";
    branch.length = 0;
    branch.push(
      branchMsg(
        `Plan:\n/*EPISTEME::PLAN::v1*/\n- [ ] ${long}\n/*EPISTEME::END::PLAN::v1*/`,
        "w5",
      ),
    );
    const widgets = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: (key, lines) => widgets.push([key, lines]),
      },
    };
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.deepEqual(renderWidget(widgets[0][1]), [
      ` episteme  0/1 ▶  next: 1 ${long.slice(0, 55)}…`,
    ]);
  });

  await test("session_compact warns when another extension replaced the episteme result", async () => {
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (message, type) => notes.push([type, message]),
        setWidget: () => {},
      },
    };
    // the before handler returns a episteme result (marks compactOurs)
    const before = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      ctx,
    );
    assert.ok(before?.compaction);
    assert.ok(before.compaction.details.episteme);
    notes.length = 0; // drop the plain-mode no-model fallback note

    // normal: our own entry was saved -> info, no warning
    handlers.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c-own",
          summary: before.compaction.summary,
          firstKeptEntryId: "m2",
          tokensBefore: 1234,
          fromHook: true,
          details: before.compaction.details,
        },
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    assert.ok(notes.some(([type]) => type === "info"));
    assert.ok(!notes.some(([type]) => type === "warning"));

    // conflict: another extension's entry (no episteme marker) was saved
    handlers.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c-foreign",
          summary: "foreign summary",
          firstKeptEntryId: "m2",
          tokensBefore: 1234,
          fromHook: true,
        },
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    assert.ok(
      notes.some(
        ([type, message]) =>
          type === "warning" && message.includes("replaced it"),
      ),
    );
  });

  await test("agent_settled with no pending request does nothing", async () => {
    branch.length = 0;
    branch.push(branchMsg(`${R}\n${PLAN1}`, "b-idle"));
    let compacted = null;
    const ctx = { ...tCtx, compact: (opts) => (compacted = opts) };
    await handlers.agent_settled[0]({ type: "agent_settled" }, ctx);
    assert.equal(compacted, null);
  });

  const stableSummary = () => episteme.buildEpistemeSummary({
    research: "stable research",
    plan: "- [id:S1] first\n- [id:S2] second",
    reports: [{ key: "S1", text: "first complete" }],
  });

  await test("advance: stable-ID STEP and PLAN-DELTA preserve completed work", async () => {
    branch.length = 0;
    branch.push({ type: "compaction", id: "stable-c1", summary: stableSummary() });
    branch.push(branchMsg(episteme.epistemeBlock("STEP-S2", "second complete"), "stable-m1"));
    const stepped = await exec("stable-1", { action: "advance", step: "S2" }, undefined, undefined, tCtx);
    assert.ok(!stepped.isError, stepped.content[0].text);
    assert.ok(stepped.content[0].text.includes("All plan steps are complete"));
    await clearPending();

    branch.length = 0;
    branch.push({ type: "compaction", id: "stable-c2", summary: stableSummary() });
    branch.push(branchMsg(episteme.epistemeBlock(
      "PLAN-DELTA",
      "- [id:S1] first\n- [id:S2] second\n- [id:S3] third",
    ), "stable-m2"));
    const changed = await exec("stable-2", { action: "advance" }, undefined, undefined, tCtx);
    assert.ok(!changed.isError, changed.content[0].text);
    assert.ok(changed.content[0].text.includes("Next: execute S2"));
    const status = await exec("stable-status", { action: "status" }, undefined, undefined, tCtx);
    assert.ok(status.content[0].text.includes("plan: 1/3"));
    await clearPending();
  });

  await test("advance: duplicate/unknown IDs, stale RESEARCH and completed edits are rejected", async () => {
    branch.length = 0;
    branch.push(branchMsg(`${R}\n${episteme.epistemeBlock("PLAN", "- [id:S1] a\n- [id:S1] b")}`, "invalid-dup"));
    const duplicate = await exec("invalid-1", { action: "advance" }, undefined, undefined, tCtx);
    assert.ok(duplicate.isError);
    assert.ok(duplicate.content[0].text.includes("Duplicate plan item ID"));

    branch.length = 0;
    branch.push({ type: "compaction", id: "invalid-c1", summary: stableSummary() });
    branch.push(branchMsg(R, "invalid-research"));
    const stale = await exec("invalid-2", { action: "advance" }, undefined, undefined, tCtx);
    assert.ok(stale.isError);
    assert.ok(stale.content[0].text.includes("requires a new base PLAN"));

    branch.length = 0;
    branch.push({ type: "compaction", id: "invalid-c2", summary: stableSummary() });
    branch.push(branchMsg(episteme.epistemeBlock("PLAN-DELTA", "- [id:S1] changed\n- [id:S2] second"), "invalid-edit"));
    const edited = await exec("invalid-3", { action: "advance" }, undefined, undefined, tCtx);
    assert.ok(edited.isError);
    assert.ok(edited.content[0].text.includes("completed items are immutable"));
    branch.length = 0;
    branch.push({ type: "compaction", id: "invalid-c3", summary: stableSummary() });
    const unknown = await exec("invalid-4", { action: "advance", step: "S9" }, undefined, undefined, tCtx);
    assert.ok(unknown.isError);
    assert.ok(unknown.content[0].text.includes("no plan item with ID S9"));
    const fractional = await exec("invalid-5", { action: "advance", step: 1.5 }, undefined, undefined, tCtx);
    assert.ok(fractional.isError);
    assert.ok(fractional.content[0].text.includes("integer >= 1"));
  });

  await test("advance: archived milestone completion unblocks the next step", async () => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "archived-c1",
      summary: episteme.buildEpistemeSummary({
        research: "archived research",
        plan: "- [id:S1] first\n- [id:S2] second",
        milestones: [{ n: 1, text: "Completed-Steps: S1\n\ndigest", completed: ["S1"] }],
      }),
    });
    branch.push(branchMsg(episteme.epistemeBlock("STEP-S2", "second complete"), "archived-m1"));
    const result = await exec("archived-1", { action: "advance", step: "S2" }, undefined, undefined, tCtx);
    assert.ok(!result.isError, result.content[0].text);
    await clearPending();
  });

  await test("/episteme unknown subcommand and headless reset both speak up", async () => {
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (message, level) => notes.push([message, level]),
        setWidget: () => {},
      },
    };
    await commands.episteme.handler("comapct", ctx);
    assert.ok(
      notes.some(
        ([m, level]) =>
          level === "warning" && m.includes('unknown subcommand "comapct"'),
      ),
      "a typo must not look like a successful status call",
    );
    assert.ok(notes.some(([m]) => m.includes("dir:")), "status is still shown");
    notes.length = 0;
    await commands.episteme.handler("reset", {
      ...tCtx,
      hasUI: false,
      ui: { notify: (message, level) => notes.push([message, level]) },
    });
    assert.ok(
      notes.some(([m, level]) => level === "error" && m.includes("reset needs")),
      "headless reset explains why it did nothing",
    );
  });

  await test("cancelled compaction keeps the phase boundary for a retry", async () => {
    branch.length = 0;
    handlers.session_start[0]({ type: "session_start" }, tCtx);
    await commands["episteme-on"].handler("light", tCtx);
    branch.push(branchMsg(`${R}\n${PLAN1}`, "b-cancel"));
    const accepted = await exec(
      "cancel-1",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!accepted.isError);
    let requested = null;
    await handlers.agent_settled[0](
      { type: "agent_settled" },
      { ...tCtx, compact: (opts) => (requested = opts) },
    );
    requested.onError(new Error("Compaction cancelled"));
    const kept = await exec(
      "cancel-2",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.match(kept.content[0].text, /pending: plan/, "phase survives a cancel");
    // a hard failure still drops it, so the request cannot leak forever
    await handlers.agent_settled[0](
      { type: "agent_settled" },
      {
        ...tCtx,
        compact: (opts) =>
          opts.onError(new Error("Nothing to compact (session too small)")),
      },
    );
    const after = await exec(
      "cancel-3",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.match(after.content[0].text, /pending: none/);
  });

  await test("no bogus 'summary was replaced' warning after /episteme-off", async () => {
    branch.length = 0;
    handlers.session_start[0]({ type: "session_start" }, tCtx);
    await commands["episteme-on"].handler("light", tCtx);
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (message, level) => notes.push([message, level]),
        setWidget: () => {},
      },
    };
    const before = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      ctx,
    );
    assert.ok(before?.compaction);
    handlers.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c-own",
          summary: before.compaction.summary,
          firstKeptEntryId: "m2",
          tokensBefore: 1,
          details: before.compaction.details,
        },
        fromExtension: true,
      },
      ctx,
    );
    await commands["episteme-off"].handler("", ctx);
    notes.length = 0;
    const plain = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg("plain work after off")] }),
      ctx,
    );
    assert.equal(plain, undefined, "disabled: pi's default compaction runs");
    handlers.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c-default",
          summary: "plain pi summary",
          firstKeptEntryId: "m2",
          tokensBefore: 1,
        },
        fromExtension: false,
      },
      ctx,
    );
    assert.ok(
      !notes.some(([, level]) => level === "warning"),
      "a compaction we never produced must not be reported as a stolen summary",
    );
  });

  await test("off/on/pause/resume and degraded auto-continuation", async () => {
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      waitForIdle: async () => {},
      ui: { notify: (message, level) => notes.push([message, level]), setWidget: () => {} },
    };
    branch.length = 0;
    handlers.session_start[0]({ type: "session_start" }, ctx);
    await commands["episteme-on"].handler("", ctx);
    const instructions = handlers.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE",
      systemPromptOptions: {},
    });
    assert.ok(instructions.systemPrompt.includes("PI-EPISTEME"));
    await commands.episteme.handler("pause", ctx);

    branch.length = 0;
    branch.push(branchMsg(episteme.epistemeBlock("RESEARCH", "deferred research"), "defer-m1"));
    branch.push(branchMsg(episteme.epistemeBlock("PLAN", "- [id:S1] first"), "defer-m2"));
    continuedMessages.length = 0;
    const accepted = await exec("defer-1", { action: "advance" }, undefined, undefined, ctx);
    assert.ok(!accepted.isError);
    let requested;
    const compactCtx = { ...ctx, compact: (options) => { requested = options; } };
    await handlers.agent_settled[0]({ type: "agent_settled" }, compactCtx);
    assert.ok(requested?.onError);
    requested.onError(new Error("Nothing to compact (session too small)"));
    assert.equal(continuedMessages.length, 0, "pause suppresses degraded continuation");
    const deferredStatus = await exec("defer-status", { action: "status" }, undefined, undefined, ctx);
    assert.ok(deferredStatus.content[0].text.includes("state: paused"));
    assert.ok(deferredStatus.content[0].text.includes("deferred=1"));
    assert.ok(deferredStatus.content[0].text.includes("pending: none"));

    await commands.episteme.handler("resume", ctx);
    assert.equal(continuedMessages.length, 1);
    assert.ok(continuedMessages[0].includes("execute S1"));

    const sentBeforeOff = sentMessages.length;
    await commands["episteme-off"].handler("", ctx);
    assert.equal(sentMessages.length, sentBeforeOff + 1);
    assert.ok(sentMessages[sentMessages.length - 1].msg.content.includes("instructions are revoked"));
    assert.equal(handlers.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE",
      systemPromptOptions: {},
    }), undefined);
    const disabled = await exec("defer-off", { action: "advance" }, undefined, undefined, ctx);
    assert.ok(disabled.isError);
    assert.ok(notes.some(([message]) => message.includes("disabled for this session")));
  });

  await test("degraded plan continuation queues the next item for the agent", async () => {
    handlers.session_start[0]({ type: "session_start" }, tCtx);
    await commands["episteme-on"].handler("", tCtx);
    branch.length = 0;
    branch.push(branchMsg(`${R}\n${PLAN1}`, "defer-auto"));
    continuedMessages.length = 0;
    const accepted = await exec("defer-auto-1", { action: "advance" }, undefined, undefined, tCtx);
    assert.ok(!accepted.isError);
    let requested;
    await handlers.agent_settled[0]({ type: "agent_settled" }, {
      ...tCtx,
      compact: (options) => { requested = options; },
    });
    requested.onError(new Error("Nothing to compact (session too small)"));
    assert.equal(continuedMessages.length, 1);
    assert.ok(continuedMessages[0].includes("execute 1"));
  });

  await test("an unfinished plan auto-continues in this session", async () => {
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: { notify: (message, level) => notes.push([message, level]), setWidget: () => {} },
    };
    handlers.session_start[0]({ type: "session_start" }, ctx);
    await commands["episteme-on"].handler("", ctx);
    branch.length = 0;
    branch.push(branchMsg(`${R}\n${PLAN1}`, "defer-on"));
    continuedMessages.length = 0;
    const accepted = await exec("defer-on-1", { action: "advance" }, undefined, undefined, ctx);
    assert.ok(!accepted.isError);
    let requested;
    await handlers.agent_settled[0]({ type: "agent_settled" }, {
      ...ctx,
      compact: (options) => { requested = options; },
    });
    requested.onError(new Error("Nothing to compact (session too small)"));
    assert.equal(
      continuedMessages.length,
      1,
      "the session's own agent is told to continue with the next item",
    );
  });

  // pi's threshold check runs between turns — after the advance tool result is
  // appended, before the run settles. It then performs the phase compaction
  // itself, and the continuation that rode on the extension's own request must
  // survive the phase request being consumed.
  const owePhase = async (ctx, id) => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: `c-${id}`,
      summary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
      }),
    });
    branch.push(
      branchMsg(
        `/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
        `b-${id}`,
      ),
    );
    const accepted = await exec(
      `owed-${id}`,
      { action: "advance", step: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!accepted.isError, accepted.content[0].text);
    return handlers.session_before_compact[0](
      makeEvent({
        reason: "threshold",
        messages: [
          assistantMsg(
            `${PLAN1_DONE}\n/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
          ),
        ],
      }),
      ctx,
    );
  };

  const enabledCtx = () => {
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: { notify: () => {}, setWidget: () => {} },
    };
    handlers.session_start[0]({ type: "session_start" }, ctx);
    return ctx;
  };

  // A second compaction request after the phase was already closed is a bug:
  // it would pay for the same phase twice, so the harness refuses one.
  const noCompact = (ctx) => ({
    ...ctx,
    compact: () => {
      throw new Error("no second compaction expected for a closed phase");
    },
  });

  await test("a phase compaction run by pi's threshold check queues the continuation", async () => {
    const ctx = enabledCtx();
    await commands["episteme-on"].handler("", ctx);
    const res = await owePhase(ctx, "threshold");
    assert.equal(res.compaction.details.episteme.mode, "step");
    assert.equal(res.compaction.details.episteme.stepId, "1");
    continuedMessages.length = 0;
    await handlers.agent_settled[0]({ type: "agent_settled" }, noCompact(ctx));
    assert.equal(continuedMessages.length, 1, "the owed continuation is delivered");
    assert.match(String(continuedMessages[0]), /add tests/);
    // a further settle must not repeat it
    continuedMessages.length = 0;
    await handlers.agent_settled[0]({ type: "agent_settled" }, noCompact(ctx));
    assert.equal(continuedMessages.length, 0);
  });

  await test("an overflow compaction of a closed phase queues the continuation", async () => {
    const ctx = enabledCtx();
    await commands["episteme-on"].handler("", ctx);
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "c-overflow",
      summary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
      }),
    });
    branch.push(
      branchMsg(
        `/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
        "b-overflow",
      ),
    );
    const accepted = await exec(
      "overflow-1",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!accepted.isError);
    const res = await handlers.session_before_compact[0](
      makeEvent({
        reason: "overflow",
        willRetry: true,
        messages: [
          assistantMsg(
            `${PLAN1_DONE}\n/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
          ),
        ],
      }),
      ctx,
    );
    assert.equal(res.compaction.details.episteme.mode, "step");
    continuedMessages.length = 0;
    await handlers.agent_settled[0]({ type: "agent_settled" }, noCompact(ctx));
    assert.equal(continuedMessages.length, 1);
    assert.match(String(continuedMessages[0]), /add tests/);
  });

  await test("the extension's own phase compaction queues exactly one continuation", async () => {
    const ctx = enabledCtx();
    await commands["episteme-on"].handler("", ctx);
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "c-own",
      summary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
      }),
    });
    branch.push(
      branchMsg(
        `/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
        "b-own",
      ),
    );
    const accepted = await exec(
      "own-1",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!accepted.isError);
    continuedMessages.length = 0;
    let requested;
    await handlers.agent_settled[0]({ type: "agent_settled" }, {
      ...ctx,
      compact: (options) => {
        requested = options;
      },
    });
    // pi runs the request: the handler consumes the phase, then it completes.
    const res = await handlers.session_before_compact[0](
      makeEvent({
        messages: [
          assistantMsg(
            `${PLAN1_DONE}\n/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
          ),
        ],
      }),
      ctx,
    );
    assert.equal(res.compaction.details.episteme.mode, "step");
    requested.onComplete({});
    assert.equal(continuedMessages.length, 1, "one continue message per phase");
    await handlers.agent_settled[0]({ type: "agent_settled" }, noCompact(ctx));
    assert.equal(continuedMessages.length, 1, "no duplicate from the leftover flag");
  });

  await test("/episteme-off drops a continuation owed to a consumed phase", async () => {
    const ctx = enabledCtx();
    await commands["episteme-on"].handler("", ctx);
    await owePhase(ctx, "off");
    await commands["episteme-off"].handler(undefined, ctx);
    continuedMessages.length = 0;
    await handlers.agent_settled[0]({ type: "agent_settled" }, ctx);
    assert.equal(continuedMessages.length, 0, "a disabled mode queues nothing");
    // restore the off default for the tests that follow
    handlers.session_start[0]({ type: "session_start" }, tCtx);
  });

  // ---- phase bookkeeping: one phase per turn, no lost continuations ------

  // A branch with step 1 reported and two items still open, ready for advance.
  const seedStepDone = (planItems, report = "1") => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: `c-seed-${planItems}`,
      summary: episteme.buildEpistemeSummary({
        research: "stack: node",
        plan: [
          "- [ ] write parser",
          "- [ ] add tests",
          "- [ ] ship it",
          "- [ ] write docs",
        ]
          .slice(0, planItems)
          .join("\n"),
      }),
    });
    branch.push(
      branchMsg(
        `/*EPISTEME::STEP-${report}::v1*/\nparser landed\n/*EPISTEME::END::STEP-${report}::v1*/`,
        `b-seed-${planItems}`,
      ),
    );
  };
  const uiNotes = (ctx) => {
    const notes = [];
    return {
      notes,
      ctx: {
        ...ctx,
        waitForIdle: async () => {},
        ui: {
          notify: (message, level) => notes.push([level ?? "info", String(message)]),
          setWidget: () => {},
        },
      },
    };
  };

  await test("manual /episteme compact delivers the continuation of the phase it closed", async () => {
    const ctx = enabledCtx();
    await commands["episteme-on"].handler("", ctx);
    seedStepDone(4);
    const accepted = await exec(
      "manual-1",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!accepted.isError, accepted.content[0].text);

    let requested = null;
    continuedMessages.length = 0;
    await commands.episteme.handler("compact", {
      ...ctx,
      waitForIdle: async () => {},
      compact: (opts) => {
        requested = opts;
      },
    });
    assert.ok(requested?.onComplete, "the manual command requested a compaction");
    // pi runs it, and the pending phase makes it a phase compaction.
    const res = await handlers.session_before_compact[0](
      makeEvent({
        messages: [
          assistantMsg(
            `${PLAN1_DONE}\n/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
          ),
        ],
      }),
      ctx,
    );
    assert.equal(res.compaction.details.episteme.mode, "step");
    requested.onComplete({});
    assert.equal(continuedMessages.length, 1, "the owed continuation is delivered");
    assert.match(String(continuedMessages[0]), /execute 2: "add tests"/);
  });

  await test("a failing phase compaction cancels instead of handing pi the raw layers", async () => {
    const { notes, ctx } = uiNotes(enabledCtx());
    await commands["episteme-on"].handler("", ctx);
    seedStepDone(4);
    // No leaf id -> the phase boundary cannot be named and the handler fails.
    const broken = {
      ...ctx,
      sessionManager: { ...tCtx.sessionManager, getLeafId: () => null },
    };
    const accepted = await exec(
      "throw-1",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      broken,
    );
    assert.ok(!accepted.isError, accepted.content[0].text);
    let res;
    let threw = null;
    try {
      res = await handlers.session_before_compact[0](
        makeEvent({
          reason: "threshold",
          messages: [
            assistantMsg(
              `${PLAN1_DONE}\n/*EPISTEME::STEP-1::v1*/\nparser landed\n/*EPISTEME::END::STEP-1::v1*/`,
            ),
          ],
        }),
        broken,
      );
    } catch (err) {
      threw = err;
    }
    // pi swallows a throwing session_before_compact handler and then summarizes
    // the raw conversation itself: the layers would be gone with no warning.
    assert.equal(threw, null, "the handler must not throw");
    assert.equal(res?.cancel, true, "cancelled, so the context stays intact");
    assert.ok(
      notes.some(([, message]) => message.includes("layers are intact")),
      "the user is told what happened",
    );
    const status = await exec(
      "throw-status",
      { action: "status" },
      undefined,
      undefined,
      broken,
    );
    assert.ok(status.content[0].text.includes("pending: step:1"), "the phase is kept");
    assert.ok(status.content[0].text.includes("deferred=1"));
    await clearPending();
  });

  await test("a second advance in the same turn is refused, not merged into one phase", async () => {
    const ctx = enabledCtx();
    await commands["episteme-on"].handler("", ctx);
    seedStepDone(4);
    const first = await exec(
      "twice-1",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!first.isError, first.content[0].text);
    const again = await exec(
      "twice-2",
      { action: "advance", step: 2 },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(again.isError, "one phase per turn");
    assert.ok(again.content[0].text.includes("already waiting for its phase compaction"));
    await clearPending();
  });

  await test("resume never queues the same plan item twice", async () => {
    const ctx = uiNotes(enabledCtx()).ctx;
    await commands["episteme-on"].handler("", ctx);
    branch.length = 0;
    branch.push(
      branchMsg(
        `${R}\n${episteme.epistemeBlock("PLAN", "- [id:S1] first\n- [id:S2] second")}`,
        "dup-b",
      ),
    );
    continuedMessages.length = 0;
    await commands.episteme.handler("resume", ctx);
    assert.equal(continuedMessages.length, 1, "resume arms the continuation once");
    assert.match(String(continuedMessages[0]), /execute S1/);
    await commands.episteme.handler("resume", ctx);
    assert.equal(continuedMessages.length, 1, "an in-flight item is not queued again");
    // once the item reports, the next one may be queued normally
    branch.push(
      branchMsg(episteme.epistemeBlock("STEP-S1", "first done"), "dup-b2"),
    );
    await commands.episteme.handler("resume", ctx);
    assert.equal(continuedMessages.length, 2, "the completed item releases the guard");
    assert.match(String(continuedMessages[1]), /execute S2/);
  });

  await test("a continuation is deferred while pi is busy, not lost in a rejected send", async () => {
    const ctx = { ...uiNotes(enabledCtx()).ctx, isIdle: () => false };
    await commands["episteme-on"].handler("", ctx);
    branch.length = 0;
    branch.push(
      branchMsg(
        `${R}\n${episteme.epistemeBlock("PLAN", "- [id:S1] first\n- [id:S2] second")}`,
        "busy-b",
      ),
    );
    continuedMessages.length = 0;
    await commands.episteme.handler("resume", ctx);
    assert.equal(
      continuedMessages.length,
      0,
      "pi rejects prompts during a compaction, so nothing is sent",
    );
    const idle = { ...ctx, isIdle: () => true };
    await handlers.agent_settled[0]({ type: "agent_settled" }, idle);
    assert.equal(continuedMessages.length, 1, "the next settle delivers it");
    assert.match(String(continuedMessages[0]), /execute S1/);
  });

  rmSync(workDir, { recursive: true, force: true });
  console.log(`\n${passed} tests passed`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
