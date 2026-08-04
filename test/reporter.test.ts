import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEvidence, durationStats } from "../src/evidence.js";
import { readHistory } from "../src/ingest.js";
import { groupByTestAndVersion } from "../src/score.js";
import Reporter, { playwrightTestId } from "../src/reporter/playwright.js";

const rootDir = "/repo";
const historyIn = () => join(mkdtempSync(join(tmpdir(), "fts-rep-")), "history.jsonl");

// Structural stand-ins for Playwright's TestCase / TestResult / Suite.
function testCase(opts: { file: string; project?: string; describes?: string[]; title: string }) {
  let parent: any = { title: "", type: "root" };
  parent = { title: opts.project ?? "", type: "project", parent };
  parent = { title: opts.file, type: "file", parent };
  for (const d of opts.describes ?? []) parent = { title: d, type: "describe", parent };
  return { title: opts.title, parent, location: { file: join(rootDir, opts.file) } };
}

function result(opts: {
  status: string;
  retry?: number;
  duration?: number;
  startTime?: Date;
  error?: string;
}) {
  return {
    status: opts.status,
    retry: opts.retry ?? 0,
    duration: opts.duration ?? 100,
    startTime: opts.startTime ?? new Date("2024-01-01T00:00:00Z"),
    ...(opts.error === undefined ? {} : { error: { message: opts.error } }),
  };
}

const login = testCase({ file: "tests/login.spec.ts", project: "chromium", title: "logs in" });

beforeEach(() => {
  delete process.env["GITHUB_SHA"];
  delete process.env["CI_COMMIT_SHA"];
  process.env["GIT_COMMIT"] = "deadbeef";
});

describe("test_id", () => {
  it("is file > project > describe path > title (matches the Playwright JSON ingester)", () => {
    const test = testCase({
      file: "tests/login.spec.ts",
      project: "chromium",
      describes: ["auth", "oauth"],
      title: "logs in",
    });
    expect(playwrightTestId(test, rootDir)).toBe(
      "tests/login.spec.ts > chromium > auth > oauth > logs in",
    );
  });

  it("omits an empty project name", () => {
    const test = testCase({ file: "a.spec.ts", title: "works" });
    expect(playwrightTestId(test, rootDir)).toBe("a.spec.ts > works");
  });

  it("falls back to the file suite title when location is absent", () => {
    const test = testCase({ file: "tests/x.spec.ts", title: "t" }) as any;
    delete test.location;
    expect(playwrightTestId(test, rootDir)).toBe("tests/x.spec.ts > t");
  });
});

describe("onTestEnd / onEnd", () => {
  it("appends one history run per attempt, in retry order", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(
      login,
      result({ retry: 0, status: "failed", startTime: new Date("2024-01-01T00:00:01Z"), error: "boom" }),
    );
    reporter.onTestEnd(
      login,
      result({ retry: 1, status: "timedOut", startTime: new Date("2024-01-01T00:00:02Z"), error: "timeout" }),
    );
    reporter.onTestEnd(
      login,
      result({ retry: 2, status: "passed", startTime: new Date("2024-01-01T00:00:03Z") }),
    );
    reporter.onEnd();

    const { runs, corruptLines } = readHistory(path);
    expect(corruptLines).toBe(0);
    expect(runs.map((r) => r.result)).toEqual([false, false, true]);
    expect(runs.map((r) => r.timestamp)).toEqual([
      "2024-01-01T00:00:01.000Z",
      "2024-01-01T00:00:02.000Z",
      "2024-01-01T00:00:03.000Z",
    ]);
    expect(new Set(runs.map((r) => r.test_id))).toEqual(
      new Set(["tests/login.spec.ts > chromium > logs in"]),
    );
  });

  it("records duration in seconds, the source file, and the detected commit", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ status: "passed", duration: 2500 }));
    reporter.onEnd();

    const [run] = readHistory(path).runs;
    expect(run).toMatchObject({
      duration_s: 2.5,
      source_file: "tests/login.spec.ts",
      version: "deadbeef",
      failure_message: null,
    });
  });

  it("prefers an explicit commit option over detection", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path, commit: "abc123" });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ status: "passed" }));
    reporter.onEnd();
    expect(readHistory(path).runs[0]?.version).toBe("abc123");
  });

  it("strips ANSI colour from failure messages", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ status: "failed", error: "\u001b[31mexpected 1\u001b[39m" }));
    reporter.onEnd();
    expect(readHistory(path).runs[0]?.failure_message).toBe("expected 1");
  });

  it("falls back to the status when a failure carries no error object", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ status: "timedOut" }));
    reporter.onEnd();
    expect(readHistory(path).runs[0]?.failure_message).toBe("timedOut");
  });

  it("drops skipped and interrupted attempts", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ status: "skipped" }));
    reporter.onTestEnd(login, result({ status: "interrupted" }));
    reporter.onEnd();
    expect(readHistory(path).runs).toEqual([]);
  });

  it("writes nothing when no attempts were collected", () => {
    const path = historyIn();
    new Reporter({ history: path }).onEnd();
    expect(readHistory(path).runs).toEqual([]);
  });

  it("does not duplicate runs when onEnd fires twice", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ status: "failed", error: "boom" }));
    reporter.onTestEnd(login, result({ retry: 1, status: "passed" }));
    reporter.onEnd();
    reporter.onEnd();
    expect(readHistory(path).runs).toHaveLength(2);
  });

  it("appends to an existing history without dropping earlier runs", () => {
    const path = historyIn();
    for (const [i, status] of ["failed", "passed"].entries()) {
      const reporter = new Reporter({ history: path });
      reporter.onBegin({ rootDir });
      reporter.onTestEnd(login, result({ status, startTime: new Date(`2024-01-0${i + 1}T00:00:00Z`) }));
      reporter.onEnd();
    }
    expect(readHistory(path).runs.map((r) => r.result)).toEqual([false, true]);
  });

  it("defaults rootDir to cwd when onBegin never ran", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path });
    reporter.onTestEnd(
      { title: "t", parent: { title: "s.spec.ts", type: "file" }, location: { file: join(process.cwd(), "s.spec.ts") } },
      result({ status: "passed" }),
    );
    reporter.onEnd();
    expect(readHistory(path).runs[0]?.test_id).toBe("s.spec.ts > t");
  });
});

describe("retry attempts (SPEC-V3 F2/F5)", () => {
  it("records attempt indices so a retry flip shows up as within_run_retries", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path, commit: "c1" });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ retry: 0, status: "failed", startTime: new Date("2024-01-01T00:00:01Z"), error: "boom" }));
    reporter.onTestEnd(login, result({ retry: 1, status: "passed", startTime: new Date("2024-01-01T00:00:02Z") }));
    reporter.onEnd();

    const { runs } = readHistory(path);
    expect(runs.map((r) => r.attempt)).toEqual([0, 1]);

    const { evidence } = buildEvidence(
      runs[0]!.test_id,
      groupByTestAndVersion(runs).get(runs[0]!.test_id)!,
      durationStats(groupByTestAndVersion(runs)),
    );
    expect(evidence.within_run_retries).toBe(1);
  });

  it("omits attempt for a test that never retried, keeping the v1 record shape", () => {
    const path = historyIn();
    const reporter = new Reporter({ history: path, commit: "c1" });
    reporter.onBegin({ rootDir });
    reporter.onTestEnd(login, result({ retry: 0, status: "passed" }));
    reporter.onEnd();
    expect(readFileSync(path, "utf8")).not.toContain("attempt");
  });
});
