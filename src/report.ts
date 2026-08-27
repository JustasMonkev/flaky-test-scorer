import { buildEvidence, durationStats, recommendationFor, type Evidence, type LikelyCause } from "./evidence.js";
import { scoreTests, type Metric, type Model, type RunRecord, type ScoredTest } from "./score.js";

export const SCHEMA_VERSION = 2;

export interface ReportTest extends ScoredTest {
  evidence: Evidence;
  likely_cause: LikelyCause;
  recommendation: string;
}

export interface Report {
  schema_version: number;
  summary: { tests: number; runs: number; flaky: number; very_flaky: number; low_data: number };
  params: { metric: Metric; model: Model; lam: number; min_reruns: number };
  tests: ReportTest[];
}

export interface BuildOptions {
  metric: Metric;
  model: Model;
  lam: number;
  minReruns: number;
}

export type Baseline = ReadonlyMap<string, number>;

/** A baseline is a ceiling: equal or lower current scores are accepted. */
export function isWithinBaseline(
  test: Pick<ReportTest, "test_id" | "gating_score">,
  baseline: Baseline,
): boolean {
  return baseline.has(test.test_id) && test.gating_score <= baseline.get(test.test_id)!;
}

export function buildReport(
  grouped: Map<string, Map<string, RunRecord[]>>,
  options: BuildOptions,
): Report {
  const scored = scoreTests(grouped, options);
  const durations = durationStats(grouped);

  const tests: ReportTest[] = scored.map((row) => {
    const { evidence, likely_cause } = buildEvidence(row.test_id, grouped.get(row.test_id)!, durations);
    return { ...row, evidence, likely_cause, recommendation: recommendationFor(likely_cause.category) };
  });

  return {
    schema_version: SCHEMA_VERSION,
    summary: {
      tests: tests.length,
      runs: tests.reduce((a, t) => a + t.total_runs, 0),
      flaky: tests.filter((t) => t.score > 0).length,
      very_flaky: tests.filter((t) => t.verdict === "very_flaky").length,
      low_data: tests.filter((t) => t.low_data).length,
    },
    params: { metric: options.metric, model: options.model, lam: options.lam, min_reruns: options.minReruns },
    tests,
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// Shared sentences: renderHuman and renderGithub must not drift apart in wording.
const flakinessLine = (s: Report["summary"]): string =>
  `${plural(s.flaky, "test")} show${s.flaky === 1 ? "s" : ""} flakiness (${s.very_flaky} very flaky), ${plural(s.low_data, "test")} need${s.low_data === 1 ? "s" : ""} more data.`;

function baselineCounts(flaky: ReportTest[], baseline: Baseline) {
  const baselined = flaky.filter((t) => isWithinBaseline(t, baseline)).length;
  const regressions = flaky.filter((t) => baseline.has(t.test_id) && !isWithinBaseline(t, baseline)).length;
  return { newly: flaky.length - baselined - regressions, regressions, baselined };
}

const baselineLine = ({ newly, regressions, baselined }: ReturnType<typeof baselineCounts>): string =>
  `${newly} newly flaky, ${plural(regressions, "baseline regression")}, ${baselined} baselined (known flaky).`;

/**
 * The flaky tests in display order: newly-flaky first, baselined after, stable
 * within each group. Every surface slices a top-N off this list, and a repo with
 * 20 baselined tests used to fill all 10 slots (and the paid --explain budget)
 * with tests the user has already accepted, hiding the one regression the
 * baseline exists to surface.
 */
export function flakyRanked(
  report: Report,
  baseline: Baseline | null = null,
): ReportTest[] {
  const flaky = report.tests.filter((t) => t.score > 0);
  if (!baseline) return flaky;
  return [
    ...flaky.filter((t) => !isWithinBaseline(t, baseline)),
    ...flaky.filter((t) => isWithinBaseline(t, baseline)),
  ];
}

function evidenceLines(test: ReportTest): string[] {
  const lines: string[] = [];
  const { transitions, within_version_flips, within_run_retries, duration_variance, failure_clusters } =
    test.evidence;
  lines.push(
    `${plural(transitions.flips, "outcome flip")} in ${transitions.total_runs} runs across ${plural(test.num_versions, "version")}`,
  );
  if (within_version_flips > 0) {
    lines.push(`fails on unchanged commit in ${plural(within_version_flips, "version")}`);
  }
  if (within_run_retries > 0) {
    lines.push(`passed only on retry in ${plural(within_run_retries, "run")} (within-run retries)`);
  }
  if (duration_variance && duration_variance.ratio >= 2) {
    lines.push(`duration variance ${duration_variance.ratio.toFixed(1)}x suite median`);
  }
  for (const cluster of failure_clusters.slice(0, 2)) {
    lines.push(`failure "${cluster.pattern}" (${cluster.count}x)`);
  }
  return lines;
}

export function renderHuman(
  report: Report,
  top: number,
  fileCount: number,
  baseline: Baseline | null = null,
): string {
  const { summary } = report;
  const out: string[] = [
    `Analyzed ${plural(summary.runs, "run")} across ${plural(summary.tests, "test")} from ${plural(fileCount, "file")}.`,
    flakinessLine(summary),
  ];

  const flaky = flakyRanked(report, baseline);
  if (baseline) {
    out.push(baselineLine(baselineCounts(flaky, baseline)));
  }
  if (flaky.length === 0) {
    out.push("", "No flaky tests detected.");
    return out.join("\n");
  }
  // Clamp: a negative --top must not silently drop the last row via slice(0, -1).
  const suspects = flaky.slice(0, Math.max(0, top));

  for (const test of suspects) {
    out.push("");
    out.push(
      `#${test.rank}  ${test.verdict}  score ${test.score.toFixed(3)}  conf ${test.confidence.toFixed(2)}  gating score ${test.gating_score.toFixed(3)}${test.low_data ? "  [LOW DATA]" : ""}${baseline ? (isWithinBaseline(test, baseline) ? "  [BASELINED]" : baseline.has(test.test_id) ? "  [REGRESSION]" : "  [NEW]") : ""}`,
    );
    out.push(`    ${test.test_id}`);
    for (const line of evidenceLines(test)) out.push(`    - ${line}`);
    out.push(`    - likely cause: ${test.likely_cause.category} (${test.likely_cause.confidence} confidence, heuristic)`);
    out.push(`    -> ${test.recommendation}`);
  }
  return out.join("\n");
}

/** First line of the PR comment body; the action greps for it to update in place. */
export const MARKDOWN_MARKER = "<!-- flaky-test-scorer -->";

/**
 * Inline code span that survives an arbitrary test id inside a GFM table cell.
 * A test name is attacker-supplied: an unescaped `|` opens a new column and a
 * backtick closes the span, so `a | b \`x\` <img ...>` rewrote the table and
 * leaked raw HTML into the PR comment. GFM honours `\|` even inside code spans,
 * and a fence one backtick longer than the longest run inside always holds.
 */
function mdCode(text: string): string {
  const safe = text.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...[...safe.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : ""; // a span may not start or end with a backtick
  return `${fence}${pad}${safe}${pad}${fence}`;
}

/**
 * Sticky PR-comment body (SPEC-V3 F7). Deterministic: the marker, a fixed-order
 * summary table, then the same ranked order the rest of the report uses.
 */
export function renderMarkdown(
  report: Report,
  top: number,
  baseline: Baseline | null = null,
): string {
  const flaky = flakyRanked(report, baseline);
  const flakyIds = new Set(flaky.map((t) => t.test_id));
  const counts = baseline ? baselineCounts(flaky, baseline) : null;
  // Recovered = baselined ids the current run no longer flags. Sorted, since a
  // Map's iteration order is insertion order and the comment must diff cleanly.
  //
  // ponytail: a baselined id ABSENT from the report (deleted, renamed, or simply
  // not run in this shard) also counts as recovered. Ceiling — sharded CI can show
  // phantom recoveries. Narrowing it to `present && score === 0` is a one-line
  // change but a semantics change: it contradicts two committed tests and the
  // README example, so it wants a SPEC decision rather than a drive-by fix.
  const recovered = baseline ? [...baseline.keys()].filter((id) => !flakyIds.has(id)).sort() : [];

  const summary: [string, number][] = baseline
    ? [
        ["newly flaky", counts!.newly],
        ["baseline regressions", counts!.regressions],
        ["baselined (known flaky)", counts!.baselined],
        ["recovered since baseline", recovered.length],
      ]
    : [
        ["flaky", report.summary.flaky],
        ["very flaky", report.summary.very_flaky],
        ["need more data", report.summary.low_data],
      ];

  const out = [
    MARKDOWN_MARKER,
    "## Flaky test report",
    "",
    `Scored ${plural(report.summary.tests, "test")} over ${plural(report.summary.runs, "run")}.`,
    "",
    "| status | count |",
    "| --- | --- |",
    ...summary.map(([label, count]) => `| ${label} | ${count} |`),
  ];

  const suspects = flaky.slice(0, Math.max(0, top));
  if (suspects.length === 0) {
    out.push("", "No flaky tests detected.");
  } else {
    out.push(
      "",
      "### Top offenders",
      "",
      `| rank | test | score | gating score | verdict | likely cause |${baseline ? " status |" : ""}`,
      `| --- | --- | --- | --- | --- | --- |${baseline ? " --- |" : ""}`,
      ...suspects.map(
        (t) =>
          `| ${t.rank} | ${mdCode(t.test_id)} | ${t.score.toFixed(3)} | ${t.gating_score.toFixed(3)} | ${t.verdict} | ${t.likely_cause.category} |${baseline ? ` ${isWithinBaseline(t, baseline) ? "baselined" : baseline.has(t.test_id) ? "regression" : "new"} |` : ""}`,
      ),
    );
  }

  if (recovered.length > 0) {
    out.push("", `Recovered: ${recovered.map(mdCode).join(", ")}`);
  }
  out.push("");
  return out.join("\n");
}

/**
 * Workflow-command escaping. The runner percent-decodes annotation text, so a test
 * name literally containing `%0A` arrives as a newline inside the annotation — the
 * markdown path escapes its metacharacters and this one did not. `cleanTestId`
 * already removed real control characters, so escaping `%` is the whole job.
 */
const ghEscape = (text: string): string => text.replace(/%/g, "%25");

/** `::warning` annotations plus a markdown job summary for GitHub Actions. */
export function renderGithub(
  report: Report,
  baseline: Baseline | null = null,
): { annotations: string[]; markdown: string } {
  const flaky = flakyRanked(report, baseline);
  // Baselined tests annotate as ::notice, not ::warning: they are already known and
  // must not read as a new regression in the PR's file view.
  const annotations = flaky.map((t) => {
    const known = baseline ? isWithinBaseline(t, baseline) : false;
    return `::${known ? "notice" : "warning"} title=Flaky test${known ? " (baselined)" : ""}::${ghEscape(t.test_id)} — ${t.verdict} (score ${t.score.toFixed(3)}, gating score ${t.gating_score.toFixed(3)}, likely ${t.likely_cause.category}). ${t.recommendation}`;
  });

  const rows = flaky
    .slice(0, 10)
    .map(
      (t) =>
        `| ${t.rank} | ${mdCode(t.test_id)} | ${t.score.toFixed(3)} | ${t.confidence.toFixed(2)} | ${t.gating_score.toFixed(3)} | ${t.verdict} | ${t.likely_cause.category} |${baseline ? ` ${isWithinBaseline(t, baseline) ? "baselined" : baseline.has(t.test_id) ? "regression" : "new"} |` : ""}`,
    );

  const counts = baseline ? baselineCounts(flaky, baseline) : null;

  const markdown = [
    "## Flaky test report",
    "",
    `Scored ${plural(report.summary.tests, "test")} over ${plural(report.summary.runs, "run")}. ${flakinessLine(report.summary)}`,
    ...(counts ? ["", baselineLine(counts)] : []),
    "",
    ...(rows.length
      ? [
          `| rank | test | score | confidence | gating score | verdict | likely cause |${baseline ? " status |" : ""}`,
          `| --- | --- | --- | --- | --- | --- | --- |${baseline ? " --- |" : ""}`,
          ...rows,
        ]
      : ["No flaky tests detected."]),
    "",
  ].join("\n");

  return { annotations, markdown };
}
