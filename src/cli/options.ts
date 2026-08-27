import type { ProviderName } from "../ai/index.js";
import { InputError } from "../ingest.js";
import { SCORE_DEFAULTS, type Metric, type Model } from "../score.js";

export const DEFAULT_BASELINE = ".flaky-baseline.json";

const PROVIDERS = ["claude", "codex"] as const;

/** Finite-number option. Range checks belong at the call site — this one has none. */
export function numberOption(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new InputError(`--${name} must be a number, got "${raw}"`);
  return value;
}

export function asProvider(raw: string, what: string): ProviderName {
  const provider = PROVIDERS.find((candidate) => candidate === raw);
  if (provider === undefined) {
    throw new InputError(`${what} must be claude, codex or auto, got "${raw}"`);
  }
  return provider;
}

/**
 * `--provider auto` means "first available", the documented default. The MCP
 * `explain_test` tool already accepted `auto`; the CLI rejected it, so the two
 * agent-facing surfaces spoke different vocabularies for the same choice.
 */
export function parseProvider(raw: string | undefined): ProviderName | undefined {
  if (raw === undefined || raw === "auto") return undefined;
  return asProvider(raw, "--provider");
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
  explain: boolean;
  provider?: string;
  explainTop?: string;
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
