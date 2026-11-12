import { existsSync, readFileSync } from "node:fs";
import { cleanTestId, InputError, isRecord, stripBom, writeAtomic } from "./common.js";

export interface BaselineEntry {
  test_id: string;
  gating_score: number;
}

const SCHEMA_VERSION = 2;
const REGENERATE = "Regenerate it with `flaky-test-scorer baseline update`.";

function baselineError(path: string, detail: string): InputError {
  return new InputError(`${path}: ${detail}. ${REGENERATE}`);
}

function baselineEntries(path: string, tests: readonly unknown[]): Map<string, number> {
  const entries = new Map<string, number>();
  for (const [index, entry] of tests.entries()) {
    if (!isRecord(entry)) throw baselineError(path, `tests[${index}] must be an object`);

    const testId = entry["test_id"];
    if (typeof testId !== "string" || testId.length === 0 || cleanTestId(testId) !== testId) {
      throw baselineError(path, `tests[${index}].test_id must be a non-empty canonical string`);
    }
    if (entries.has(testId)) throw baselineError(path, `tests[${index}].test_id is duplicated`);

    const score = entry["gating_score"];
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

export function readBaseline(path: string): Map<string, number> {
  if (!existsSync(path)) return new Map();
  let data: unknown;
  try {
    data = JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (err) {
    throw baselineError(path, `malformed baseline file: ${(err as Error).message}`);
  }
  if (!isRecord(data)) throw baselineError(path, "baseline file must be an object");
  if (data["schema_version"] !== SCHEMA_VERSION) {
    throw baselineError(path, `baseline schema_version must be exactly ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(data["tests"])) {
    throw baselineError(path, 'baseline file must contain a "tests" list');
  }

  return baselineEntries(path, data["tests"]);
}

export function writeBaseline(path: string, tests: BaselineEntry[]): BaselineEntry[] {
  const entries = [...baselineEntries(path, tests)]
    .filter(([, score]) => score > 0)
    .map(([test_id, gating_score]) => ({ test_id, gating_score }))
    .sort((a, b) => (a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0));
  writeAtomic(path, `${JSON.stringify({ schema_version: SCHEMA_VERSION, tests: entries }, null, 2)}\n`);
  return entries;
}
