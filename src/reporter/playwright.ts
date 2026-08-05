/**
 * Playwright reporter that streams every attempt (including retries) into the
 * flaky-test-scorer history JSONL.
 *
 * Structural typing only — @playwright/test is never imported, at type level or
 * runtime, so installing this package pulls in no test-runner dependency.
 *
 *   // playwright.config.ts
 *   reporter: [["flaky-test-scorer/reporter/playwright", { history: ".flaky-history.jsonl" }]]
 */
import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { appendHistory, detectCommit, joinTestId, readHistory } from "../ingest.js";
import type { RunRecord } from "../score.js";

export interface FlakyReporterOptions {
  /** History JSONL to append to. Default `.flaky-history.jsonl`. */
  history?: string;
  /** Version/commit for these runs. Default: auto-detected (env, then git). */
  commit?: string;
}

// --- the slices of the Playwright API this reporter actually touches ---------

interface SuiteLike {
  title: string;
  type?: string;
  parent?: SuiteLike | undefined;
}

interface TestCaseLike {
  title: string;
  parent?: SuiteLike | undefined;
  location?: { file?: string } | undefined;
}

interface TestResultLike {
  status: string;
  retry?: number;
  duration?: number;
  startTime?: Date | string;
  error?: { message?: string } | undefined;
}

interface ConfigLike {
  rootDir?: string;
}

/** Repo-relative posix path — the same shape the Playwright JSON ingester records. */
const posixRel = (root: string, file: string): string =>
  relative(root, file).split("\\").join("/");

function ancestors(test: TestCaseLike): SuiteLike[] {
  const chain: SuiteLike[] = [];
  for (let suite = test.parent; suite; suite = suite.parent) chain.unshift(suite);
  return chain;
}

/**
 * `file > project? > title path` — identical to the ids the Playwright JSON
 * ingester produces (SPEC-V3 F2), so reporter history and imported JSON reports
 * describe the same test.
 */
export function playwrightTestId(test: TestCaseLike, rootDir: string): string {
  const chain = ancestors(test);
  const fileSuite = chain.find((s) => s.type === "file")?.title;
  const file = test.location?.file ? posixRel(rootDir, test.location.file) : fileSuite;
  return joinTestId([
    file,
    chain.find((s) => s.type === "project")?.title,
    ...chain.filter((s) => s.type === "describe").map((s) => s.title),
    test.title,
  ]);
}

export default class FlakyHistoryReporter {
  private readonly historyPath: string;
  private readonly commit: string | undefined;
  private rootDir = process.cwd();
  /** `attempt` is always recorded here; onEnd drops it again for un-retried tests. */
  private pending: (RunRecord & { attempt: number })[] = [];

  constructor(options: FlakyReporterOptions = {}) {
    this.historyPath = options.history ?? ".flaky-history.jsonl";
    this.commit = options.commit;
  }

  onBegin(config?: ConfigLike): void {
    if (config?.rootDir) this.rootDir = config.rootDir;
  }

  onTestEnd(test: TestCaseLike, result: TestResultLike): void {
    // skipped has no outcome; interrupted means the whole run was aborted —
    // scoring either as a failure would invent flakiness.
    if (result.status === "skipped" || result.status === "interrupted") return;
    const failed = result.status !== "passed";
    const startTime =
      result.startTime instanceof Date ? result.startTime.toISOString() : (result.startTime ?? null);
    const file = test.location?.file ? posixRel(this.rootDir, test.location.file) : null;

    this.pending.push({
      test_id: playwrightTestId(test, this.rootDir),
      result: !failed,
      version: null, // filled in at onEnd, where a single commit lookup covers the run
      timestamp: startTime,
      duration_s: typeof result.duration === "number" ? result.duration / 1000 : null,
      // Playwright error messages are full of ANSI colour, which wrecks clustering.
      failure_message: failed
        ? (result.error?.message ? stripVTControlCharacters(result.error.message).slice(0, 2000) : result.status)
        : null,
      source_file: file,
      attempt: typeof result.retry === "number" ? result.retry : 0,
    });
  }

  onEnd(): void {
    if (this.pending.length === 0) return;
    const version = this.commit ?? detectCommit();
    // `attempt` is what makes within_run_retries visible (SPEC-V3 F2/F5) — without
    // it a retry that flipped fail->pass is indistinguishable from two ordinary
    // runs. Dropped again for tests that never retried, so their history lines
    // keep the v1 record shape.
    const retried = new Set(
      this.pending.filter((run) => (run.attempt ?? 0) > 0).map((run) => run.test_id),
    );
    const runs = this.pending.map(({ attempt, ...run }) =>
      retried.has(run.test_id) ? { ...run, version, attempt } : { ...run, version },
    );
    this.pending = []; // a second onEnd must not re-append (Playwright merges reports)
    appendHistory(this.historyPath, readHistory(this.historyPath).runs, runs);
  }
}
