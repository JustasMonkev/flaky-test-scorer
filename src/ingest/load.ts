import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type { RunRecord } from "../score.js";
import { InputError, stripBom } from "./common.js";
import { readHistory } from "./history.js";
import { parseJUnit } from "./junit.js";
import { isPlaywrightReport, parsePlaywrightReport } from "./playwright.js";
import { parseCsv, runsFromRows } from "./rows.js";

export function loadFile(file: string, version: string | null): RunRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new InputError(`cannot read ${file}: ${(err as Error).message}`);
  }

  // `source_file` is stored relative to cwd, never as the absolute path the input
  // expansion resolved. History files are cached and shared between machines, so an
  // absolute path leaks the local layout, churns the diff, and — because it is part
  // of the dedup identity — made the same artifact from `_work/1` and `_work/2`
  // count twice. The Playwright reporter already records repo-relative paths.
  const label = relative(process.cwd(), file).split(sep).join("/") || file;
  const lower = file.toLowerCase();
  if (lower.endsWith(".csv")) return runsFromRows(parseCsv(text), label, version);
  // .jsonl is this tool's own history format: line-delimited, so never a single JSON doc.
  // Directory expansion picks these up, and JSON.parse on one always failed with exit 2.
  if (lower.endsWith(".jsonl")) {
    const { runs, corruptLines } = readHistory(file);
    // SPEC.md: corrupt lines are skipped with a stderr warning. Only the --history
    // path used to warn, so `analyze .flaky-history.jsonl` scored a truncated file
    // silently — the exact recipe the Playwright reporter's README hands out.
    if (corruptLines > 0) {
      process.stderr.write(`warning: skipped ${corruptLines} corrupt line(s) in ${file}\n`);
    }
    return runs;
  }
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

/** The `version` stamped on ingested runs: CI env vars first, then git HEAD. */
export function detectCommit(): string | null {
  for (const key of ["GITHUB_SHA", "CI_COMMIT_SHA", "GIT_COMMIT"]) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
