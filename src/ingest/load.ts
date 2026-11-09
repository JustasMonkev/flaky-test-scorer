import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { RunRecord } from "../score.js";
import { InputError, relPosix, stripBom, warnCorrupt } from "./common.js";
import { readHistory } from "./history.js";
import { parseJUnit } from "./junit.js";
import { isPlaywrightReport, parsePlaywrightReport } from "./playwright.js";
import { parseCsv, runsFromRows } from "./rows.js";

export function loadFile(file: string, version: string | null): RunRecord[] {
  const lower = file.toLowerCase();
  if (lower.endsWith(".jsonl")) {
    if (!existsSync(file)) throw new InputError(`cannot read ${file}: no such file`);
    const { runs, corruptLines } = readHistory(file);
    warnCorrupt(corruptLines, file);
    return runs;
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new InputError(`cannot read ${file}: ${(err as Error).message}`);
  }

  const label = relPosix(file) || file;
  if (lower.endsWith(".csv")) return runsFromRows(parseCsv(text), label, version);
  if (lower.endsWith(".json")) {
    let data: unknown;
    try {
      data = JSON.parse(stripBom(text));
    } catch (err) {
      throw new InputError(
        `malformed JSON in ${file}: ${(err as Error).message}. Expected a list of run objects ` +
          `or an object with a "runs"/"results" list.`,
      );
    }
    if (isPlaywrightReport(data)) return parsePlaywrightReport(data, label, version);
    if (data && !Array.isArray(data) && typeof data === "object") {
      // SAFETY: the guard above narrows data to a non-null, non-array object.
      const obj = data as Record<string, unknown>;
      data = obj["runs"] ?? obj["results"];
    }
    if (!Array.isArray(data)) {
      throw new InputError(
        `${file}: JSON input must be a list of objects or an object with a runs/results list`,
      );
    }
    return runsFromRows(data, label, version);
  }
  return parseJUnit(text, label, version);
}

export function loadRuns(files: string[], version: string | null): RunRecord[] {
  const runs = files.flatMap((file) => loadFile(file, version));
  if (runs.length === 0) {
    const empty = files.flat();
    const named = empty.slice(0, 5).join(", ") + (empty.length > 5 ? `, +${empty.length - 5} more` : "");
    throw new InputError(
      `no usable test runs found in ${empty.length} file(s): ${named}. JUnit XML needs <testcase> ` +
        `elements; JSON/CSV needs 'test_id' and 'result' fields with recognizable pass/fail values.`,
    );
  }
  return runs;
}

/** The `version` stamped on ingested runs: CI env vars first, then git HEAD. */
export function detectCommit(): string | null {
  for (const key of ["GITHUB_SHA", "CI_COMMIT_SHA", "GIT_COMMIT"]) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    // A checkout is optional; no Git metadata means the run has no version.
    return null;
  }
}
