import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { timestampKey, type RunRecord } from "../score.js";
import { InputError, stripBom, writeAtomic } from "./common.js";
import { runsFromRows } from "./rows.js";

export interface HistoryRead {
  runs: RunRecord[];
  corruptLines: number;
}

/**
 * Every key `runsFromRows` consumes. Anything else on a history line is a field
 * this version does not know about (`ci_job`, `branch`, a future column) and must
 * survive a merge/prune rewrite untouched.
 */
const KNOWN_ROW_KEYS = new Set([
  "test_id", "test", "name", "testId", "id",
  "result", "status", "outcome",
  "version",
  "timestamp", "time", "date",
  "duration_s", "duration", "elapsed",
  "failure_message", "message", "error",
  "source_file", "attempt",
]);

/**
 * Read a JSONL history file. Corrupt lines are counted and skipped, never fatal.
 * Unknown fields are carried through verbatim so `history merge` / `history prune`
 * (which rewrite the whole file) do not silently drop columns this version does
 * not model. A line with no `source_file` keeps that absence rather than
 * inheriting the history file's own path, which would change its dedup identity.
 */
export function readHistory(path: string): HistoryRead {
  if (!existsSync(path)) return { runs: [], corruptLines: 0 };
  let text: string;
  try {
    text = stripBom(readFileSync(path, "utf8"));
  } catch (err) {
    throw new InputError(`cannot read history file ${path}: ${(err as Error).message}`);
  }
  const runs: RunRecord[] = [];
  let corruptLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const [run] = runsFromRows(
        [row],
        typeof row["source_file"] === "string" ? row["source_file"] : path,
        null,
      );
      if (!run) {
        corruptLines++;
        continue;
      }
      if (typeof row["source_file"] !== "string") run.source_file = null;
      for (const key of Object.keys(row)) {
        if (!KNOWN_ROW_KEYS.has(key)) (run as unknown as Record<string, unknown>)[key] = row[key];
      }
      runs.push(run);
    } catch {
      corruptLines++;
    }
  }
  return { runs, corruptLines };
}

/**
 * `source_file` is compared relative to cwd, never as the absolute path stored in
 * the record. Self-hosted runners (`_work/1` vs `_work/2`), container workdirs and
 * a developer running against a cached history all give the same artifact a
 * different absolute path, and every one of those double-counted the run.
 */
function sourceKey(file: string | null): string {
  if (!file) return "";
  return relative(process.cwd(), resolve(file)).split(sep).join("/");
}

function runKey(run: RunRecord): string {
  return JSON.stringify([
    run.test_id,
    run.version ?? "",
    String(run.timestamp ?? ""),
    sourceKey(run.source_file ?? null),
    run.result,
  ]);
}

/**
 * The runs in `incoming` that `existing` does not already contain. Split out of
 * appendHistory so read-only callers (the MCP server, which never writes a
 * history back) get the same dedup rule instead of double-counting overlaps.
 * The artifact is atomic: only a whole-sequence suffix match is a duplicate.
 */
export function dedupAgainst(existing: RunRecord[], incoming: RunRecord[]): RunRecord[] {
  if (incoming.length === 0 || incoming.length > existing.length) return incoming;
  const offset = existing.length - incoming.length;
  return incoming.every((run, i) => runKey(run) === runKey(existing[offset + i]!)) ? [] : incoming;
}

/**
 * Append runs not already in history; returns the full merged history.
 *
 * Each record is one O_APPEND write, so a second `analyze --history <same file>`
 * running concurrently (the per-suite CI pattern) interleaves whole lines instead
 * of splitting one record across another's. That keeps the file parseable; it does
 * NOT make concurrent writers correct — each still dedups against the snapshot it
 * read, so overlapping artifacts can be appended twice. One history file, one writer.
 */
export function appendHistory(path: string, existing: RunRecord[], incoming: RunRecord[]): RunRecord[] {
  const added = dedupAgainst(existing, incoming);
  if (added.length > 0) {
    // A history truncated by a killed process may not end in a newline; appending
    // straight onto it would fuse two records into one corrupt line.
    const tail = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const lead = tail.length > 0 && tail.at(-1) !== 0x0a ? "\n" : "";
    let fd: number;
    try {
      fd = openSync(path, "a");
    } catch (err) {
      throw new InputError(`could not write ${path}: ${(err as Error).message}`);
    }
    try {
      if (lead) writeSync(fd, lead);
      for (const run of added) writeSync(fd, `${JSON.stringify(run)}\n`);
    } catch (err) {
      throw new InputError(`could not write ${path}: ${(err as Error).message}`);
    } finally {
      closeSync(fd);
    }
  }
  return [...existing, ...added];
}

/** Sort by timestamp key, ties broken by input order — same ordering the scorer uses. */
export function chronological(runs: RunRecord[]): RunRecord[] {
  return runs
    .map((run, order) => ({ run, order, key: timestampKey(run.timestamp) }))
    .sort(
      (a, b) =>
        a.key[0] - b.key[0] ||
        a.key[1] - b.key[1] ||
        (a.key[2] < b.key[2] ? -1 : a.key[2] > b.key[2] ? 1 : 0) ||
        a.order - b.order,
    )
    .map((d) => d.run);
}

/**
 * Merge sharded history files by run identity. Repeats within one shard remain;
 * matching ordinal occurrences uploaded by another shard are duplicates.
 */
export function mergeHistories(files: string[]): HistoryRead & { corruptFiles: string[] } {
  const seen = new Set<string>();
  const runs: RunRecord[] = [];
  const corruptFiles: string[] = [];
  let corruptLines = 0;
  for (const file of files) {
    const read = readHistory(file);
    corruptLines += read.corruptLines;
    if (read.corruptLines > 0) corruptFiles.push(file);
    const occurrences = new Map<string, number>();
    for (const run of read.runs) {
      const key = runKey(run);
      const n = occurrences.get(key) ?? 0;
      occurrences.set(key, n + 1);
      const identity = key + " " + n;
      if (seen.has(identity)) continue;
      seen.add(identity);
      runs.push(run);
    }
  }
  return { runs: chronological(runs), corruptLines, corruptFiles };
}

export function writeHistory(path: string, runs: RunRecord[]): void {
  writeAtomic(path, runs.map((run) => `${JSON.stringify(run)}\n`).join(""));
}

export interface PruneOptions {
  keepDays?: number;
  keepRunsPerTest?: number;
}

/** Both options together intersect: a run must survive every filter given. */
export function pruneRuns(runs: RunRecord[], options: PruneOptions, now = Date.now()): RunRecord[] {
  let kept = chronological(runs);

  if (options.keepDays !== undefined) {
    const cutoff = (now - options.keepDays * 86_400_000) / 1000;
    // ponytail: only ISO-like timestamps are age-comparable. Numeric, opaque and
    // missing ones are KEPT rather than guessed at — pruning must never silently
    // discard history. Upgrade path: teach timestampKey epoch-seconds detection.
    kept = kept.filter((run) => {
      const key = timestampKey(run.timestamp);
      return key[0] !== 1 || key[1] >= cutoff;
    });
  }

  if (options.keepRunsPerTest !== undefined) {
    const counts = new Map<string, number>();
    const keep = new Array<boolean>(kept.length).fill(false);
    for (let i = kept.length - 1; i >= 0; i--) {
      const testId = kept[i]!.test_id;
      const n = counts.get(testId) ?? 0;
      if (n < options.keepRunsPerTest) {
        keep[i] = true;
        counts.set(testId, n + 1);
      }
    }
    kept = kept.filter((_, i) => keep[i]!);
  }

  return kept;
}
