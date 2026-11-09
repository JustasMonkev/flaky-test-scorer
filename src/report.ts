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

export function isWithinBaseline(
  test: Pick<ReportTest, "test_id" | "gating_score">,
  baseline: Baseline,
): boolean {
  return baselineStatus(test, baseline) === "baselined";
}

export type BaselineStatus = "new" | "regression" | "baselined";

export function baselineStatus(
  test: Pick<ReportTest, "test_id" | "gating_score">,
  baseline: Baseline,
): BaselineStatus {
  const ceiling = baseline.get(test.test_id);
  if (ceiling === undefined) return "new";
  return test.gating_score <= ceiling ? "baselined" : "regression";
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

const flakinessLine = (s: Report["summary"]): string =>
  `${plural(s.flaky, "test")} show${s.flaky === 1 ? "s" : ""} flakiness (${s.very_flaky} very flaky), ${plural(s.low_data, "test")} need${s.low_data === 1 ? "s" : ""} more data.`;

function baselineCounts(flaky: ReportTest[], baseline: Baseline) {
  const tally: Record<BaselineStatus, number> = { new: 0, regression: 0, baselined: 0 };
  for (const test of flaky) tally[baselineStatus(test, baseline)]++;
  return { newly: tally.new, regressions: tally.regression, baselined: tally.baselined };
}

const baselineLine = ({ newly, regressions, baselined }: ReturnType<typeof baselineCounts>): string =>
  `${newly} newly flaky, ${plural(regressions, "baseline regression")}, ${baselined} baselined (known flaky).`;

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
  const suspects = flaky.slice(0, Math.max(0, top));

  for (const test of suspects) {
    out.push("");
    out.push(
      `#${test.rank}  ${test.verdict}  score ${test.score.toFixed(3)}  conf ${test.confidence.toFixed(2)}  gating score ${test.gating_score.toFixed(3)}${test.low_data ? "  [LOW DATA]" : ""}${baseline ? `  [${baselineStatus(test, baseline).toUpperCase()}]` : ""}`,
    );
    out.push(`    ${test.test_id}`);
    for (const line of evidenceLines(test)) out.push(`    - ${line}`);
    out.push(`    - likely cause: ${test.likely_cause.category} (${test.likely_cause.confidence} confidence, heuristic)`);
    out.push(`    -> ${test.recommendation}`);
  }
  return out.join("\n");
}

export const MARKDOWN_MARKER = "<!-- flaky-test-scorer -->";

// Escape table separators and use a code fence longer than any backticks in the ID.
function mdCode(text: string): string {
  const safe = text.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...[...safe.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : ""; // a span may not start or end with a backtick
  return `${fence}${pad}${safe}${pad}${fence}`;
}

export function renderMarkdown(
  report: Report,
  top: number,
  baseline: Baseline | null = null,
): string {
  const flaky = flakyRanked(report, baseline);
  const flakyIds = new Set(flaky.map((t) => t.test_id));
  const counts = baseline ? baselineCounts(flaky, baseline) : null;
  // A missing test also counts as recovered.
  const recovered = baseline ? [...baseline.keys()].filter((id) => !flakyIds.has(id)).sort() : [];

  const summary: [string, number][] = counts
    ? [
        ["newly flaky", counts.newly],
        ["baseline regressions", counts.regressions],
        ["baselined (known flaky)", counts.baselined],
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
          `| ${t.rank} | ${mdCode(t.test_id)} | ${t.score.toFixed(3)} | ${t.gating_score.toFixed(3)} | ${t.verdict} | ${t.likely_cause.category} |${baseline ? ` ${baselineStatus(t, baseline)} |` : ""}`,
      ),
    );
  }

  if (recovered.length > 0) {
    out.push("", `Recovered: ${recovered.map(mdCode).join(", ")}`);
  }
  out.push("");
  return out.join("\n");
}

// Escape literal percent sequences before GitHub decodes workflow commands.
const ghEscape = (text: string): string => text.replace(/%/g, "%25");

export function renderGithub(
  report: Report,
  baseline: Baseline | null = null,
): { annotations: string[]; markdown: string } {
  const flaky = flakyRanked(report, baseline);
  const annotations = flaky.map((t) => {
    const known = baseline ? isWithinBaseline(t, baseline) : false;
    return `::${known ? "notice" : "warning"} title=Flaky test${known ? " (baselined)" : ""}::${ghEscape(t.test_id)} — ${t.verdict} (score ${t.score.toFixed(3)}, gating score ${t.gating_score.toFixed(3)}, likely ${t.likely_cause.category}). ${t.recommendation}`;
  });

  const rows = flaky
    .slice(0, 10)
    .map(
      (t) =>
        `| ${t.rank} | ${mdCode(t.test_id)} | ${t.score.toFixed(3)} | ${t.confidence.toFixed(2)} | ${t.gating_score.toFixed(3)} | ${t.verdict} | ${t.likely_cause.category} |${baseline ? ` ${baselineStatus(t, baseline)} |` : ""}`,
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
