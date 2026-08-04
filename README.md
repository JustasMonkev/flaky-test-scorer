# flaky-test-scorer

Detect and rank flaky tests from test-run history, explain the likely cause with
deterministic evidence, and emit stable JSON for CI pipelines and coding agents.

```bash
npx flaky-test-scorer analyze "**/junit*.xml"
```

```
Analyzed 12 runs across 3 tests from 4 files.
2 tests show flakiness (1 very flaky), 0 tests need more data.

#1  very_flaky  score 1.000  conf 0.50  lower bound 0.500
    checkout > applies promo code
    - 3 outcome flips in 4 runs across 1 version
    - fails on unchanged commit in 1 version
    - duration variance 12.2x suite median
    - failure "Timeout <dur> exceeded waiting for selector #promo: at <path>:<n>" (2x)
    - likely cause: timeout (medium confidence, heuristic)
    -> Replace the live dependency with a controlled stub and inspect timeout handling.
```

**The scoring core is deliberately LLM-free.** Every number and evidence line
above is computed deterministically from your artifacts — no model in the loop,
no network. `--explain` ([below](#ai-explanations-optional)) is an *optional*
extra section on top; without it the CLI behaves exactly as it always has.

## Install

```bash
npm i -D flaky-test-scorer     # or just use npx
```

Node >= 20. ESM. Also usable as a library — `scoreTests` takes runs already grouped
by test and version, so pipe them through `groupByTestAndVersion` first:

```ts
import { expandInputs, groupByTestAndVersion, loadRuns, scoreTests } from "flaky-test-scorer";

const runs = loadRuns(expandInputs(["junit*.xml"]), "abc123"); // second arg: version/commit
const ranked = scoreTests(groupByTestAndVersion(runs));
```

`buildReport(groupByTestAndVersion(runs), options)` returns the same object the CLI
prints under `--json`, evidence included.

## Commands

```
flaky-test-scorer analyze <globs-or-paths...> [options]
flaky-test-scorer ci      <globs-or-paths...> [options]
```

| flag | default | meaning |
| --- | --- | --- |
| `--history <file>` | – | JSONL history: append newly ingested runs (deduped), then score the **full** history |
| `--commit <sha>` | `GITHUB_SHA` / `CI_COMMIT_SHA` / `GIT_COMMIT` / `git rev-parse HEAD` | version tag for ingested runs |
| `--json` | off | print the full report object on stdout |
| `--metric` | `flipRate` | `flipRate` or `entropy` |
| `--model` | `weighted` | `weighted` (EWMA over versions) or `unweighted` (mean) |
| `--lam <0..1]` | `0.1` | EWMA decay; smaller = longer memory |
| `--min-reruns <n>` | `2` | below this run count a test is marked `low_data` |
| `--top <n>` | `10` | tests shown in human output |
| `--explain` | off | add an AI explanation section — [optional](#ai-explanations-optional), never changes the exit code |
| `--provider <name>` | first available | `claude` or `codex` |
| `--explain-top <n>` | `3` | flagged tests sent to the provider |
| `--fail-above <n>` | – | `ci` only: exit 1 if any `lower_bound_score` exceeds `n` |
| `--format markdown` | – | sticky PR-comment body on stdout ([PR comments](#pr-comments)); mutually exclusive with `--json` |
| `--format github` | – | `ci` only: `::warning` annotations + `$GITHUB_STEP_SUMMARY` markdown |
| `--baseline <file>` | – | `ci` only: only **new** flakiness fails the build ([baseline](#baseline-fail-only-on-new-flakiness)) |

```
flaky-test-scorer baseline update <globs-or-paths...> [--baseline <file>] [--history <file>]

flaky-test-scorer history merge <jsonl...> --history <out>
flaky-test-scorer history prune --history <f> [--keep-days <n>] [--keep-runs-per-test <n>]

flaky-test-scorer mcp     # stdio MCP server

flaky-test-scorer auth status
flaky-test-scorer auth set-key <claude|codex> [--key <k>]
flaky-test-scorer auth clear <claude|codex>
```

**Exit codes:** `0` ok · `1` threshold exceeded · `2` usage or input error
(the message names the offending file and the problem).

`--fail-above` compares against `lower_bound_score` (`score × confidence`), not
the raw score. That is deliberate: a test seen twice cannot fail your build.

## Inputs

- **JUnit XML** — nested `testsuites`/`testsuite`, `<failure>`/`<error>` count as
  fails, `<skipped>` is dropped. `test_id` is `classname > name`. Missing
  attributes, empty suites and BOMs are tolerated; malformed XML exits 2.
  Maven Surefire retries (`<flakyFailure>`, `<rerunFailure>`, `<rerunError>`) are
  expanded into ordered attempts, so a same-commit retry flip is scored, not hidden.
- **Playwright JSON** (`--reporter json`) — detected by shape. Every entry of a
  test's `results[]` is one attempt; `test_id` is `file > project > describe > title`.
- **JSON / CSV** — one row per run. Field aliases:
  `test_id | test | name | testId | id`, `result | status | outcome`,
  `version`, `timestamp | time | date`.
  Pass values: `pass passed p ok success true 1 green`.
  Fail values: `fail failed f error failure false 0 red`. Anything else is dropped.
- **History JSONL** — one run per line:
  `{"test_id","result","version","timestamp","duration_s","failure_message","source_file"}`.
  Corrupt lines are counted and skipped with a stderr warning, never fatal. The
  file is append-only, so fields this version does not know about survive on disk.

## Scoring model

Per test, runs are grouped by version and ordered chronologically.

1. **Per-version metric** — `flipRate` (fraction of consecutive pairs that flip)
   or `entropy` (normalized Shannon entropy of pass/fail).
2. **Aggregate across versions** — EWMA `weight = λ(1-λ)^age` (newest version
   heaviest), or a plain mean.
3. **`confidence`** = `(1 - 1/√runs) × (1 - √variance(per-version scores))`,
   clamped to `[0,1]` — data volume times score stability.
4. **`lower_bound_score`** = `max(0, score × confidence)` — the conservative
   number to gate on.
5. **`verdict`**: `<=0 not_flaky`, `<0.17 slightly_flaky`, `<0.5 flaky`, else `very_flaky`.

Ranking sorts by `(score, confidence, total_runs)` descending. These are
prioritization heuristics, not statistical proof.

The model is a faithful port of the Python reference scorer, inspired by
Kowalczyk et al., *"Modeling and Ranking Flaky Tests at Apple"* (ICSE-SEIP 2020).

## Evidence

Every test carries deterministic evidence — facts, not guesses:

- `transitions` — outcome flips and total runs
- `within_version_flips` — versions where the *same* commit both passed and
  failed; the strongest flakiness signal there is
- `within_run_retries` — executions whose in-run retry attempts disagreed
  (Surefire reruns, Playwright retries)
- `duration_variance` — the test's duration coefficient of variation against the
  suite median CV (reported when >= 2x)
- `failure_clusters` — failure messages grouped after stripping numbers, hex,
  durations and paths

`likely_cause` is the one hypothesis in the bundle, and it is labelled
`"heuristic": true`. Categories: `timeout`, `network`, `element`, `race`,
`resource`, `assertion`, `unknown`, each with a `low|medium|high` confidence from
cluster dominance and a deterministic `recommendation` template.

## Baseline: fail only on new flakiness

Turning the gate on in a repo that already has flaky tests fails every build on
day one. Record what is already broken, then gate only on regressions:

```bash
flaky-test-scorer baseline update "reports/**/*.xml" --history .flaky-history.jsonl
git add .flaky-baseline.json && git commit -m "chore: record flaky-test baseline"

flaky-test-scorer ci "reports/**/*.xml" --history .flaky-history.jsonl \
  --fail-above 0.3 --baseline .flaky-baseline.json
```

A test breaches only if `lower_bound_score > --fail-above` **and** its id is not
in the baseline. Baselined breaches are still reported — on stderr, in the human
and GitHub output (as `::notice`, not `::warning`), and in `--json` under
`baselined_breaches`. A missing baseline file means "empty baseline", not an
error. The file is sorted and timestamp-free, so its git diff is the list of
tests you fixed or newly accepted.

## Sharded CI

With a matrix build, each shard writes its own history and the gate runs once on
the merged file — `history merge` dedups runs that two shards both uploaded, and
writes atomically (tmp + rename), so a killed job cannot truncate the history.

```yaml
test:
  strategy:
    matrix: { shard: [1, 2, 3, 4] }
  steps:
    - run: npx flaky-test-scorer analyze "reports/**/*.xml" --history shard-${{ matrix.shard }}.jsonl
    - uses: actions/upload-artifact@v4
      with: { name: flaky-history-${{ matrix.shard }}, path: shard-${{ matrix.shard }}.jsonl }

gate:
  needs: test
  steps:
    - uses: actions/download-artifact@v4
      with: { pattern: flaky-history-*, path: shards, merge-multiple: true }
    - run: npx flaky-test-scorer history merge "shards/*.jsonl" --history .flaky-history.jsonl
    - run: npx flaky-test-scorer ci .flaky-history.jsonl --fail-above 0.3 --baseline .flaky-baseline.json
```

Keep the file from growing without bound:

```bash
flaky-test-scorer history prune --history .flaky-history.jsonl --keep-days 90
flaky-test-scorer history prune --history .flaky-history.jsonl --keep-runs-per-test 50
```

Both flags together intersect. Runs whose timestamp cannot be aged (numeric,
opaque or missing) are always kept by `--keep-days`: pruning never guesses.
Passing neither flag is a usage error (exit 2).

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
into one history. Appends are deduped on run identity, so re-running the reporter
over an unchanged run adds nothing. The reporter imports nothing from
`@playwright/test`, at type level or runtime.

## MCP server

`flaky-test-scorer mcp` speaks MCP over stdio, so an agent can query flakiness
without shelling out and parsing text. stdout is the transport; every diagnostic
goes to stderr.

```jsonc
// Claude Code: .mcp.json (or claude_desktop_config.json)
{
  "mcpServers": {
    "flaky-test-scorer": {
      "command": "npx",
      "args": ["-y", "flaky-test-scorer", "mcp"]
    }
  }
}
```

Three tools, all thin wrappers over the same code the CLI runs:

| tool | arguments | returns |
| --- | --- | --- |
| `analyze_history` | `history_path?`, `inputs?`, `metric?`, `model?`, `lam?`, `min_reruns?` | the full `--json` report |
| `get_test_evidence` | `history_path`, `test_id` | that test's report object, or a not-found tool error |
| `explain_test` | `history_path`, `test_id`, `provider?` | the AI explanation for one test |

`explain_test` needs a provider credential in the server's environment — see
[Auth](#auth). Failures come back as MCP tool errors;
the server stays up.

## PR comments

`--format markdown` prints a comment body — marker line, summary table, top
offenders with score and likely cause — and nothing else, so it pipes straight
into an API call. It is mutually exclusive with `--json` (exit 2), and with
`--baseline` the table splits into newly flaky / baselined / recovered.

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
| baselined (known flaky) | 1 |
| recovered since baseline | 1 |
```

The action does the upsert for you — the `<!-- flaky-test-scorer -->` marker on
line 1 is how it finds the previous comment and edits it in place instead of
stacking a new one on every push:

```yaml
permissions:
  contents: read
  pull-requests: write     # required — the comment is posted with GITHUB_TOKEN

jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      # ...
      - uses: your-org/flaky-test-scorer@v1
        with:
          input: "junit*.xml"
          fail-above: "0.6"
          pr-comment: "true"
```

The comment step only runs on `pull_request` events and runs even when the gate
step already failed — a freshly red PR is exactly when you want the comment. It
re-runs the CLI without `--fail-above`, so it is never a second gate. Fork and
Dependabot PRs get a read-only token and cannot be commented on; that (and a
missing `pull-requests: write`) surfaces as a `::warning`, never a red build.

## How agents should call this

Use `--json`. The report object has a stable, versioned schema; treat
`schema_version` as your compatibility gate.

```bash
npx flaky-test-scorer analyze "artifacts/**/*.xml" --history .flaky-history.jsonl --json
```

```jsonc
{
  "schema_version": 1,
  "summary": { "tests": 86, "runs": 1284, "flaky": 4, "very_flaky": 1, "low_data": 2 },
  "params": { "metric": "flipRate", "model": "weighted", "lam": 0.1, "min_reruns": 2 },
  "tests": [
    {
      "rank": 1,
      "test_id": "checkout > applies promo code",
      "score": 0.86,               // observed instability, 0..1
      "confidence": 0.9,           // data volume x stability, 0..1
      "lower_bound_score": 0.774,  // score x confidence — gate on this
      "verdict": "very_flaky",
      "total_runs": 12,
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

- Rank work by `lower_bound_score`, not `score`. Ignore rows with `low_data: true`
  until they have more runs — recommend reruns instead of a fix.
- `within_version_flips > 0` means the test failed on an unchanged commit. That
  is the evidence to quote when arguing a test is flaky rather than broken.
- `likely_cause` is a keyword heuristic. Use it to pick where to look; confirm it
  against `failure_clusters` before acting on it.
- `tests` is fully ranked and complete; `--top` only trims human output.
- With `--explain`, an additive `ai_analysis` object appears alongside `tests`:
  `{ "provider": "claude", "model": "claude-opus-5", "per_test": [{ "test_id", "analysis" }], "heuristic": false }`.
  It is absent whenever the provider was unavailable or failed — treat it as
  optional prose, never as evidence.

## AI explanations (optional)

`--explain` sends the deterministic evidence bundle for the top flagged tests to
Claude or Codex and prints the prose answer in a clearly separated section.
Everything else stays exactly the same:

- the report, the scores and the JSON schema are unchanged (`ai_analysis` is an
  additive field, `schema_version` stays `1`);
- **an explain failure never changes the exit code** — no key, a refusal, a rate
  limit or a dead provider warns on stderr and the deterministic report still
  prints, so `ci --fail-above` gates on numbers only;
- with no provider configured the CLI is fully usable — `--explain` just warns.

```bash
flaky-test-scorer analyze "junit*.xml" --explain
flaky-test-scorer analyze "junit*.xml" --explain --provider codex --explain-top 5
flaky-test-scorer ci "junit*.xml" --json --explain    # ai_analysis inside the JSON
```

```
AI analysis (claude) — model claude-opus-5; hypotheses, not deterministic evidence

  checkout > applies promo code
  The failures cluster on a selector timeout and the test also fails on an
  unchanged commit, so the promo endpoint is likely answering late rather than
  the code being wrong. Start by stubbing it and asserting on the stubbed timing.
```

### Auth

| # | claude | codex |
| --- | --- | --- |
| 1 | `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) env var | `OPENAI_API_KEY` env var |
| 2 | `auth set-key claude` (stored in the config file) | `auth set-key codex` |

First match wins, top to bottom; `--provider` picks the provider, otherwise the
first available one in the order claude, codex.

Local `claude` and `codex` executables on `PATH` are ignored; explanations require an
environment or stored API credential.

```bash
flaky-test-scorer auth status                       # what is usable, and from where
echo "$KEY" | flaky-test-scorer auth set-key claude # piped: keeps the key out of shell history
flaky-test-scorer auth clear claude
```

Stored keys live in `$XDG_CONFIG_HOME/flaky-test-scorer/config.json` (fallback
`~/.config/...`), written `0600`. Keys are never printed or logged — `auth status`
shows the source and a masked tail (`...xY9z`) only.

### In CI

Put the key in your CI secret store and expose it as an **environment variable**;
never pass it as a CLI flag or an action input (both end up in run logs).

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # or OPENAI_API_KEY
    steps:
      # ...
      - run: npx flaky-test-scorer ci "junit*.xml" --format github --explain
```

Job-level `env:` is what composite actions inherit, so set it there rather than
on the step. Forks and Dependabot PRs do not receive secrets — the step still
runs, warns once on stderr, and reports as usual.

## GitHub Actions

Composite action (restores history from cache, scores, saves history):

```yaml
- uses: actions/checkout@v4
- run: npm test -- --reporter=junit --outputFile=junit.xml
  continue-on-error: true
- uses: your-org/flaky-test-scorer@v1
  with:
    input: "junit*.xml"
    fail-above: "0.6"
    history: .flaky-history.jsonl
    explain: "true"        # optional; needs a provider key in the job env
    provider: claude       # optional; default is the first available provider
```

The action has no key input by design: set `ANTHROPIC_API_KEY` (or
`OPENAI_API_KEY`) as a job-level `env:` from your repository secrets.

Or wire it up directly:

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test -- --reporter=junit --outputFile=junit.xml
        continue-on-error: true

      - uses: actions/cache@v4
        with:
          path: .flaky-history.jsonl
          key: flaky-history-${{ github.ref_name }}-${{ github.run_id }}
          restore-keys: flaky-history-${{ github.ref_name }}-

      - name: Score flaky tests
        run: |
          npx flaky-test-scorer ci "junit*.xml" \
            --history .flaky-history.jsonl \
            --format github \
            --fail-above 0.6
```

`--format github` writes `::warning` annotations on the run and a markdown table
to the job summary.

## GitLab CI

```yaml
flaky-tests:
  stage: test
  image: node:20
  cache:
    key: flaky-history-$CI_COMMIT_REF_SLUG
    paths: [.flaky-history.jsonl]
  script:
    - npm ci
    - npm test -- --reporter=junit --outputFile=junit.xml || true
    - npx flaky-test-scorer ci "junit*.xml"
        --history .flaky-history.jsonl
        --json > flaky-report.json
  artifacts:
    when: always
    paths: [flaky-report.json, .flaky-history.jsonl]
    reports:
      junit: junit.xml
```

`CI_COMMIT_SHA` is picked up automatically as the version, so per-commit
instability is separated from cross-commit change.

## Not in scope

Quarantine/auto-modification of test files, trend dashboards, SQLite, watch mode,
GitLab MR comments (the recipe above writes an artifact instead). The JSON schema
is the extension point for all of them.

## License

MIT. See [LICENSE](LICENSE).
