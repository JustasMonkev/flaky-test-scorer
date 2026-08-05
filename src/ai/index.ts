// Contract between the CLI layer and the AI provider layer (SPEC-V2.md §2).
// This file is the wiring: the pieces live in the sibling modules.

import { resolve } from "./credentials.js";
import { buildPrompt, splitByTest, testIds } from "./prompt.js";
import { ProviderError, type ExplainInput, type ExplainResult, type ProviderName } from "./types.js";

export { authStatus, autoSelectProvider, requireProvider } from "./credentials.js";
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
  // Each SDK is imported only when its provider is actually called, so `auth *`,
  // the MCP server at rest, and an --explain run on the other provider pay for
  // neither (the SDKs are the heavyweight imports — see cli/lazy-ai.ts).
  let model: string;
  let text: string;
  if (provider === "claude") {
    const { CLAUDE_MODEL, explainClaudeApi } = await import("./claude.js");
    model = CLAUDE_MODEL;
    text = await explainClaudeApi(cred, prompt);
  } else {
    const { CODEX_MODEL, explainCodexApi } = await import("./codex.js");
    model = process.env["FTS_CODEX_MODEL"] || CODEX_MODEL;
    text = await explainCodexApi(cred, prompt, model);
  }
  return { provider, model, perTest: splitByTest(text, testIds(input)) };
}
