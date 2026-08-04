import { maskTail, storedKey } from "./config.js";
import type { ProviderName, ProviderStatus } from "./types.js";

export type Credential =
  | { mode: "api"; source: string; key: string; auth: "apiKey" | "authToken" }
  | { mode: "none"; source: string };

/** Env vars checked in order, before falling back to the config file. */
const ENV_CREDENTIALS: Record<ProviderName, [name: string, auth: "apiKey" | "authToken"][]> = {
  claude: [
    ["ANTHROPIC_API_KEY", "apiKey"],
    ["ANTHROPIC_AUTH_TOKEN", "authToken"],
  ],
  codex: [["OPENAI_API_KEY", "apiKey"]],
};

export function resolve(provider: ProviderName): Credential {
  for (const [name, auth] of ENV_CREDENTIALS[provider]) {
    const key = process.env[name];
    if (key) return { mode: "api", source: `${name} env`, key, auth };
  }
  const stored = storedKey(provider);
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
