import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderName } from "./types.js";

interface Config {
  providers?: Partial<Record<ProviderName, { api_key?: string }>>;
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
    return typeof parsed === "object" && parsed !== null ? (parsed as Config) : {};
  } catch {
    return {}; // missing or corrupt config is simply "no stored keys"
  }
}

function writeConfig(cfg: Config): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodQuiet(file, 0o600); // mode on writeFileSync only applies to newly created files
}

export function storedKey(provider: ProviderName): string | undefined {
  return readConfig().providers?.[provider]?.api_key || undefined;
}

/** masked tail, e.g. "...xY9z" — the only key material ever surfaced */
export function maskTail(key: string): string {
  // A key of 4 chars or fewer would be printed whole by a plain slice(-4).
  return key.length > 4 ? `...${key.slice(-4)}` : "...";
}

export function setKey(provider: ProviderName, key: string): void {
  const cfg = readConfig();
  cfg.providers = { ...cfg.providers, [provider]: { api_key: key } };
  writeConfig(cfg);
}

export function clearKey(provider: ProviderName): void {
  const cfg = readConfig();
  if (cfg.providers) delete cfg.providers[provider];
  writeConfig(cfg);
}
