import OpenAI from "openai";
import type { Credential } from "./credentials.js";
import { ProviderError } from "./types.js";

export const CODEX_MODEL = "gpt-5.2-codex";

export async function explainCodexApi(
  cred: Credential & { mode: "api" },
  prompt: string,
  model: string,
): Promise<string> {
  const client = new OpenAI({ apiKey: cred.key });
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
    });
    return (completion.choices[0]?.message?.content ?? "").trim();
  } catch (e) {
    throw codexError(e);
  }
}

function codexError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof OpenAI.AuthenticationError)
    return new ProviderError(
      "Codex rejected the credentials (401). Set OPENAI_API_KEY or run `flaky-test-scorer auth set-key codex`.",
      "codex",
    );
  if (e instanceof OpenAI.RateLimitError)
    return new ProviderError("Codex rate limit reached (429). Try again later.", "codex");
  if (e instanceof OpenAI.APIConnectionError)
    return new ProviderError("Could not reach the OpenAI API (connection error).", "codex");
  if (e instanceof OpenAI.APIError)
    return new ProviderError(`OpenAI API error (${e.status ?? "unknown"}): ${e.message}`, "codex");
  return new ProviderError(
    `Codex request failed: ${e instanceof Error ? e.message : String(e)}`,
    "codex",
  );
}
