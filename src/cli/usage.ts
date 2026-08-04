export const USAGE = `flaky-test-scorer — rank flaky tests from test-run history

Usage:
  flaky-test-scorer analyze  <globs-or-paths...> [options]
  flaky-test-scorer ci       <globs-or-paths...> [options]
  flaky-test-scorer baseline update <globs-or-paths...> [--baseline <file>]
  flaky-test-scorer history  merge <jsonl...> --history <out>
  flaky-test-scorer history  prune --history <f> [--keep-days <n>] [--keep-runs-per-test <n>]
  flaky-test-scorer auth     status | set-key <provider> | clear <provider>
  flaky-test-scorer mcp

Inputs: JUnit XML (incl. Surefire reruns), Playwright JSON reports, or JSON/CSV
run history (test_id + result, with aliases).

Options:
  --history <file>     JSONL history: append new runs, then score the full history
  --commit <sha>       version for ingested runs (default: CI env vars or git HEAD)
  --json               print the full report object as JSON on stdout
  --metric <name>      flipRate | entropy            (default: flipRate)
  --model <name>       weighted | unweighted         (default: weighted)
  --lam <n>            EWMA decay in (0, 1]          (default: 0.1)
  --min-reruns <n>     below this run count a test is low-data (default: 2)
  --top <n>            tests shown in human output   (default: 10)
  --explain            add an AI explanation section (optional, never affects exit code)
  --provider <name>    claude | codex | auto         (default: auto = first available)
  --explain-top <n>    flagged tests sent to the provider (default: 3)
  --fail-above <n>     [ci] exit 1 if any lower_bound_score exceeds n
  --format <name>      markdown = sticky PR-comment body (excludes --json)
                       github = [ci] ::warning annotations + $GITHUB_STEP_SUMMARY
  --baseline <file>    [ci] only NEW flakiness fails; known-flaky tests are reported
  -h, --help           show this help

Baseline:
  baseline update <inputs...>  record today's flaky tests (default .flaky-baseline.json)

History:
  history merge <jsonl...> --history <out>       fold sharded CI histories into one file
  history prune --history <f> --keep-days <n>    drop runs older than n days
                              --keep-runs-per-test <n>   keep only the newest n per test

Auth:
  auth status                 which providers are usable, and from where
  auth set-key <provider>     --key <k>, or piped on stdin to keep it out of shell history
  auth clear <provider>       forget the stored key

Agents:
  mcp                         run as a stdio MCP server (stdout is the transport)

Exit codes: 0 ok, 1 threshold exceeded, 2 usage or input error.`;
