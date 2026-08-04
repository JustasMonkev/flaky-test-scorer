import { existsSync, readFileSync } from "node:fs";
import { InputError, stripBom, writeAtomic } from "./common.js";

export interface BaselineEntry {
  test_id: string;
  lower_bound_score: number;
}

/** Known-flaky test ids. A missing file is an empty baseline, not an error. */
export function readBaseline(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  let data: unknown;
  try {
    data = JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (err) {
    throw new InputError(
      `malformed baseline file ${path}: ${(err as Error).message}. ` +
        `Regenerate it with \`flaky-test-scorer baseline update\`.`,
    );
  }
  const tests = (data as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(tests)) {
    throw new InputError(`${path}: baseline file must be an object with a "tests" list`);
  }
  return new Set(
    tests
      .map((t) => (t as BaselineEntry | null)?.test_id)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** Sorted by test_id and timestamp-free, so a baseline commit diffs meaningfully. */
export function writeBaseline(path: string, tests: BaselineEntry[]): BaselineEntry[] {
  const entries = tests
    .filter((t) => t.lower_bound_score > 0)
    .map((t) => ({ test_id: t.test_id, lower_bound_score: t.lower_bound_score }))
    .sort((a, b) => (a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0));
  writeAtomic(path, `${JSON.stringify({ schema_version: 1, tests: entries }, null, 2)}\n`);
  return entries;
}
