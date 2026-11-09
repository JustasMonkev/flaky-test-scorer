import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";

/** Usage / input error — the CLI maps this to exit code 2. */
export class InputError extends Error {}

const PASS_VALUES = new Set(["pass", "passed", "p", "ok", "success", "true", "1", "green"]);
const FAIL_VALUES = new Set(["fail", "failed", "f", "error", "failure", "false", "0", "red"]);

export function normalizeResult(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (PASS_VALUES.has(value)) return true;
  if (FAIL_VALUES.has(value)) return false;
  return null;
}

/** First aliased value that is present and non-blank (keeps 0 / false). */
export function firstValue(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (!(key in row)) continue;
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

export const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// Test IDs must not inject workflow commands or hide formatting characters.
export const cleanTestId = (raw: string): string =>
  raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();

const REL_POSIX_CACHE_LIMIT = 65_536;
const relPosixCache = new Map<string, string>();

export function relPosix(file: string, base = process.cwd()): string {
  const cacheKey = `${base}\u0000${file}`;
  const cached = relPosixCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = relative(base, file).split(sep).join("/");
  if (relPosixCache.size >= REL_POSIX_CACHE_LIMIT) relPosixCache.clear();
  relPosixCache.set(cacheKey, result);
  return result;
}

export const joinTestId = (parts: (string | null | undefined)[]): string =>
  cleanTestId(parts.filter(Boolean).join(" > "));

export function warnCorrupt(count: number, where: string): void {
  if (count > 0) process.stderr.write(`warning: skipped ${count} corrupt line(s) in ${where}\n`);
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export type XmlNode = Record<string, unknown>;

export const asArray = (value: unknown): XmlNode[] =>
  Array.isArray(value) ? (value as XmlNode[]) : value && typeof value === "object" ? [value as XmlNode] : [];

// Rename keeps partial writes hidden from readers.
export function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Preserve the original write error.
    }
    throw new InputError(`could not write ${path}: ${(err as Error).message}`);
  }
}
