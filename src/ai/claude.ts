import Anthropic from "@anthropic-ai/sdk";
import type { Credential } from "./credentials.js";
import { ProviderError } from "./types.js";

export const CLAUDE_MODEL = "claude-opus-5";

export async function explainClaudeApi(
  cred: Credential & { mode: "api" },
  prompt: string,
): Promise<string> {
  const client = new Anthropic(
    cred.auth === "authToken" ? { authToken: cred.key } : { apiKey: cred.key },
  );
  try {
    const message = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
    if (message.stop_reason === "refusal") {
      throw new ProviderError(
        "Claude declined to analyze this evidence bundle (provider refusal).",
        "claude",
      );
    }
    return message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (e) {
    throw claudeError(e);
  }
}

function claudeError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.AuthenticationError)
    return new ProviderError(
      "Claude rejected the credentials (401). Set ANTHROPIC_API_KEY or run `flaky-test-scorer auth set-key claude`.",
      "claude",
    );
  if (e instanceof Anthropic.RateLimitError)
    return new ProviderError("Claude rate limit reached (429). Try again later.", "claude");
  if (e instanceof Anthropic.APIConnectionError)
    return new ProviderError("Could not reach the Claude API (connection error).", "claude");
  if (e instanceof Anthropic.APIError)
    return new ProviderError(`Claude API error (${e.status ?? "unknown"}): ${e.message}`, "claude");
  return new ProviderError(
    `Claude request failed: ${e instanceof Error ? e.message : String(e)}`,
    "claude",
  );
}
