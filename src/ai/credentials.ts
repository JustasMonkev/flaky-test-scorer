import { maskTail, storedKey } from "./config.js";
import type { ProviderName, ProviderStatus } from "./types.js";

export type Credential =
  | { mode: "api"; source: string; key: string; auth: "apiKey" | "authToken" }
  | { mode: "none"; source: string };

export function resolve(provider: ProviderName): Credential {
  if (provider === "claude") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (apiKey) return { mode: "api", source: "ANTHROPIC_API_KEY env", key: apiKey, auth: "apiKey" };
    const token = process.env["ANTHROPIC_AUTH_TOKEN"];
    if (token)
      return { mode: "api", source: "ANTHROPIC_AUTH_TOKEN env", key: token, auth: "authToken" };
    const stored = storedKey("claude");
    if (stored) return { mode: "api", source: "config file", key: stored, auth: "apiKey" };
    return { mode: "none", source: "not configured" };
  }
  const apiKey = process.env["OPENAI_API_KEY"];
  if (apiKey) return { mode: "api", source: "OPENAI_API_KEY env", key: apiKey, auth: "apiKey" };
  const stored = storedKey("codex");
  if (stored) return { mode: "api", source: "config file", key: stored, auth: "apiKey" };
  return { mode: "none", source: "not configured" };
}

export function authStatus(): ProviderStatus[] {
  return (["claude", "codex"] as const).map((provider) => {
    const cred = resolve(provider);
    return {
      provider,
      available: cred.mode !== "none",
      source: cred.source,
      keyTail: cred.mode === "api" ? maskTail(cred.key) : null,
    };
  });
}

/** First available provider in order claude, codex; null when none. */
export function autoSelectProvider(): ProviderName | null {
  return authStatus().find((s) => s.available)?.provider ?? null;
}

/** The requested provider, or the auto-selected one — one error wording for every surface. */
export function requireProvider(requested?: ProviderName): ProviderName {
  const provider = requested ?? autoSelectProvider();
  if (!provider) {
    throw new Error(
      "no AI provider configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run " +
        "`flaky-test-scorer auth set-key <provider>`",
    );
  }
  return provider;
}
