// Contract between the CLI layer and the AI provider layer (SPEC-V2.md §2).
// The CLI codes against these signatures; the provider modules implement them.

export type ProviderName = "claude" | "codex";

export interface ProviderStatus {
  provider: ProviderName;
  available: boolean;
  /** e.g. "ANTHROPIC_API_KEY env", "config file", "not configured" */
  source: string;
  /** masked key tail like "...xY9z" when an API key is the source, else null */
  keyTail: string | null;
}

export interface ExplainInput {
  /** the per-test report objects (score, evidence, likely_cause, ...) */
  tests: unknown[];
}

export interface ExplainResult {
  provider: ProviderName;
  /** provider model id */
  model: string;
  perTest: { test_id: string; analysis: string }[];
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
