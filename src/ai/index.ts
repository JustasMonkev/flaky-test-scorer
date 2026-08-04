// Contract between the CLI layer and the AI provider layer (SPEC-V2.md §2).
// This file is the wiring: the pieces live in the sibling modules.

import { CLAUDE_MODEL, explainClaudeApi } from "./claude.js";
import { CODEX_MODEL, explainCodexApi } from "./codex.js";
import { resolve } from "./credentials.js";
import { buildPrompt, splitByTest, testIds } from "./prompt.js";
import { ProviderError, type ExplainInput, type ExplainResult, type ProviderName } from "./types.js";

export { authStatus, autoSelectProvider } from "./credentials.js";
export { clearKey, setKey } from "./config.js";
export {
  ProviderError,
  type ExplainInput,
  type ExplainResult,
  type ProviderName,
  type ProviderStatus,
} from "./types.js";

export async function explain(
  provider: ProviderName,
  input: ExplainInput,
): Promise<ExplainResult> {
  const cred = resolve(provider);
  if (cred.mode === "none") {
    throw new ProviderError(
      provider === "claude"
        ? "No Claude credentials: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) or run `flaky-test-scorer auth set-key claude`."
        : "No Codex credentials: set OPENAI_API_KEY or run `flaky-test-scorer auth set-key codex`.",
      provider,
    );
  }
  const prompt = buildPrompt(input);
  const model = provider === "claude" ? CLAUDE_MODEL : process.env["FTS_CODEX_MODEL"] || CODEX_MODEL;
  const text =
    provider === "claude"
      ? await explainClaudeApi(cred, prompt)
      : await explainCodexApi(cred, prompt, model);
  return { provider, model, perTest: splitByTest(text, testIds(input)) };
}
