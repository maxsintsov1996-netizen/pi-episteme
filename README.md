<p align="center"><img src="./img/pi-episteme.png" alt="pi-episteme" width="180"></p>

# pi-episteme

**Context-aware agent orchestration** for
[pi-coding-agent](https://github.com/badlogic/pi-mono) with local LLMs.

Two cooperating levels:

1. **Layered context compaction** — a research → plan → steps pipeline that
   preserves durable task state while discarding ephemeral logs at phase
   boundaries. The deterministic, append-friendly prefix is designed for
   KV-cache reuse with local inference servers such as llama.cpp and Ollama.
   Actual caching depends on the provider; pi-episteme does not infer a cache
   hit from latency or token estimates.
2. **File-less orchestration (Stage 1, GVS-style)** — a sequential
   Manager → Worker → Verifier pipeline over repeated independent model calls.
   The run state *is* the Episteme layer set: no task files, no side ledger.
   Every call shares one byte-stable prompt prefix (static header + canonical
   layers) and carries role/task data only after it, so a local server can
   reuse the cached KV prefix across all roles of a run.

Specification (Russian): [`SPEC.md`](./SPEC.md). Russian README:
[`README.ru.md`](./README.ru.md).

## Context model

The model writes durable blocks between exact `EPISTEME` markers. The extension
extracts them and rebuilds a deterministic summary; layer state lives in the
conversation, not in layer files.

```text
[Layer 0] system prompt + static pi-episteme instructions
  [RESEARCH] current task research
    [PLAN] base plan with stable item IDs
      [MILESTONE-N] optional archived-report digests
        [STEP-ID] completed-step reports
          [PLAN-DELTA] optional full effective-plan replacement
            [current] ephemeral work and tool output
```

The canonical summary order is **RESEARCH → PLAN → MILESTONE → STEP →
PLAN-DELTA**, regardless of the order in which blocks were discovered. Blocks
are separated by exactly one blank line. The last applicable block wins;
unclosed and empty blocks are ignored.

A plan item uses a stable, unique ID:

```text
- [id:S1] Update src/example.ts, run npm test, and record the expected result
```

Its report is `STEP-S1`, between
`/*EPISTEME::STEP-S1::v1*/` and `/*EPISTEME::END::STEP-S1::v1*/`.
Existing sessions with numeric `STEP-N` reports remain readable, and the tool
still accepts legacy numeric step positions. New plans should use explicit IDs.

Progress comes from STEP reports and MILESTONE `Completed-Steps` records, **not
from plan checkboxes**. Do not rewrite PLAN to tick items. To revise work, emit
PLAN-DELTA containing the **full new effective plan**, preserving the IDs and
action text of completed items and using fresh IDs for new work. PLAN-DELTA is
canonically placed after the reports; the base PLAN remains unchanged.

A new **RESEARCH starts a new task cycle**. It clears the previous PLAN,
PLAN-DELTA, STEP reports, and MILESTONEs. The old plan is not inherited: a fresh
base PLAN is required before `advance` is accepted.

## Workflow and compaction

1. Episteme is session state and starts **off**. Enable `/episteme-on`
   (light by default) to handle questions and small tasks normally and use
   the pipeline only for substantial work, or `/episteme-on strict` for the
   pipeline on every implementation task. Re-run the command with the other
   mode to switch without `/episteme-off`.
2. In an existing conversation, standing instructions are first appended as a
   message to avoid changing the cached system prefix; they move into the
   system prompt after the next compaction. In an empty session they are added
   to the system prompt immediately.
3. Write RESEARCH and its new base PLAN, then call
   `episteme(action="advance")`. Execute items in order. After each item, write
   its STEP-ID report and call `episteme(action="advance", step="S1")`.
4. An advance creates a non-context phase-boundary sentinel and requests
   compaction at the end of the turn. When compaction actually runs, plan/step
   mode cuts at that sentinel and leaves only the deterministic episteme
   summary—no pi LLM tail. A successful step phase also writes raw context to
   `<session>.pi_episteme/tmp/step_S1_raw.md`; mention that path in the report.
   Merely creating the sentinel does not create a summary or snapshot.
5. Other enabled-session compactions (overflow or `/episteme compact`) use plain
   mode. They keep pi's normal retained tail, filter episteme layers out of the
   plain summarizer's input, and append its ephemeral-work summary after the
   canonical layers. New markers are trusted only in assistant text and a
   previous canonical episteme summary, not in user/tool text. If plain LLM
   summarization fails, pi-episteme adds a bounded raw checkpoint (the last
   12,000 characters of cleaned discarded context) instead of losing the
   phase; cancellation is still propagated.
6. If pi rejects an advance-driven small-session/manual compaction or an auth
   preflight prevents it, the UI/status explicitly reports **deferred/degraded
   compaction**. The pipeline continues with the full phase still in context,
   and the next advance retries. A genuinely forced small-session compaction
   requires support from the upstream pi API; pi-episteme does not claim that
   every compaction request is guaranteed to run.

`/episteme-off` disables the pipeline for the session, cancels a pending phase
request, and queues a notice revoking the standing instructions. While off,
normal pi compaction is used and `advance` is rejected; `status` still works.
Resumed sessions also start off, with a notice if existing layers are found.

## Orchestration (Stage 1)

For complex tasks, `episteme(action="orchestrate", task="…")` (or
`/episteme-orchestrate <task>`) runs the pipeline:

1. **Manager** (chat-only model call) writes RESEARCH and a base PLAN in
   Episteme marker blocks. Malformed plans are fed back once for a retry.
2. **Workers** execute plan items strictly in order — one independent,
   in-memory agent session per item (`noExtensions`, default coding tools,
   fresh context each time). A Worker ends with a STEP-ID report; without a
   marker block its final message is kept as the report.
3. **Verifier** (independent agent session) re-runs the plan's verification
   commands and replies with a single JSON verdict. On failure the Manager
   issues a PLAN-DELTA with corrective items under fresh IDs (completed items
   are immutable and never re-executed); the number of corrective rounds is
   bounded by `PI_EPISTEME_ORCH_FIX_ROUNDS` (default 2).
4. On completion the orchestrator queues a persist request asking the main
   agent to re-emit the canonical blocks as its own assistant text, so the run
   state survives compaction in this session. **No orchestration state is
   written to files.**

KV-cache contract: within a run, every call's system prompt is
`[static orchestration header] + [canonical Episteme layers]`, rebuilt from
the same layer values; role instructions and the current subtask live only in
the dynamic user-message tail. Unchanged layers yield identical prefix bytes.
Only one orchestration can run at a time; it aborts with the calling tool's
abort signal.

### Milestone rollover

`layerTokenBudget` defaults to **16384 estimated tokens**, where the estimate
is `ceil(characters / 4)` for the complete canonical layer summary. `0`
disables rollover. The budget is an estimate, not a provider token count.

When the budget is exceeded and STEP reports exist, pi-episteme:

1. saves the full pre-rollover layers to `tmp/epoch_N_layers.md`;
2. asks the milestone summarizer for a durable digest—the milestone
   summarizer intentionally receives the **full layers**, including reports;
3. appends MILESTONE-N with a preserved `Completed-Steps` ID list and clears
   the individual reports after successful summarization.

If milestone summarization fails, the full reports remain in the layers; no
progress is discarded. This is different from plain summarization, from which
layers are filtered.

### Auto-continue and UI

`autoContinue` is on by default. After advance processing, including explicit
degraded continuation, it queues the next unfinished plan item. `/episteme pause`
suppresses only auto-continue, not execution or compaction; `/episteme resume`
re-enables it and queues the next item when idle.

The TUI shows plan progress or the current strict/light/off/paused mode.
Marker anchors are hidden by default in the display only; the session and
model context retain them. Raw snapshots can be removed with `/episteme reset`.
Orphaned snapshot directories for deleted sessions are cleaned at session
start.

`/episteme` and `episteme(action="status")` report layer size, epoch, compaction
counters, and the latest assistant usage as `cacheRead/input`. Layer tokens are
local estimates, and cache/input figures are provider-reported usage fields;
neither proves that a KV-cache hit occurred.

## Installation

```bash
pi install npm:pi-episteme
# or from git (pinned ref):
pi install git:github.com/maxsintsov1996-netizen/pi-episteme@v0.1.0
# or from a local checkout:
pi install /path/to/pi-episteme
```

Node.js **22.19.0 or newer** is required. TypeScript is loaded by pi; there is
no build step.

The package declares these peer dependencies: `@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
Development dependencies are `@types/node` and `typescript`. The optional local
smoke script uses Node's built-in `fetch`, `URL`, and `performance` APIs and
adds no runtime package dependency.

## Commands and tool

- `episteme(action="advance")` — accept a new base PLAN or full PLAN-DELTA and
  request phase compaction.
- `episteme(action="advance", step="S1")` — accept the report for that stable
  ID. A numeric `step`, such as `step=1`, is supported as a legacy plan
  position; it must be an integer of at least 1. String IDs use
  `[A-Za-z0-9][A-Za-z0-9_-]*`.
- `episteme(action="status")` — show current state and usage/status estimates.
- `episteme(action="orchestrate", task="…")` — run the file-less
  Manager → Worker → Verifier pipeline for a complex task.
- `/episteme` — show status; `/episteme compact` — request manual compaction;
  `/episteme reset` — confirm and delete this session's raw snapshots.
- `/episteme pause` and `/episteme resume` — pause/resume auto-continue.
- `/episteme-on [strict|light]` — enable the session in the selected mode
  (light by default; re-run with the other mode to switch).
- `/episteme-off` — disable the session and revoke standing instructions.
- `/episteme-orchestrate <task>` — run the orchestration pipeline from the
  command line (same as the `orchestrate` tool action).

## Configuration

Priority per field is **environment > project settings > global settings >
default**. Invalid values fall through to the next source. Files are
`~/.pi/agent/settings.json` and `<project>/.pi/settings.json` under the
`piEpisteme` key.

| Environment | settings.json | Default | Meaning |
| --- | --- | --- | --- |
| `PI_EPISTEME_AUTO_CONTINUE` | `piEpisteme.autoContinue` | `true` | Queue the next unfinished item after advance processing |
| `PI_EPISTEME_HIDE_ANCHORS` | `piEpisteme.hideAnchors` | `true` | Hide marker anchors in the TUI only |
| `PI_EPISTEME_LAYER_TOKEN_BUDGET` | `piEpisteme.layerTokenBudget` | `16384` | Estimated layer budget; `0` disables milestone rollover |
| `PI_EPISTEME_ORCH_FIX_ROUNDS` | — | `2` | Orchestration corrective rounds after a failed verification |

Boolean environment parsing is strict and case-insensitive after trimming:
true values are `1`, `true`, `on`; false values are `0`, `false`, `off`.
Anything else is invalid and ignored. The budget environment value must be a
non-negative decimal integer; the JSON value must be a non-negative integer.
The legacy `PI_EPISTEME_ENABLED` and `piEpisteme.enabled` do not enable a session.

Example:

```json
{
  "piEpisteme": {
    "autoContinue": false,
    "hideAnchors": true,
    "layerTokenBudget": 16384
  }
}
```

## Structure and verification

```text
index.ts        — session events, commands, tool, widgets, orchestration glue
compaction.ts   — plan/step/plain compaction, milestones, raw fallback
episteme.ts     — markers, stable-ID plans, extraction, canonical summaries
context.ts      — orchestration context builder (byte-stable prefix + role tails)
orchestrator.ts — Manager → Worker → Verifier loop (file-less, abortable)
config.ts       — environment/settings resolution and defaults
check.cjs       — offline self-tests
local-check.cjs — optional OpenAI-compatible endpoint smoke check
```

```bash
npm test
npm run typecheck
npm run test:local
```

`test:local` is opt-in and exits with `SKIP` unless both
`PI_EPISTEME_TEST_URL` and `PI_EPISTEME_TEST_MODEL` are set.
`PI_EPISTEME_TEST_API_KEY` is optional. It sends two requests with a stable
prefix and an appended ephemeral tail, then prints response usage/timings when
available. It reports a cache read **only when the provider explicitly returns
a positive cached-token metric**; otherwise cache reuse is unverified.
