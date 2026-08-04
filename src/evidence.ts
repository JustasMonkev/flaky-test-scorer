import { round4, type RunRecord } from "./score.js";

export interface FailureCluster {
  pattern: string;
  count: number;
  sample: string;
}

export interface Evidence {
  transitions: { flips: number; total_runs: number };
  /** Versions where the SAME version has both a pass and a fail. */
  within_version_flips: number;
  /** Executions retried in-run (Surefire reruns, Playwright retries) whose attempts disagreed. */
  within_run_retries: number;
  duration_variance: { cv: number; suite_median_cv: number; ratio: number } | null;
  failure_clusters: FailureCluster[];
}

export type CauseCategory =
  | "timeout"
  | "network"
  | "element"
  | "race"
  | "resource"
  | "assertion"
  | "unknown";

export interface LikelyCause {
  category: CauseCategory;
  confidence: "low" | "medium" | "high";
  matched_messages: number;
  heuristic: true;
}

/** Ordered: earlier categories win ties. */
const KEYWORDS: [CauseCategory, string[]][] = [
  ["timeout", ["timeout", "timed out", "etimedout", "deadline", "exceeded while waiting", "waitfor", "wait_for", "did not complete in"]],
  ["network", ["econnrefused", "econnreset", "enotfound", "socket", "dns", "network", "connection refused", "connection reset", "502", "503", "504", "ssl", "tls handshake", "proxy"]],
  ["element", ["element", "selector", "locator", "not visible", "not clickable", "not attached", "stale element", "xpath", "no such element", "detached from the dom"]],
  ["race", ["race", "concurren", "deadlock", "unhandled rejection", "promise", "not yet ready", "already in progress", "out of order", "state mutated"]],
  ["resource", ["out of memory", "oom", "heap", "enospc", "no space left", "emfile", "too many open files", "quota exceeded", "disk"]],
  ["assertion", ["expected", "assert", "to be", "to equal", "toequal", "tobe", "mismatch", "actual:", "deepequal", "differs"]],
];

const RECOMMENDATIONS: Record<CauseCategory, string> = {
  timeout: "Replace the live dependency with a controlled stub and inspect timeout handling.",
  network: "Stub the network boundary (record/replay or a local fake) so the test stops depending on remote availability.",
  element: "Replace fixed waits with state-based waits on a stable selector before interacting with the element.",
  race: "Make the async ordering explicit: await the completion signal instead of a sleep, and reset shared state between runs.",
  resource: "Reduce per-run resource usage or isolate the test; check for leaked handles, files, or memory across runs.",
  assertion: "Pin the varying input (clock, RNG, locale, ordering) or assert on a tolerance instead of an exact value.",
  unknown: "Re-run the test in isolation with verbose logging to capture a reproducible failure before quarantining.",
};

export function recommendationFor(category: CauseCategory): string {
  return RECOMMENDATIONS[category];
}

/** Strip volatile parts (paths, hex, durations, numbers) so messages cluster. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\s+/g, " ")
    // Both separators: Windows stack traces clustered as distinct patterns without `\`.
    .replace(/(?:[A-Za-z]:)?(?:[\w.@-]*[/\\])+[\w.@-]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|minutes)\b/gi, "<dur>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .trim()
    .slice(0, 200);
}

function clusters(messages: string[]): FailureCluster[] {
  const groups = new Map<string, FailureCluster>();
  for (const message of messages) {
    const pattern = normalizeMessage(message);
    if (!pattern) continue;
    const hit = groups.get(pattern);
    if (hit) hit.count++;
    else groups.set(pattern, { pattern, count: 1, sample: message.slice(0, 300) });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 3);
}

// Keywords match at a word start (so "oom" does not fire on "boom") but may be
// prefixes ("concurren" -> "concurrency").
const PATTERNS: [CauseCategory, RegExp[]][] = KEYWORDS.map(([category, keywords]) => [
  category,
  keywords.map((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
]);

export function classify(messages: string[]): LikelyCause {
  const counts = new Map<CauseCategory, number>();
  for (const message of messages) {
    const text = message.toLowerCase();
    for (const [category, patterns] of PATTERNS) {
      if (patterns.some((re) => re.test(text))) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
        break; // first matching category owns the message
      }
    }
  }

  let best: CauseCategory = "unknown";
  let bestCount = 0;
  for (const [category] of KEYWORDS) {
    const count = counts.get(category) ?? 0;
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }

  const dominance = bestCount > 0 ? bestCount / messages.length : 0;
  const confidence =
    bestCount >= 3 && dominance >= 0.7 ? "high" : bestCount >= 2 && dominance >= 0.5 ? "medium" : "low";

  return {
    category: best,
    confidence: best === "unknown" ? "low" : confidence,
    matched_messages: bestCount,
    heuristic: true,
  };
}

function coefficientOfVariation(durations: number[]): number | null {
  const values = durations.filter((d) => Number.isFinite(d) && d >= 0);
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((a, d) => a + (d - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Per-test coefficient of variation for durations, plus the suite-wide median CV. */
export function durationStats(
  grouped: Map<string, Map<string, RunRecord[]>>,
): { perTest: Map<string, number>; suiteMedian: number | null } {
  const perTest = new Map<string, number>();
  for (const [testId, versions] of grouped) {
    const durations = [...versions.values()]
      .flat()
      .map((r) => r.duration_s)
      .filter((d): d is number => d !== null);
    const cv = coefficientOfVariation(durations);
    if (cv !== null) perTest.set(testId, cv);
  }
  return { perTest, suiteMedian: median([...perTest.values()]) };
}

export function buildEvidence(
  testId: string,
  versions: Map<string, RunRecord[]>,
  durations: { perTest: Map<string, number>; suiteMedian: number | null },
): { evidence: Evidence; likely_cause: LikelyCause } {
  const all = [...versions.values()].flat();

  let flips = 0;
  let withinVersionFlips = 0;
  let withinRunRetries = 0;
  for (const runs of versions.values()) {
    for (let i = 1; i < runs.length; i++) if (runs[i]!.result !== runs[i - 1]!.result) flips++;
    if (runs.some((r) => r.result) && runs.some((r) => !r.result)) withinVersionFlips++;

    // Attempts of one execution are consecutive and restart at attempt 0; a run
    // without an attempt index ends whatever group preceded it.
    let group: boolean[] = [];
    const flush = () => {
      if (group.length > 1 && group.includes(true) && group.includes(false)) withinRunRetries++;
      group = [];
    };
    for (const run of runs) {
      if (run.attempt === undefined || run.attempt === null) {
        flush();
        continue;
      }
      if (run.attempt === 0) flush();
      group.push(run.result);
    }
    flush();
  }

  const cv = durations.perTest.get(testId);
  const suiteMedian = durations.suiteMedian;
  const durationVariance =
    cv !== undefined && suiteMedian !== null && suiteMedian > 0
      ? { cv: round4(cv), suite_median_cv: round4(suiteMedian), ratio: round4(cv / suiteMedian) }
      : null;

  const messages = all.map((r) => r.failure_message).filter((m): m is string => !!m);

  return {
    evidence: {
      transitions: { flips, total_runs: all.length },
      within_version_flips: withinVersionFlips,
      within_run_retries: withinRunRetries,
      duration_variance: durationVariance,
      failure_clusters: clusters(messages),
    },
    likely_cause: classify(messages),
  };
}
