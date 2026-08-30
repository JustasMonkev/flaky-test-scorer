import { InputError } from "../ingest.js";
import { SCORE_DEFAULTS, type Metric, type Model } from "../score.js";

export const DEFAULT_BASELINE = ".flaky-baseline.json";

/** Finite-number option. Range checks belong at the call site — this one has none. */
export function numberOption(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new InputError(`--${name} must be a number, got "${raw}"`);
  return value;
}

export interface ReportOptions {
  history?: string;
  commit?: string;
  json: boolean;
  metric?: string;
  model?: string;
  lam?: string;
  minReruns?: string;
  top?: string;
  failAbove?: string;
  format?: string;
  baseline?: string;
}

export interface ScoreParams {
  metric: Metric;
  model: Model;
  lam: number;
  minReruns: number;
}

export function parseScoreParams(values: ReportOptions): ScoreParams {
  const raw = values.metric ?? SCORE_DEFAULTS.metric;
  const metricName = raw.toLowerCase();
  if (metricName !== "fliprate" && metricName !== "entropy") {
    throw new InputError(`--metric must be flipRate or entropy, got "${raw}"`);
  }
  const metric: Metric = metricName === "fliprate" ? "flipRate" : "entropy";
  const model = values.model ?? SCORE_DEFAULTS.model;
  if (model !== "weighted" && model !== "unweighted") {
    throw new InputError(`--model must be weighted or unweighted, got "${model}"`);
  }
  const lam = numberOption(values.lam, "lam", SCORE_DEFAULTS.lam);
  if (!(lam > 0 && lam <= 1)) throw new InputError("--lam must be in range (0, 1]");
  const minReruns = numberOption(values.minReruns, "min-reruns", SCORE_DEFAULTS.minReruns);
  if (minReruns < 1) throw new InputError("--min-reruns must be >= 1");
  return { metric, model, lam, minReruns };
}

export function requireHistory(history: string | undefined, command: string): string {
  if (!history) throw new InputError(`${command} needs --history <file>`);
  return history;
}
