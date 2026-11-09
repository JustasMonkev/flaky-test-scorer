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

  return validatedEntries(path, object.tests);
}

function validatedEntries(path: string, tests: unknown[]): Map<string, number> {
  const entries = new Map<string, number>();
  for (const [index, value] of tests.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw baselineError(path, `tests[${index}] must be an object`);
    }
    const testId = canonicalId(path, index, "test_id" in value ? value.test_id : undefined);
    if (entries.has(testId)) {
      throw baselineError(path, `tests[${index}].test_id is duplicated`);
    }
    const score = "gating_score" in value ? value.gating_score : undefined;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw baselineError(path, `tests[${index}].gating_score must be a finite number`);
    }
    if (score < 0 || score > 1) {
      throw baselineError(path, `tests[${index}].gating_score must be between 0 and 1`);
    }
    entries.set(testId, score);
  }
  return entries;
}

export function writeBaseline(path: string, tests: BaselineEntry[]): BaselineEntry[] {
  const entries = [...validatedEntries(path, tests)]
    .filter(([, score]) => score > 0)
    .map(([test_id, gating_score]) => ({ test_id, gating_score }))
    .sort((a, b) => (a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0));
  writeAtomic(path, `${JSON.stringify({ schema_version: SCHEMA_VERSION, tests: entries }, null, 2)}\n`);
  return entries;
}
