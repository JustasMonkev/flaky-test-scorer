import { existsSync, readFileSync } from "node:fs";
import { cleanTestId, InputError, stripBom, writeAtomic } from "./common.js";

export interface BaselineEntry {
  test_id: string;
  gating_score: number;
}

const SCHEMA_VERSION = 2;
const REGENERATE = "Regenerate it with `flaky-test-scorer baseline update`.";

function baselineError(path: string, detail: string): InputError {
  return new InputError(`${path}: ${detail}. ${REGENERATE}`);
}

function canonicalId(path: string, index: number, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || cleanTestId(value) !== value) {
    throw baselineError(path, `tests[${index}].test_id must be a non-empty canonical string`);
  }
  return value;
}

/** Known-flaky test ids and their gating ceilings. A missing file is empty. */
export function readBaseline(path: string): Map<string, number> {
  if (!existsSync(path)) return new Map();
  let data: unknown;
  try {
    data = JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (err) {
    throw baselineError(path, `malformed baseline file: ${(err as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw baselineError(path, "baseline file must be an object");
  }
  // SAFETY: the checks above narrow data to a non-null, non-array object.
  const object = data as { schema_version?: unknown; tests?: unknown };
  if (object.schema_version !== SCHEMA_VERSION) {
    throw baselineError(path, `baseline schema_version must be exactly ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(object.tests)) {
    throw baselineError(path, 'baseline file must contain a "tests" list');
  }

  const entries = new Map<string, number>();
  for (const [index, value] of object.tests.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw baselineError(path, `tests[${index}] must be an object`);
    }
    // SAFETY: value is an object; every field is validated before use.
    const entry = value as Partial<BaselineEntry>;
    const testId = canonicalId(path, index, entry.test_id);
    if (entries.has(testId)) {
      throw baselineError(path, `tests[${index}].test_id is duplicated`);
    }
    if (typeof entry.gating_score !== "number" || !Number.isFinite(entry.gating_score)) {
      throw baselineError(path, `tests[${index}].gating_score must be a finite number`);
    }
    if (entry.gating_score < 0 || entry.gating_score > 1) {
      throw baselineError(path, `tests[${index}].gating_score must be between 0 and 1`);
    }
    entries.set(testId, entry.gating_score);
  }
  return entries;
}

/** Sorted by test_id and timestamp-free, so a baseline commit diffs meaningfully. */
export function writeBaseline(path: string, tests: BaselineEntry[]): BaselineEntry[] {
  const seen = new Set<string>();
  for (const [index, value] of tests.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw baselineError(path, `tests[${index}] must be an object`);
    }
    const testId = canonicalId(path, index, value.test_id);
    if (seen.has(testId)) {
      throw baselineError(path, `tests[${index}].test_id is duplicated`);
    }
    if (typeof value.gating_score !== "number" || !Number.isFinite(value.gating_score)) {
      throw baselineError(path, `tests[${index}].gating_score must be a finite number`);
    }
    if (value.gating_score < 0 || value.gating_score > 1) {
      throw baselineError(path, `tests[${index}].gating_score must be between 0 and 1`);
    }
    seen.add(testId);
  }
  const entries = tests
    .filter((t) => t.gating_score > 0)
    .map((t) => ({ test_id: t.test_id, gating_score: t.gating_score }))
    .sort((a, b) => (a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0));
  writeAtomic(path, `${JSON.stringify({ schema_version: SCHEMA_VERSION, tests: entries }, null, 2)}\n`);
  return entries;
}
