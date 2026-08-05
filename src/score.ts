/**
 * Faithful port of the Python scorer (score_flakiness.py).
 * Numeric behaviour must stay identical: same rounding points, same
 * aggregation formulas, same sort keys, same verdict bands.
 */

export interface RunRecord {
  test_id: string;
  /** true = pass, false = fail */
  result: boolean;
  version: string | null;
  timestamp: string | number | null;
  duration_s: number | null;
  failure_message: string | null;
  source_file: string | null;
  /**
   * 0-based retry attempt index within ONE execution (Surefire reruns, Playwright
   * retries). Absent for single-attempt runs, so ordinary history lines keep their
   * v1 shape. Attempts of one execution are consecutive and restart at 0.
   */
  attempt?: number | null;
}

export type Metric = "flipRate" | "entropy";
export type Model = "weighted" | "unweighted";
export type Verdict = "not_flaky" | "slightly_flaky" | "flaky" | "very_flaky";

export interface ScoredTest {
  rank: number;
  test_id: string;
  score: number;
  confidence: number;
  lower_bound_score: number;
  verdict: Verdict;
  total_runs: number;
  num_versions: number;
  low_data: boolean;
}

// An exact .00005 tie: only reachable for values with <= 5 decimals, which
// toFixed(30) therefore renders exactly (no rounding of its own).
const EXACT_TIE_AT_4DP = /\.\d{4}50{25}$/;

/**
 * Python's round(x, 4). Both round the exact binary value, but Python breaks
 * exact .00005 ties to even while toFixed() always breaks them upward — and
 * those ties are reachable (flipRate 1/32 = 0.03125 -> Python 0.0312, not 0.0313),
 * where the rounded score also drives rank order.
 */
export function round4(value: number): number {
  const exact = value.toFixed(30);
  if (!EXACT_TIE_AT_4DP.test(exact)) return Number(value.toFixed(4));
  const cut = exact.indexOf(".") + 5;
  const truncated = Number(exact.slice(0, cut));
  return exact.charCodeAt(cut - 1) % 2 === 0 // '0'.charCodeAt(0) is even, so digit parity holds
    ? truncated
    : Number((truncated + Math.sign(value) * 1e-4).toFixed(4));
}

/** Normalized Shannon entropy of pass/fail outcomes (2 outcomes => max 1.0). */
export function entropy(results: boolean[]): number {
  const count = results.length;
  if (count === 0) return 0;
  const pPass = results.filter(Boolean).length / count;
  const pFail = 1 - pPass;
  let score = 0;
  for (const p of [pPass, pFail]) {
    if (p > 0) score -= p * Math.log2(p);
  }
  return score;
}

/** Number of consecutive run pairs that flip pass/fail — THE definition of a flip. */
export function countFlips(results: boolean[]): number {
  let flips = 0;
  for (let i = 1; i < results.length; i++) {
    if (results[i] !== results[i - 1]) flips++;
  }
  return flips;
}

/** Fraction of consecutive run pairs that flip pass/fail. */
export function flipRate(results: boolean[]): number {
  const count = results.length;
  return count < 2 ? 0 : countFlips(results) / (count - 1);
}

/** Mean of per-version scores. */
export function aggregateUnweighted(versionScores: number[]): number {
  if (versionScores.length === 0) return 0;
  return versionScores.reduce((a, b) => a + b, 0) / versionScores.length;
}

/** Exponentially weighted moving average across versions (newest last). */
export function aggregateWeighted(versionScores: number[], lam = 0.1): number {
  if (versionScores.length === 0) return 0;
  let numerator = 0;
  let denominator = 0;
  const count = versionScores.length;
  for (let index = 0; index < count; index++) {
    const age = count - 1 - index;
    const weight = lam * Math.pow(1 - lam, age);
    numerator += weight * versionScores[index]!;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/** Confidence in [0,1] from data volume and score stability. Rounded to 4dp. */
export function confidence(totalRuns: number, versionScores: number[]): number {
  const count = Math.max(totalRuns, 1);
  const dataFactor = 1 - 1 / Math.sqrt(count);

  let stabilityFactor = 1;
  if (versionScores.length >= 2) {
    const mean = versionScores.reduce((a, b) => a + b, 0) / versionScores.length;
    const variance =
      versionScores.reduce((a, s) => a + (s - mean) ** 2, 0) / versionScores.length;
    stabilityFactor = Math.max(0, 1 - Math.sqrt(variance));
  }
  return round4(dataFactor * stabilityFactor);
}

export function verdict(score: number): Verdict {
  if (score <= 0) return "not_flaky";
  if (score < 0.17) return "slightly_flaky";
  if (score < 0.5) return "flaky";
  return "very_flaky";
}

export type TimestampKey = [number, number, string];

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/;

/** Sortable key for numeric, ISO-like, or opaque timestamps. */
export function timestampKey(value: string | number | null | undefined): TimestampKey {
  if (value === null || value === undefined || value === "") return [2, 0, ""];
  const text = String(value).trim();
  if (NUMERIC.test(text)) return [0, Number(text), text];
  if (ISO_LIKE.test(text)) {
    // Date.parse treats a date-only string as UTC but a date-time as local, while the
    // Python reference reads every offset-less form as local. Spelling out midnight
    // keeps the two agreeing, so mixed date/date-time histories sort the same way.
    const parsed = Date.parse(
      (/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text).replace(/Z$/, "+00:00"),
    );
    if (!Number.isNaN(parsed)) return [1, parsed / 1000, text];
  }
  return [2, 0, text];
}

export function compareKeys(a: TimestampKey, b: TimestampKey): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

export const NO_VERSION = "__all__";

/** test_id -> version -> chronologically ordered runs. Insertion order preserved. */
export function groupByTestAndVersion(
  runs: RunRecord[],
): Map<string, Map<string, RunRecord[]>> {
  const decorated = runs.map((run, order) => ({ run, order, key: timestampKey(run.timestamp) }));
  decorated.sort((a, b) => compareKeys(a.key, b.key) || a.order - b.order);

  const byTest = new Map<string, Map<string, RunRecord[]>>();
  for (const { run } of decorated) {
    let versions = byTest.get(run.test_id);
    if (!versions) byTest.set(run.test_id, (versions = new Map()));
    const version = run.version ?? NO_VERSION;
    let list = versions.get(version);
    if (!list) versions.set(version, (list = []));
    list.push(run);
  }
  return byTest;
}

export interface ScoreOptions {
  metric?: Metric;
  model?: Model;
  lam?: number;
  minReruns?: number;
}

/** One home for the scoring defaults — the CLI and MCP surfaces echo these. */
export const SCORE_DEFAULTS = {
  metric: "flipRate",
  model: "weighted",
  lam: 0.1,
  minReruns: 2,
} as const satisfies Required<ScoreOptions>;

export function scoreTests(
  grouped: Map<string, Map<string, RunRecord[]>>,
  {
    metric = SCORE_DEFAULTS.metric,
    model = SCORE_DEFAULTS.model,
    lam = SCORE_DEFAULTS.lam,
    minReruns = SCORE_DEFAULTS.minReruns,
  }: ScoreOptions = {},
): ScoredTest[] {
  const fn = metric.toLowerCase() === "entropy" ? entropy : flipRate;
  const rows: ScoredTest[] = [];

  for (const [testId, versions] of grouped) {
    const perVersion: number[] = [];
    let totalRuns = 0;
    for (const runs of versions.values()) {
      perVersion.push(fn(runs.map((r) => r.result)));
      totalRuns += runs.length;
    }

    const score =
      model === "weighted" ? aggregateWeighted(perVersion, lam) : aggregateUnweighted(perVersion);
    const conf = confidence(totalRuns, perVersion);

    rows.push({
      rank: 0,
      test_id: testId,
      // lower_bound uses the *unrounded* score and the *rounded* confidence, as in Python.
      score: round4(score),
      confidence: conf,
      lower_bound_score: round4(Math.max(0, score * conf)),
      verdict: verdict(score),
      total_runs: totalRuns,
      num_versions: perVersion.length,
      low_data: totalRuns < minReruns,
    });
  }

  // Stable descending sort on (score, confidence, total_runs) — matches Python's
  // sorted(..., reverse=True), which also preserves input order among equal keys.
  rows.sort(
    (a, b) => b.score - a.score || b.confidence - a.confidence || b.total_runs - a.total_runs,
  );
  rows.forEach((row, i) => (row.rank = i + 1));
  return rows;
}
