import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InputError,
  appendHistory,
  dedupAgainst,
  expandInputs,
  loadFile,
  loadRuns,
  normalizeResult,
  parseCsv,
  parseJUnit,
  readHistory,
  runsFromRows,
} from "../src/ingest.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "fts-"));

describe("result normalization", () => {
  it("accepts the documented pass/fail vocabularies, case-insensitively", () => {
    for (const v of ["pass", "PASSED", " p ", "ok", "success", "true", "1", "green"]) {
      expect(normalizeResult(v)).toBe(true);
    }
    for (const v of ["fail", "FAILED", "f", "error", "failure", "false", "0", "red"]) {
      expect(normalizeResult(v)).toBe(false);
    }
  });
  it("returns null for unknown, empty and missing values", () => {
    expect(normalizeResult("skipped")).toBe(null);
    expect(normalizeResult("")).toBe(null);
    expect(normalizeResult(null)).toBe(null);
    expect(normalizeResult(undefined)).toBe(null);
  });
});

describe("JUnit XML parsing", () => {
  const runs = loadFile(join(fixtures, "junit-nested.xml"), "sha1");

  it("walks nested testsuites and drops skipped cases", () => {
    // A suite's own cases are emitted before its nested suites' cases.
    expect(runs.map((r) => r.test_id)).toEqual([
      "no classname",
      "pkg.Outer > bare failure",
      "pkg.Inner > deep pass",
      "pkg.Inner > deep error",
    ]);
  });

  it("treats <failure> and <error> as failures and keeps the message", () => {
    expect(runs.map((r) => r.result)).toEqual([true, false, true, false]);
    expect(runs[3]!.failure_message).toContain("ECONNREFUSED");
    expect(runs[1]!.failure_message).toBe("failure"); // <failure/> with no text
  });

  it("tolerates a BOM, missing attributes and empty suites", () => {
    expect(runs[0]!.test_id).toBe("no classname");
    expect(runs[0]!.duration_s).toBe(null);
    expect(runs[2]!.duration_s).toBe(0.1);
  });

  it("stamps version, timestamp and source file onto every run", () => {
    expect(runs.every((r) => r.version === "sha1")).toBe(true);
    expect(runs[0]!.timestamp).toBe("2024-05-01T09:00:00");
    expect(runs[0]!.source_file).toContain("junit-nested.xml");
  });

  it("rejects malformed XML with a message naming the file", () => {
    const file = join(fixtures, "junit-malformed.xml");
    expect(() => loadFile(file, null)).toThrow(InputError);
    expect(() => loadFile(file, null)).toThrow(/junit-malformed\.xml/);
  });

  it("reports zero usable runs rather than scoring nothing", () => {
    expect(() => loadRuns([join(fixtures, "junit-empty-ok.xml")], null)).toThrow();
  });

  // Regression: the message counted files but never said which one was empty.
  it("names the files that produced no runs", () => {
    expect(() => loadRuns([join(fixtures, "junit-empty-ok.xml")], null)).toThrow(
      /junit-empty-ok\.xml/,
    );
  });

  // Regression: a <testcase> hanging directly off <testsuites> was silently dropped.
  it("ingests a testcase with no <testsuite> wrapper", () => {
    const parsed = parseJUnit(
      '<testsuites timestamp="2024-05-01T09:00:00"><testcase classname="C" name="loose"/></testsuites>',
      "inline.xml",
      null,
    );
    expect(parsed.map((r) => [r.test_id, r.result, r.timestamp])).toEqual([
      ["C > loose", true, "2024-05-01T09:00:00"],
    ]);
  });

  // Regression: status="failed" with no <failure> child was recorded as a pass.
  it("honours a status attribute when no failure element is present", () => {
    const parsed = parseJUnit(
      '<testsuite name="s">' +
        '<testcase name="a" status="failed"/>' +
        '<testcase name="b" status="error"/>' +
        '<testcase name="c" status="passed"/>' +
        '<testcase name="d" status="run"/>' +
        "</testsuite>",
      "inline.xml",
      null,
    );
    expect(parsed.map((r) => r.result)).toEqual([false, false, true, true]);
    expect(parsed[0]!.failure_message).toBe("failure");
  });

  it("handles a bare <testsuite> root", () => {
    const parsed = parseJUnit(
      '<testsuite name="s"><testcase classname="C" name="t"/></testsuite>',
      "inline.xml",
      null,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.test_id).toBe("C > t");
  });
});

describe("CSV ingestion", () => {
  const runs = loadFile(join(fixtures, "runs.csv"), "ignored");

  it("resolves field aliases and drops unrecognized outcomes", () => {
    expect(runs.map((r) => r.test_id)).toEqual([
      "login_flow",
      "login_flow",
      "login_flow",
      "stable_test",
      "stable_test",
      'weird, quoted "test"',
    ]);
    expect(runs.map((r) => r.result)).toEqual([true, false, true, true, true, true]);
  });

  it("reads version, timestamp and duration aliases", () => {
    expect(runs[0]!.version).toBe("abc123");
    expect(runs[0]!.timestamp).toBe("2024-05-01T10:00:00Z");
    expect(runs[1]!.duration_s).toBe(9.4);
  });

  it("parses quoted fields with embedded commas and escaped quotes", () => {
    expect(parseCsv('a,b\n"x,y","he said ""hi"""\n')).toEqual([
      { a: "x,y", b: 'he said "hi"' },
    ]);
  });

  it("survives CRLF and blank trailing lines", () => {
    expect(parseCsv("test_id,result\r\nt1,pass\r\n\r\n")).toEqual([
      { test_id: "t1", result: "pass" },
    ]);
  });
});

describe("JSON ingestion", () => {
  const runs = loadFile(join(fixtures, "runs.json"), null);

  it("unwraps a runs/results envelope and applies aliases", () => {
    expect(runs.map((r) => r.test_id)).toEqual(["api.search", "api.search", "api.search", "0"]);
  });

  it("keeps falsy-but-real values like the test literally named 0", () => {
    expect(runs[3]!.test_id).toBe("0");
    expect(runs[3]!.result).toBe(false);
  });

  it("drops rows without a usable result", () => {
    expect(runs).toHaveLength(4); // the "no result field" row is skipped
  });

  it("drops JSON and CSV rows whose cleaned test id is empty", () => {
    expect(runsFromRows([{ test_id: "\u200b", result: "pass" }], "runs.json", null)).toEqual([]);
    expect(runsFromRows(parseCsv("test_id,result\n\u200b,pass\n"), "runs.csv", null)).toEqual([]);
  });

  it("rejects JSON that is not a run list", () => {
    const dir = tmp();
    const file = join(dir, "bad.json");
    writeFileSync(file, '{"nope": 1}');
    expect(() => loadFile(file, null)).toThrow(/must be a list of objects/);
    writeFileSync(file, "{not json");
    expect(() => loadFile(file, null)).toThrow(/malformed JSON/);
  });

  it("uses the fallback version only when the row has none", () => {
    const rows = runsFromRows(
      [
        { test_id: "a", result: "pass" },
        { test_id: "b", result: "pass", version: "row-version" },
      ],
      "f.json",
      "cli-version",
    );
    expect(rows.map((r) => r.version)).toEqual(["cli-version", "row-version"]);
  });

  it("normalizes non-scalar optional fields from JSON rows", () => {
    const [run] = runsFromRows(
      [
        {
          test_id: "a",
          result: "fail",
          timestamp: { invalid: true },
          failure_message: { invalid: true },
          source_file: 42,
        },
      ],
      "runs.json",
      null,
    );
    expect(run).toMatchObject({
      timestamp: null,
      failure_message: null,
      source_file: "runs.json",
    });
  });
});

describe("input expansion", () => {
  it("expands a directory into its test artifacts", () => {
    const files = expandInputs([join(fixtures, "suite")]);
    expect(files).toHaveLength(4);
    expect(files[0]).toMatch(/run-1\.xml$/);
  });

  it("expands ** globs relative to the cwd", () => {
    const files = expandInputs(["test/fixtures/suite/*.xml"], process.cwd());
    expect(files).toHaveLength(4);
  });

  // Regression: plain sort() put run-10 before run-2, and file order is the
  // chronological fallback for JUnit without suite timestamps, so flipRate shifted.
  it("orders numbered files naturally, not lexicographically", () => {
    const dir = tmp();
    for (const n of [1, 2, 3, 10, 11]) writeFileSync(join(dir, `run-${n}.xml`), "<testsuite/>");
    expect(expandInputs([dir]).map((f) => f.slice(dir.length + 1))).toEqual([
      "run-1.xml",
      "run-2.xml",
      "run-3.xml",
      "run-10.xml",
      "run-11.xml",
    ]);
  });

  it("fails loudly on a missing path", () => {
    expect(() => expandInputs(["./does-not-exist.xml"])).toThrow(InputError);
    expect(() => expandInputs(["test/fixtures/nope/*.xml"])).toThrow(/no input files matched/);
  });
});

describe("history JSONL", () => {
  it("round-trips runs and counts corrupt lines without crashing", () => {
    const file = join(tmp(), "history.jsonl");
    writeFileSync(
      file,
      [
        '{"test_id":"a","result":"pass","version":"v1","timestamp":1,"custom":"kept-on-disk"}',
        "{ this is not json",
        "",
        '{"test_id":"a","result":"fail","version":"v1","timestamp":2}',
        '{"result":"pass"}',
      ].join("\n"),
    );
    const { runs, corruptLines } = readHistory(file);
    expect(runs.map((r) => r.result)).toEqual([true, false]);
    expect(corruptLines).toBe(2); // the broken line and the one missing test_id
  });

  // Regression: .jsonl went down the JSON.parse path, so a history file sitting in a
  // scanned directory (the action writes one there) made the whole run exit 2.
  it("is ingestable as a plain input file, not just via --history", () => {
    const file = join(tmp(), "history.jsonl");
    writeFileSync(
      file,
      '{"test_id":"a","result":"pass","version":"v1"}\n{"test_id":"a","result":"fail","version":"v1"}\n',
    );
    expect(loadFile(file, "ignored").map((r) => r.result)).toEqual([true, false]);
  });

  // Regression: appending onto a history truncated mid-line (killed process) fused
  // the partial record and the new one into a single corrupt line.
  it("appends safely to a history that does not end in a newline", () => {
    const file = join(tmp(), "history.jsonl");
    writeFileSync(file, '{"test_id":"a","result":"pass","version":"v1"}'); // no trailing \n
    const existing = readHistory(file).runs;
    appendHistory(file, existing, [
      {
        test_id: "a",
        result: false,
        version: "v1",
        timestamp: null,
        duration_s: null,
        failure_message: "boom",
        source_file: "junit.xml",
      },
    ]);
    const { runs, corruptLines } = readHistory(file);
    expect(runs.map((r) => r.result)).toEqual([true, false]);
    expect(corruptLines).toBe(0);
  });

  it("returns empty for a history file that does not exist yet", () => {
    expect(readHistory(join(tmp(), "absent.jsonl"))).toEqual({ runs: [], corruptLines: 0 });
  });

  it("appends new runs and dedups re-ingested artifacts", () => {
    const file = join(tmp(), "history.jsonl");
    const incoming = loadRuns(expandInputs([join(fixtures, "suite")]), "v1");

    const first = appendHistory(file, readHistory(file).runs, incoming);
    expect(first).toHaveLength(12);

    // Re-ingesting the same artifacts must not double-count.
    const second = appendHistory(file, readHistory(file).runs, incoming);
    expect(second).toHaveLength(12);
    expect(readHistory(file).runs).toHaveLength(12);

    // A genuinely new run does get appended.
    const third = appendHistory(file, readHistory(file).runs, [
      { ...incoming[0]!, timestamp: "2024-06-01T10:00:00", source_file: "run-5.xml" },
    ]);
    expect(third).toHaveLength(13);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(13);
  });

  // Regression: a rerun of the same artifact that flipped pass->fail survives
  // while a true re-upload still dedups.
  it("treats a flipped outcome at the same path/version/timestamp as a new run", () => {
    const file = join(tmp(), "history.jsonl");
    const passed = {
      test_id: "A > t",
      result: true,
      version: "SAME",
      timestamp: null,
      duration_s: 1,
      failure_message: null,
      source_file: "junit.xml",
    };
    const failed = { ...passed, result: false, failure_message: "boom" };

    expect(appendHistory(file, readHistory(file).runs, [passed])).toHaveLength(1);
    expect(appendHistory(file, readHistory(file).runs, [failed])).toHaveLength(2);
    expect(appendHistory(file, readHistory(file).runs, [failed])).toHaveLength(2);
    expect(readHistory(file).runs.map((r) => r.result)).toEqual([true, false]);
  });

  it("keeps an undated pass after a failure but dedups its reingestion", () => {
    const file = join(tmp(), "history.jsonl");
    const passed = {
      test_id: "A > t",
      result: true,
      version: "SAME",
      timestamp: null,
      duration_s: 1,
      failure_message: null,
      source_file: "junit.xml",
    };
    const failed = { ...passed, result: false, failure_message: "boom" };

    for (const run of [passed, failed, passed]) {
      appendHistory(file, readHistory(file).runs, [run]);
    }
    expect(readHistory(file).runs.map((r) => r.result)).toEqual([true, false, true]);

    appendHistory(file, readHistory(file).runs, [passed]);
    expect(readHistory(file).runs.map((r) => r.result)).toEqual([true, false, true]);
  });

  it("appends every row when a multi-row artifact only partially matches the suffix", () => {
    const run = (result: boolean) => ({
      test_id: "A > t",
      result,
      version: "SAME",
      timestamp: null,
      duration_s: null,
      failure_message: result ? null : "boom",
      source_file: "junit.xml",
    });
    const existing = [run(true), run(false)];
    const incoming = [run(false), run(true)];

    expect(dedupAgainst(existing, incoming).map((r) => r.result)).toEqual([false, true]);
    expect(dedupAgainst([...existing, ...incoming], incoming)).toEqual([]);
  });

  it("treats a mixed-test artifact as one ordered unit", () => {
    const run = (test_id: string, result: boolean) => ({
      test_id,
      result,
      version: "SAME",
      timestamp: null,
      duration_s: null,
      failure_message: null,
      source_file: "junit.xml",
    });
    const existing = [run("a", true), run("b", false)];
    const changed = [run("a", true), run("b", true)];
    const reordered = [run("b", false), run("a", true)];

    expect(dedupAgainst(existing, changed)).toEqual(changed);
    expect(dedupAgainst(existing, reordered)).toEqual(reordered);
    expect(dedupAgainst([...existing, ...changed], changed)).toEqual([]);
  });

  it("retains repeated rows in an initial multi-row artifact", () => {
    const run = {
      test_id: "A > t",
      result: true,
      version: "SAME",
      timestamp: null,
      duration_s: null,
      failure_message: null,
      source_file: "junit.xml",
    };
    expect(dedupAgainst([], [run, run])).toHaveLength(2);
  });

  it("normalizes invalid optional fields in history before deduplication", () => {
    const file = join(tmp(), "history.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        test_id: "a",
        result: "fail",
        timestamp: {},
        failure_message: {},
        source_file: {},
      })}\n`,
    );
    const { runs } = readHistory(file);
    expect(runs[0]).toMatchObject({ timestamp: null, failure_message: null, source_file: null });
    expect(dedupAgainst(runs, runs)).toEqual([]);
  });
});
