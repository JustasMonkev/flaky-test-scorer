import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderName } from "./types.js";

type Config = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "flaky-test-scorer", "config.json");
}

/**
 * chmod is advisory on win32 and on some mounts. The 0600 is a best effort — failing
 * it must not abort a config write the user explicitly asked for.
 */
function chmodQuiet(file: string, mode: number): void {
  try {
    chmodSync(file, mode);
  } catch {
    /* permissions are not enforceable here */
  }
}

function readConfig(): Config {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {}; // missing or corrupt config is simply "no stored keys"
  }
}

function providersIn(config: Config): Record<string, unknown> {
  return isRecord(config["providers"]) ? config["providers"] : {};
}

function writeConfig(cfg: Config): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodQuiet(file, 0o600); // mode on writeFileSync only applies to newly created files
}

export function storedKey(provider: ProviderName): string | undefined {
  const entry = providersIn(readConfig())[provider];
  return isRecord(entry) && typeof entry["api_key"] === "string" && entry["api_key"]
    ? entry["api_key"]
    : undefined;
}

/** masked tail, e.g. "...xY9z" — the only key material ever surfaced */
export function maskTail(key: string): string {
  // A key of 4 chars or fewer would be printed whole by a plain slice(-4).
  return key.length > 4 ? `...${key.slice(-4)}` : "...";
}

export function setKey(provider: ProviderName, key: string): void {
  const cfg = readConfig();
  const providers = providersIn(cfg);
  const previous = providers[provider];
  cfg["providers"] = {
    ...providers,
    [provider]: { ...(isRecord(previous) ? previous : {}), api_key: key },
  };
  writeConfig(cfg);
}

export function clearKey(provider: ProviderName): void {
  const cfg = readConfig();
  const current = cfg["providers"];
  if (isRecord(current)) {
    const providers = { ...current };
    delete providers[provider];
    cfg["providers"] = providers;
  }
  writeConfig(cfg);
}
