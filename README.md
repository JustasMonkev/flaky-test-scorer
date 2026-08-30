# flaky-test-scorer

Detect and rank flaky tests from test-run history with deterministic evidence and
stable JSON for scripts and coding agents.

```bash
npx flaky-test-scorer analyze "**/junit*.xml"
```

```
Analyzed 12 runs across 3 tests from 4 files.
2 tests show flakiness (1 very flaky), 0 tests need more data.

#1  very_flaky  score 1.000  conf 0.50  gating score 0.500
    checkout > applies promo code
    - 3 outcome flips in 4 runs across 1 version
    - fails on unchanged commit in 1 version
    - duration variance 12.2x suite median
    - failure "Timeout <dur> exceeded waiting for selector #promo: at <path>:<n>" (2x)
    - likely cause: timeout (medium confidence, heuristic)
    -> Replace the live dependency with a controlled stub and inspect timeout handling.
```

**Scoring is deterministic and LLM-free.** Every number and evidence line above
is computed from your artifacts — no model and no network.

## Install

```bash
npm i -D flaky-test-scorer     # or just use npx
```

Node >= 22.12.0. ESM. Also usable as a library — `scoreTests` takes runs already grouped
by test and version, so pipe them through `groupByTestAndVersion` first:

```ts
import { expandInputs, groupByTestAndVersion, loadRuns, scoreTests } from "flaky-test-scorer";

const runs = loadRuns(expandInputs(["junit*.xml"]), "abc123"); // second arg: version/commit
const ranked = scoreTests(groupByTestAndVersion(runs));
```

`buildReport(groupByTestAndVersion(runs), options)` returns the report object used
by the CLI's `--json` output, with evidence included. The CLI adds
`baselined_breaches` when `--baseline` is used.

## Commands

```
flaky-test-scorer analyze <globs-or-paths...> [options]
flaky-test-scorer ci      <globs-or-paths...> [options]
```

| flag | default | meaning |
| --- | --- | --- |
| `--history <file>` | – | JSONL history: append newly ingested runs (deduped), then score the **full** history |
| `--commit <sha>` | CI environment variables / `git rev-parse HEAD` | version tag for ingested runs |
| `--json` | off | print the full report object on stdout |
| `--metric` | `flipRate` | `flipRate` or `entropy` |
| `--model` | `weighted` | `weighted` (age × independent-run weight) or `unweighted` (independent-run-weighted mean) |
| `--lam <0..1]` | `0.1` | EWMA decay; smaller = longer memory |
| `--min-reruns <n>` | `2` | a test is `low_data` unless some version has `n` independent executions |
| `--top <n>` | `10` | tests shown in human output |
| `--fail-above <n>` | – | `ci` only: exit 1 if any `gating_score` exceeds `n` |
| `--format markdown` | – | sticky PR-comment body on stdout ([PR comments](#pr-comments)); mutually exclusive with `--json` |
| `--baseline <file>` | – | `ci`: only **new or above-ceiling** flakiness fails the build; `baseline update`: output file ([baseline](#baseline-fail-only-on-new-flakiness)) |

```
flaky-test-scorer baseline update <globs-or-paths...> [--baseline <file>] [--history <file>]

flaky-test-scorer history merge <jsonl...> --history <out>
flaky-test-scorer history prune --history <f> [--keep-days <n>] [--keep-runs-per-test <n>]
```

**Exit codes:** `0` ok · `1` threshold exceeded · `2` usage or input error.

`--fail-above` compares against `gating_score` (`score × confidence`), not
the raw score. With the default settings, one retry chain cannot fail your build:
it is one independent execution and remains `low_data`.

## Inputs

- **JUnit XML** — nested `testsuites`/`testsuite`, `<failure>`/`<error>` count as
  fails, `<skipped>` is dropped. `test_id` is `classname > name`. Missing
  attributes, empty suites and BOMs are tolerated; malformed XML is rejected and
  exits 2. Maven Surefire retries (`<flakyFailure>`, `<flakyError>`,
  `<rerunFailure>`, `<rerunError>`) are expanded into ordered attempts, so a
  same-commit retry flip is scored, not hidden.
- **Playwright JSON** (`--reporter json`) — detected by shape. Every entry of a
  test's pass/fail `results[]` is one attempt; skipped and interrupted entries are
  dropped. `test_id` is `file > project > describe > title`.
- **JSON / CSV** — one row per run. Field aliases:
  `test_id | test | name | testId | id`, `result | status | outcome`,
  `version`, `timestamp | time | date`.
  Pass values: `pass passed p ok success true 1 green`.
  Fail values: `fail failed f error failure false 0 red`. Anything else is dropped.
- **History JSONL** — one run per line:
  `{"test_id","result","version","timestamp","duration_s","failure_message","source_file","attempt?","execution_id?"}`.
  Corrupt lines are counted and skipped with a stderr warning, never fatal. The
  file is append-only, so fields this version does not know about survive on disk.

## Scoring model

Per test, runs are grouped by version and ordered chronologically.

1. **Per-version metric** — `flipRate` (fraction of consecutive pairs that flip)
   or `entropy` (normalized Shannon entropy of pass/fail).
2. **Aggregate across versions** — multiply each version's independent-run count
   by EWMA `λ(1-λ)^age`, or use independent-run count alone for `unweighted`.
3. **`confidence`** = `(1 - 1/√independent_runs) × (1 - √variance(per-version scores))`,
   clamped to `[0,1]` — data volume times score stability. Confidence volume uses
   independent executions from scored versions only; singleton versions do not
   increase it. New retry records carry `execution_id`, so parallel chains stay
   separate. Old records without it keep the adjacent-attempt fallback.
4. **`gating_score`** = `max(0, score × confidence)` — the conservative number
   to gate on. Single-observation versions do not add score or confidence, and
   `low_data` forces this value to `0`.
5. **`verdict`**: `<=0 not_flaky`, `<0.17 slightly_flaky`, `<0.5 flaky`, else `very_flaky`.

Ranking sorts by `(score, confidence, total_runs)` descending. These are
prioritization heuristics, not statistical proof.

The model is a faithful port of the Python reference scorer, inspired by
Kowalczyk et al., *"Modeling and Ranking Flaky Tests at Apple"* (ICSE-SEIP 2020).

## Evidence

Every test carries deterministic evidence — facts, not guesses:

- `transitions` — outcome flips and total observations
- `independent_runs` — executions after collapsing retry attempts for confidence
- `within_version_flips` — versions where the same version both passed and
  failed; the strongest flakiness signal there is
- `within_run_retries` — executions whose in-run retry attempts disagreed
  (Surefire reruns, Playwright retries)
- `duration_variance` — the test's duration coefficient of variation against the
  suite median CV (human output calls it out when >= 2x)
- `failure_clusters` — failure messages grouped after stripping numbers, hex,
  durations and paths

`likely_cause` is the one hypothesis in the bundle, and it is labelled
`"heuristic": true`. Categories: `timeout`, `network`, `element`, `race`,
`resource`, `assertion`, `unknown`, each with a `low|medium|high` confidence from
cluster dominance and a deterministic `recommendation` template.

## Baseline: fail only on new or worse flakiness

Turning the gate on in a repo that already has flaky tests fails every build on
day one. Record what is already broken, then gate only on regressions:

```bash
flaky-test-scorer baseline update "reports/**/*.xml" --history .flaky-history.jsonl
git add .flaky-baseline.json && git commit -m "chore: record flaky-test baseline"

flaky-test-scorer ci "reports/**/*.xml" --history .flaky-history.jsonl \
  --fail-above 0.3 --baseline .flaky-baseline.json
```

A test breaches only if `gating_score > --fail-above` **and** its id is missing
from the baseline or its current score is above its stored ceiling. Equality and
decreases pass. Baselined breaches are still reported on stderr, in human output,
and in `--json` under `baselined_breaches`. Confidence can grow as more independent runs arrive, so a
test can rise above its stored ceiling by design. A missing baseline file means
"empty baseline", not an error. The file is sorted and timestamp-free, so its
git diff is the list of tests you fixed or newly accepted.

## Playwright reporter

Skip the JSON-report round trip: write history straight from the test run,
including every retry attempt.

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  retries: 2,
  reporter: [
    ["list"],
    ["flaky-test-scorer/reporter/playwright", { history: ".flaky-history.jsonl" }],
  ],
});
```

| option | default | meaning |
| --- | --- | --- |
| `history` | `.flaky-history.jsonl` | JSONL file to append to |
| `commit` | auto-detected (CI env vars, then `git rev-parse HEAD`) | version tag for these runs |

Each attempt becomes one run in retry order, so a test that only passed on retry
shows up as `within_run_retries`. `test_id` is `file > project > describe > title`
— the same id the Playwright JSON ingester produces, so the two sources merge
into one history. A private `execution_id` keeps parallel and `repeatEach` retry
chains separate. Appends are deduped on run identity, so re-running the reporter
over an unchanged run adds nothing. The reporter imports nothing from
`@playwright/test`, at type level or runtime.

## PR comments

`--format markdown` prints a comment body — marker line, summary table, top
offenders with score and likely cause — and nothing else, so it pipes straight
into an API call. It is mutually exclusive with `--json` (exit 2), and with
`--baseline` the table splits into newly flaky / baseline regressions /
baselined / recovered.

```bash
flaky-test-scorer ci "junit*.xml" --history .flaky-history.jsonl \
  --baseline .flaky-baseline.json --format markdown > comment.md
```

```markdown
<!-- flaky-test-scorer -->
## Flaky test report

Scored 3 tests over 12 runs.

| status | count |
| --- | --- |
| newly flaky | 1 |
| baseline regressions | 0 |
| baselined (known flaky) | 1 |
| recovered since baseline | 1 |
```

## How agents should call this

Use `--json`. The report object has a stable, versioned schema; treat
`schema_version` as your compatibility gate.

```bash
npx flaky-test-scorer analyze "artifacts/**/*.xml" --history .flaky-history.jsonl --json
```

```jsonc
{
  "schema_version": 2,
  "summary": { "tests": 86, "runs": 1284, "flaky": 4, "very_flaky": 1, "low_data": 2 },
  "params": { "metric": "flipRate", "model": "weighted", "lam": 0.1, "min_reruns": 2 },
  "tests": [
    {
      "rank": 1,
      "test_id": "checkout > applies promo code",
      "score": 0.86,               // observed instability, 0..1
      "confidence": 0.9,           // data volume x stability, 0..1
      "gating_score": 0.774,       // score x confidence — gate on this
      "verdict": "very_flaky",
      "total_runs": 12,
      "independent_runs": 12,
      "num_versions": 3,
      "low_data": false,
      "evidence": {
        "transitions": { "flips": 9, "total_runs": 12 },
        "within_version_flips": 2,
        "within_run_retries": 1,
        "duration_variance": { "cv": 0.94, "suite_median_cv": 0.077, "ratio": 12.19 },
        "failure_clusters": [
          { "pattern": "Timeout <dur> exceeded waiting for <path>", "count": 7, "sample": "Timeout 30000ms exceeded..." }
        ]
      },
      "likely_cause": { "category": "timeout", "confidence": "high", "matched_messages": 7, "heuristic": true },
      "recommendation": "Replace the live dependency with a controlled stub and inspect timeout handling."
    }
  ]
}
```

Agent guidance:

- Rank work by `gating_score`, not `score`. Ignore rows with `low_data: true`
  until they have more runs — recommend reruns instead of a fix.
- One retry chain is one independent execution, so it cannot pass the gate by
  itself; `low_data` forces its `gating_score` to `0`.
- `within_version_flips > 0` means the test both passed and failed for one
  version. That is the evidence to quote when arguing a test is flaky rather
  than broken.
- `likely_cause` is a keyword heuristic. Use it to pick where to look; confirm it
  against `failure_clusters` before acting on it.
- `tests` is fully ranked and complete; `--top` only trims human output.
## Not in scope

Quarantine/auto-modification of test files, trend dashboards, SQLite, watch mode,
and automatic pull-request comments. The JSON schema is the extension point for
all of them.
