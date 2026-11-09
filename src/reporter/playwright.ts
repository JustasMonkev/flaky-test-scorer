import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { appendHistory, detectCommit, joinTestId, readHistory } from "../ingest.js";
import { playwrightExecutionId } from "../ingest/playwright.js";
import type { RunRecord } from "../score.js";

export interface FlakyReporterOptions {
  /** History JSONL to append to. Default `.flaky-history.jsonl`. */
  history?: string;
  /** Version/commit for these runs. Default: auto-detected (env, then git). */
  commit?: string;
}

interface SuiteLike {
  title: string;
  type?: string;
  parent?: SuiteLike | undefined;
}

interface TestCaseLike {
  id?: string;
  repeatEachIndex?: number;
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

const posixRel = (root: string, file: string): string =>
  relative(root, file).replaceAll("\\", "/");

function ancestors(test: TestCaseLike): SuiteLike[] {
  const chain: SuiteLike[] = [];
  for (let suite = test.parent; suite; suite = suite.parent) chain.unshift(suite);
  return chain;
}

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
  private pending: (RunRecord & { attempt: number; case_id: string })[] = [];

  constructor(options: FlakyReporterOptions = {}) {
    this.historyPath = options.history ?? ".flaky-history.jsonl";
    this.commit = options.commit;
  }

  onBegin(config?: { rootDir?: string }): void {
    if (config?.rootDir) this.rootDir = config.rootDir;
  }

  onTestEnd(test: TestCaseLike, result: TestResultLike): void {
    if (result.status === "skipped" || result.status === "interrupted") return;
    const passed = result.status === "passed";
    const startTime =
      result.startTime instanceof Date ? result.startTime.toISOString() : (result.startTime ?? null);
    const file = test.location?.file ? posixRel(this.rootDir, test.location.file) : null;
    const testId = playwrightTestId(test, this.rootDir);
    const caseId = test.id ?? `${testId}:${test.repeatEachIndex ?? 0}`;

    this.pending.push({
      test_id: testId,
      result: passed,
      version: null,
      timestamp: startTime,
      duration_s: typeof result.duration === "number" ? result.duration / 1000 : null,
      failure_message: passed
        ? null
        : result.error?.message ? stripVTControlCharacters(result.error.message).slice(0, 2000) : result.status,
      source_file: file,
      attempt: typeof result.retry === "number" ? result.retry : 0,
      case_id: caseId,
    });
  }

  onEnd(): void {
    if (this.pending.length === 0) return;
    const version = this.commit ?? detectCommit();
    const chains = new Map<string, typeof this.pending>();
    for (const run of this.pending) {
      const chain = chains.get(run.case_id);
      if (chain) chain.push(run);
      else chains.set(run.case_id, [run]);
    }
    const ids = new Map(
      [...chains].map(([caseId, chain]) => [
        caseId,
        playwrightExecutionId([caseId, chain.map((run) => [run.attempt, run.timestamp, run.result])]),
      ]),
    );
    const runs = this.pending.map(({ case_id, ...run }) => ({
      ...run,
      version,
      execution_id: ids.get(case_id)!,
    }));
    this.pending = [];
    appendHistory(this.historyPath, readHistory(this.historyPath).runs, runs);
  }
}
