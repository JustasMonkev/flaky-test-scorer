import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { compareKeys, timestampKey, validExecutionId, type RunRecord } from "../score.js";
import { InputError, relPosix, stripBom, writeAtomic } from "./common.js";
import { CONSUMED_ROW_KEYS, runFromRow } from "./rows.js";

export interface HistoryRead {
  runs: RunRecord[];
  corruptLines: number;
}

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
      // SAFETY: runFromRow validates parsed JSON before the row is inspected below.
      const row = JSON.parse(line) as Record<string, unknown>;
      const run = runFromRow(row, null, null);
      if (!run) {
        corruptLines++;
        continue;
      }
      for (const key of Object.keys(row)) {
        if (!CONSUMED_ROW_KEYS.has(key)) {
          Object.defineProperty(run, key, {
            value: row[key],
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
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
  return file ? relPosix(file) : "";
}

function legacyRunKey(run: RunRecord): string {
  return JSON.stringify([
    run.test_id,
    run.version ?? "",
    String(run.timestamp ?? ""),
    sourceKey(run.source_file ?? null),
    run.result,
  ]);
}

function exactRunKey(run: RunRecord): string | null {
  return validExecutionId(run.execution_id)
    ? JSON.stringify([legacyRunKey(run), run.execution_id, run.attempt ?? ""])
    : null;
}

function sameRun(a: RunRecord, b: RunRecord): boolean {
  if (legacyRunKey(a) !== legacyRunKey(b)) return false;
  const aExact = exactRunKey(a);
  const bExact = exactRunKey(b);
  return aExact === null || bExact === null || aExact === bExact;
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
  return incoming.every((run, i) => sameRun(run, existing[offset + i]!)) ? [] : incoming;
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
    let fd: number;
    try {
      fd = openSync(path, "a+");
    } catch (err) {
      throw new InputError(`could not write ${path}: ${(err as Error).message}`);
    }
    try {
      // A history truncated by a killed process may not end in a newline; appending
      // straight onto it would fuse two records into one corrupt line. One byte is
      // enough to know — never re-read the whole file the caller just read.
      const size = fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) writeSync(fd, "\n");
      }
      for (const run of added) writeSync(fd, `${JSON.stringify(run)}\n`);
    } catch (err) {
      throw new InputError(`could not write ${path}: ${(err as Error).message}`);
    } finally {
      closeSync(fd);
    }
  }
  return [...existing, ...added];
}

/** Sort by timestamp key, ties broken by input order — the scorer's own comparator. */
const byTimestamp = (runs: RunRecord[]) =>
  runs
    .map((run, order) => ({ run, order, key: timestampKey(run.timestamp) }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.order - b.order);

export function chronological(runs: RunRecord[]): RunRecord[] {
  return byTimestamp(runs).map((d) => d.run);
}

/**
 * Merge sharded history files by run identity. Repeats within one shard remain;
 * matching ordinal occurrences uploaded by another shard are duplicates.
 */
export function mergeHistories(files: string[]): HistoryRead & { corruptFiles: string[] } {
  const runs: RunRecord[] = [];
  const anyBuckets = new Map<string, number[]>();
  const legacyBuckets = new Map<string, number[]>();
  const exactBuckets = new Map<string, number[]>();
  const legacyIndexes = new Set<number>();
  const corruptFiles: string[] = [];
  let corruptLines = 0;

  const addToBucket = (buckets: Map<string, number[]>, key: string, index: number) => {
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  };

  for (const file of files) {
    const read = readHistory(file);
    corruptLines += read.corruptLines;
    if (read.corruptLines > 0) corruptFiles.push(file);
    const used = new Set<number>();
    const cursors = new Map<string, number>();
    const take = (buckets: Map<string, number[]>, kind: string, key: string): number | null => {
      const bucket = buckets.get(key);
      if (!bucket) return null;
      const cursorKey = `${kind}:${key}`;
      let cursor = cursors.get(cursorKey) ?? bucket.length - 1;
      while (cursor >= 0) {
        const index = bucket[cursor--]!;
        if (used.has(index) || (kind === "legacy" && !legacyIndexes.has(index))) continue;
        cursors.set(cursorKey, cursor);
        used.add(index);
        return index;
      }
      cursors.set(cursorKey, cursor);
      return null;
    };

    const pending = read.runs.map((run, index) => ({
      run,
      index,
      legacyKey: legacyRunKey(run),
      exactKey: exactRunKey(run),
    }));
    const byLegacyKey = new Map<string, typeof pending>();
    for (const entry of pending) {
      const group = byLegacyKey.get(entry.legacyKey);
      if (group) group.push(entry);
      else byLegacyKey.set(entry.legacyKey, [entry]);
    }

    const matched = new Set<number>();
    for (const [legacyKey, group] of byLegacyKey) {
      for (const entry of group) {
        if (entry.exactKey && take(exactBuckets, "exact", entry.exactKey) !== null) {
          matched.add(entry.index);
        }
      }
      for (const entry of group) {
        if (!entry.exactKey || matched.has(entry.index)) continue;
        const index = take(legacyBuckets, "legacy", legacyKey);
        if (index === null) continue;
        const executionId = entry.run.execution_id;
        if (!validExecutionId(executionId)) continue;
        matched.add(entry.index);
        const upgraded: RunRecord = { ...runs[index]!, execution_id: executionId };
        if (entry.run.attempt === undefined) delete upgraded.attempt;
        else upgraded.attempt = entry.run.attempt;
        runs[index] = upgraded;
        legacyIndexes.delete(index);
        addToBucket(exactBuckets, entry.exactKey, index);
      }
      for (const entry of group) {
        if (entry.exactKey || matched.has(entry.index)) continue;
        if (
          take(legacyBuckets, "legacy", legacyKey) !== null ||
          take(anyBuckets, "any", legacyKey) !== null
        ) {
          matched.add(entry.index);
        }
      }
    }

    for (const entry of pending) {
      if (matched.has(entry.index)) continue;
      const index = runs.length;
      runs.push(entry.run);
      addToBucket(anyBuckets, entry.legacyKey, index);
      if (entry.exactKey) addToBucket(exactBuckets, entry.exactKey, index);
      else {
        addToBucket(legacyBuckets, entry.legacyKey, index);
        legacyIndexes.add(index);
      }
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
  let kept = byTimestamp(runs);

  if (options.keepDays !== undefined) {
    const cutoff = (now - options.keepDays * 86_400_000) / 1000;
    // ponytail: only ISO-like timestamps are age-comparable. Numeric, opaque and
    // missing ones are KEPT rather than guessed at — pruning must never silently
    // discard history. Upgrade path: teach timestampKey epoch-seconds detection.
    kept = kept.filter(({ key }) => key[0] !== 1 || key[1] >= cutoff);
  }

  if (options.keepRunsPerTest !== undefined) {
    const counts = new Map<string, number>();
    const keep = new Array<boolean>(kept.length).fill(false);
    for (let i = kept.length - 1; i >= 0; i--) {
      const testId = kept[i]!.run.test_id;
      const n = counts.get(testId) ?? 0;
      if (n < options.keepRunsPerTest) {
        keep[i] = true;
        counts.set(testId, n + 1);
      }
    }
    kept = kept.filter((_, i) => keep[i]!);
  }

  return kept.map((d) => d.run);
}
