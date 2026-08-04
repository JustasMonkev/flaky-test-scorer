import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Usage / input error — the CLI maps this to exit code 2. */
export class InputError extends Error {}

const PASS_VALUES = new Set(["pass", "passed", "p", "ok", "success", "true", "1", "green"]);
const FAIL_VALUES = new Set(["fail", "failed", "f", "error", "failure", "false", "0", "red"]);

/** Map a raw result cell to true (pass), false (fail), or null (unusable). */
export function normalizeResult(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (PASS_VALUES.has(value)) return true;
  if (FAIL_VALUES.has(value)) return false;
  return null;
}

/** First aliased value that is present and non-blank (keeps 0 / false). */
export function firstValue(row: Record<string, unknown>, keys: string[]): unknown {
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

/**
 * Collapse control/format characters in a test id to a space.
 *
 * A test name is attacker-supplied text that ends up on every output stream. A
 * newline inside one turns the report into forged GitHub Actions workflow
 * commands: `name="x&#10;::error title=..."` renders as its own `::error` line,
 * which the runner executes. Bidi/zero-width format characters likewise let one
 * id impersonate another in a PR comment. XML attribute-value normalization
 * mandates this collapse anyway, so it also makes JUnit ids spec-correct.
 */
export const cleanTestId = (raw: string): string =>
  raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export type XmlNode = Record<string, unknown>;

export const asArray = (value: unknown): XmlNode[] =>
  Array.isArray(value) ? (value as XmlNode[]) : value && typeof value === "object" ? [value as XmlNode] : [];

/**
 * tmp + rename: a merge or prune killed mid-write must leave the old history
 * intact rather than a truncated one, and readers never see a partial file.
 *
 * ponytail: no fsync before the rename, and the tmp name is pid-only. Ceiling —
 * a host crash (not a process crash) can still lose the file on filesystems that
 * reorder data against metadata, and two containers sharing a volume can pick the
 * same pid. Upgrade path: fsync the fd before close and add a random suffix.
 */
export function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw new InputError(`could not write ${path}: ${(err as Error).message}`);
  }
}
