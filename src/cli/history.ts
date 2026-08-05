import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  InputError,
  expandInputs,
  mergeHistories,
  pruneRuns,
  readHistory,
  warnCorrupt,
  writeHistory,
} from "../ingest.js";
import { timestampKey } from "../score.js";
import { numberOption, requireHistory } from "./options.js";

export function runHistoryMerge(inputs: string[], values: { history?: string }): number {
  const out = requireHistory(values.history, "history merge");
  const files = expandInputs(inputs);
  // The destination is an input, not just a target. `writeHistory` rewrites it
  // wholesale, so merging a shard into an accumulated history (the actions/cache
  // pattern) used to replace months of runs with one shard — and a merge that
  // yielded nothing truncated the file to empty while exiting 0.
  const existing = existsSync(out) && !files.includes(resolvePath(out)) ? [resolvePath(out)] : [];
  const { runs, corruptLines, corruptFiles } = mergeHistories([...existing, ...files]);
  warnCorrupt(corruptLines, corruptFiles.join(", "));
  if (runs.length === 0) {
    throw new InputError(
      `history merge produced 0 runs from ${files.length} file(s); refusing to overwrite ${out}. ` +
        `Inputs must be JSONL history files (the format \`--history\` writes), not JUnit XML.`,
    );
  }
  writeHistory(out, runs);
  process.stdout.write(
    `merged ${runs.length} run(s) from ${files.length + existing.length} file(s) into ${out}\n`,
  );
  return 0;
}

export function runHistoryPrune(values: {
  history?: string;
  keepDays?: string;
  keepRunsPerTest?: string;
}): number {
  const path = requireHistory(values.history, "history prune");
  if (values.keepDays === undefined && values.keepRunsPerTest === undefined) {
    throw new InputError("history prune needs --keep-days <n> or --keep-runs-per-test <n>");
  }
  const options: { keepDays?: number; keepRunsPerTest?: number } = {};
  if (values.keepDays !== undefined) {
    options.keepDays = numberOption(values.keepDays, "keep-days", 0);
    if (options.keepDays < 0) throw new InputError("--keep-days must be >= 0");
  }
  if (values.keepRunsPerTest !== undefined) {
    options.keepRunsPerTest = numberOption(values.keepRunsPerTest, "keep-runs-per-test", 0);
    if (options.keepRunsPerTest < 1) throw new InputError("--keep-runs-per-test must be >= 1");
  }

  const { runs, corruptLines } = readHistory(path);
  warnCorrupt(corruptLines, path);
  const kept = pruneRuns(runs, options);
  writeHistory(path, kept);
  process.stdout.write(`pruned ${runs.length - kept.length} run(s); ${kept.length} remain in ${path}\n`);
  // JUnit <testsuite> elements often carry no timestamp, and an undated run is
  // never age-comparable, so it survives every --keep-days forever. Saying so
  // beats "pruned 0 run(s)" with no explanation.
  if (options.keepDays !== undefined) {
    const undated = kept.filter((run) => timestampKey(run.timestamp)[0] !== 1).length;
    if (undated > 0) {
      process.stderr.write(
        `note: ${undated} kept run(s) have no comparable timestamp and are never pruned by --keep-days\n`,
      );
    }
  }
  return 0;
}
