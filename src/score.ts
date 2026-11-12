export interface RunRecord {
  test_id: string;
  /** true = pass, false = fail */
  result: boolean;
  version: string | null;
  timestamp: string | number | null;
  duration_s: number | null;
  failure_message: string | null;
  source_file: string | null;
  /** Zero-based retry index within an execution, omitted for single-attempt runs. */
  attempt?: number | null;
  /** Stable identity shared by every retry attempt of one execution. */
  execution_id?: string | null;
}

export type Metric = "flipRate" | "entropy";
export type Model = "weighted" | "unweighted";
export type Verdict = "not_flaky" | "slightly_flaky" | "flaky" | "very_flaky";

export interface ScoredTest {
  rank: number;
  test_id: string;
  score: number;
  confidence: number;
  gating_score: number;
  verdict: Verdict;
  total_runs: number;
  independent_runs: number;
  num_versions: number;
  low_data: boolean;
}

// An exact halfway value at four decimal places in toFixed(30) output.
const EXACT_TIE_AT_4DP = /\.\d{4}50{25}$/;

/** Round to four decimal places with Python's ties-to-even rule. */
export function round4(value: number): number {
  const exact = value.toFixed(30);
  if (!EXACT_TIE_AT_4DP.test(exact)) return Number(value.toFixed(4));
  const cut = exact.indexOf(".") + 5;
  const truncated = Number(exact.slice(0, cut));
  return Number(exact[cut - 1]) % 2 === 0
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

export function countFlips(results: boolean[]): number {
  let flips = 0;
  for (let i = 1; i < results.length; i++) {
    if (results[i] !== results[i - 1]) flips++;
  }
  return flips;
}

export function flipRate(results: boolean[]): number {
  const count = results.length;
  return count < 2 ? 0 : countFlips(results) / (count - 1);
}

function sampleWeights(versionScores: number[], weights: number[] | undefined): number[] | undefined {
  return weights?.length === versionScores.length &&
    weights.every((weight) => Number.isFinite(weight) && weight > 0)
    ? weights
    : undefined;
}

/** Mean of per-version scores. Optional weights are independent run counts. */
export function aggregateUnweighted(versionScores: number[], weights?: number[]): number {
  if (versionScores.length === 0) return 0;
  const usableWeights = sampleWeights(versionScores, weights);
  if (!usableWeights) return versionScores.reduce((a, b) => a + b, 0) / versionScores.length;
  const denominator = usableWeights.reduce((a, weight) => a + weight, 0);
  return denominator > 0
    ? versionScores.reduce((sum, value, index) => sum + value * usableWeights[index]!, 0) / denominator
    : 0;
}

/** Exponentially weighted moving average across versions (newest last). */
export function aggregateWeighted(
  versionScores: number[],
  lam = 0.1,
  weights?: number[],
): number {
  if (versionScores.length === 0) return 0;
  let numerator = 0;
  let denominator = 0;
  const count = versionScores.length;
  const usableWeights = sampleWeights(versionScores, weights);
  for (let index = 0; index < count; index++) {
    const age = count - 1 - index;
    const weight = lam * Math.pow(1 - lam, age) * (usableWeights?.[index] ?? 1);
    numerator += weight * versionScores[index]!;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/** Confidence in [0,1] from independent data volume and weighted score stability. Rounded to 4dp. */
export function confidence(
  totalRuns: number,
  versionScores: number[],
  weights?: number[],
): number {
  const dataFactor = 1 - 1 / Math.sqrt(Math.max(totalRuns, 1));
  if (versionScores.length < 2) return round4(dataFactor);

  const mean = aggregateUnweighted(versionScores, weights);
  const variance = aggregateUnweighted(versionScores.map((score) => (score - mean) ** 2), weights);
  return round4(dataFactor * Math.max(0, 1 - Math.sqrt(variance)));
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
    // Treat offset-less timestamps as UTC regardless of the process timezone.
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text;
    const hasOffset = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized);
    const parsed = Date.parse((hasOffset ? normalized : `${normalized}Z`).replace(/Z$/i, "+00:00"));
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
  const keys = runs.map((run) => timestampKey(run.timestamp));
  const order = runs.map((_, index) => index);
  order.sort((a, b) => compareKeys(keys[a]!, keys[b]!) || a - b);

  const byTest = new Map<string, Map<string, RunRecord[]>>();
  for (const index of order) {
    const run = runs[index]!;
    let versions = byTest.get(run.test_id);
    if (!versions) byTest.set(run.test_id, (versions = new Map()));
    const version = run.version ?? NO_VERSION;
    let list = versions.get(version);
    if (!list) versions.set(version, (list = []));
    list.push(run);
  }
  return byTest;
}

function validAttempt(attempt: RunRecord["attempt"]): attempt is number {
  return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 0;
}

export function validExecutionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** Identified retry chains can interleave. Legacy attempts must be adjacent. */
export function groupIndependentRuns(runs: RunRecord[]): RunRecord[][] {
  const groups: RunRecord[][] = [];
  const active = new Map<string | null, { group: RunRecord[]; attempt: number | null }>();

  for (const run of runs) {
    const { execution_id, attempt } = run;
    const id = validExecutionId(execution_id) ? execution_id : null;
    if (id !== null) active.delete(null);
    const index = validAttempt(attempt) ? attempt : null;
    const previous = active.get(id);
    if (index !== null && previous && previous.attempt !== null && index === previous.attempt + 1) {
      previous.group.push(run);
      previous.attempt = index;
      continue;
    }
    const group = [run];
    groups.push(group);
    active.set(id, { group, attempt: index });
  }
  return groups;
}

export function countIndependentRuns(runs: RunRecord[]): number {
  return groupIndependentRuns(runs).length;
}

export interface ScoreOptions {
  metric?: Metric;
  model?: Model;
  lam?: number;
  minReruns?: number;
}

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
    const perVersionIndependentRuns: number[] = [];
    let totalRuns = 0;
    let independentRuns = 0;
    for (const runs of versions.values()) {
      totalRuns += runs.length;
      const executionGroups = groupIndependentRuns(runs);
      const versionIndependentRuns = executionGroups.length;
      independentRuns += versionIndependentRuns;
      if (runs.length < 2) continue;
      perVersion.push(fn(executionGroups.flat().map((r) => r.result)));
      perVersionIndependentRuns.push(versionIndependentRuns);
    }

    const rawScore =
      model === "weighted"
        ? aggregateWeighted(perVersion, lam, perVersionIndependentRuns)
        : aggregateUnweighted(perVersion, perVersionIndependentRuns);
    const comparableRuns = perVersionIndependentRuns.reduce((sum, count) => sum + count, 0);
    const conf = comparableRuns === 0 ? 0 : confidence(comparableRuns, perVersion, perVersionIndependentRuns);
    const lowData = !perVersionIndependentRuns.some((count) => count >= minReruns);

    rows.push({
      rank: 0,
      test_id: testId,
      score: round4(rawScore),
      confidence: conf,
      gating_score: round4(lowData ? 0 : Math.max(0, rawScore * conf)),
      verdict: verdict(rawScore),
      total_runs: totalRuns,
      independent_runs: independentRuns,
      num_versions: versions.size,
      low_data: lowData,
    });
  }

  rows.sort(
    (a, b) => b.score - a.score || b.confidence - a.confidence || b.total_runs - a.total_runs,
  );
  rows.forEach((row, i) => (row.rank = i + 1));
  return rows;
}
