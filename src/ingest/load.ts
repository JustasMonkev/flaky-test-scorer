import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { RunRecord } from "../score.js";
import { InputError, isRecord, relPosix, stripBom, warnCorrupt } from "./common.js";
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
    if (isRecord(data)) data = data["runs"] ?? data["results"];
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
  const perFile = files.map((file) => loadFile(file, version));
  const runs = perFile.flat();
  if (runs.length === 0) {
    const empty = files.filter((_, i) => perFile[i]!.length === 0);
    const named = empty.slice(0, 5).join(", ") + (empty.length > 5 ? `, +${empty.length - 5} more` : "");
    throw new InputError(
      `no usable test runs found in ${empty.length} file(s): ${named}. JUnit XML needs <testcase> ` +
        `elements; JSON/CSV needs 'test_id' and 'result' fields with recognizable pass/fail values.`,
    );
  }
  return runs;
}

export function detectCommit(): string | null {
  for (const key of ["GITHUB_SHA", "CI_COMMIT_SHA", "GIT_COMMIT"]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    // A checkout is optional; no Git metadata means the run has no version.
    return null;
  }
}
