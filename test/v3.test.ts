import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEvidence, durationStats } from "../src/evidence.js";
import {
  InputError,
  loadFile,
  mergeHistories,
  pruneRuns,
  readBaseline,
  readHistory,
  writeBaseline,
  writeHistory,
} from "../src/ingest.js";
import { buildReport, renderGithub, renderHuman, renderMarkdown } from "../src/report.js";
import { groupByTestAndVersion, type RunRecord } from "../src/score.js";

// SPEC-V3 F1-F4. Hermetic: temp dirs only, no network, no real PATH lookups.

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const fixtures = join(root, "test", "fixtures");
const suite = join(fixtures, "suite");
const tmp = () => mkdtempSync(join(tmpdir(), "fts-v3-"));

function runCli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  test_id: "t",
  result: true,
  version: "v1",
  timestamp: null,
  duration_s: null,
  failure_message: null,
  source_file: "f.xml",
  ...over,
});

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("run `npm run build` first (npm test does it via pretest)");
});

// ------------------------------------------------------------------ F2 ingestion

describe("F2: Surefire retry ingestion", () => {
  const file = join(fixtures, "junit-surefire-rerun.xml");

  it("emits each flakyFailure as its own attempt, ending in the final outcome", () => {
    const runs = loadFile(file, "abc123").filter((r) => r.test_id.endsWith("flakyOne"));
    expect(runs.map((r) => r.result)).toEqual([false, false, true]);
    expect(runs.map((r) => r.attempt)).toEqual([0, 1, 2]);
    // Every attempt shares the version/timestamp, so within_version_flips sees them.
    expect(new Set(runs.map((r) => r.version))).toEqual(new Set(["abc123"]));
    expect(new Set(runs.map((r) => r.timestamp))).toEqual(new Set(["2024-05-01T10:00:00"]));
  });

  it("keeps the testcase duration on the final attempt only", () => {
    const runs = loadFile(file, null).filter((r) => r.test_id.endsWith("flakyOne"));
    expect(runs.map((r) => r.duration_s)).toEqual([null, null, 1.5]);
  });

  it("treats rerunFailure as extra failed attempts of a still-failing test", () => {
    const runs = loadFile(file, null).filter((r) => r.test_id.endsWith("alwaysFails"));
    expect(runs.map((r) => r.result)).toEqual([false, false]);
    expect(runs.map((r) => r.attempt)).toEqual([0, 1]);
  });

  it("leaves attempt absent on plain single-attempt testcases", () => {
    const [stable] = loadFile(file, null).filter((r) => r.test_id.endsWith("stable"));
    expect(stable!.result).toBe(true);
    expect(stable).not.toHaveProperty("attempt");
  });

  it("carries each retry message into the failure clusters", () => {
    const runs = loadFile(file, "abc123").filter((r) => r.test_id.endsWith("flakyOne"));
    const grouped = groupByTestAndVersion(runs);
    const testId = runs[0]!.test_id;
    const { evidence, likely_cause } = buildEvidence(
      testId,
      grouped.get(testId)!,
      durationStats(grouped),
    );
    expect(evidence.failure_clusters.reduce((n, c) => n + c.count, 0)).toBe(2);
    expect(likely_cause.category).toBe("timeout");
    expect(likely_cause.matched_messages).toBe(2);
  });
});

describe("F2: Playwright JSON report ingestion", () => {
  const file = join(fixtures, "playwright-report.json");

  it("detects the report by shape and builds file > project > titles ids", () => {
    const runs = loadFile(file, "abc123");
    expect(runs.map((r) => r.test_id)).toEqual([
      "tests/checkout.spec.ts > chromium > checkout > applies promo code",
      "tests/checkout.spec.ts > chromium > checkout > applies promo code",
      "tests/login.spec.ts > firefox > logs in",
    ]);
  });

  it("turns every results[] entry into one attempt, in order, and drops skipped", () => {
    const runs = loadFile(file, null);
    expect(runs.map((r) => r.result)).toEqual([false, true, true]);
    expect(runs.map((r) => r.attempt)).toEqual([0, 1, undefined]);
    expect(runs[0]!.duration_s).toBe(5.001);
    expect(runs[0]!.failure_message).toContain("Timeout 5000ms exceeded");
    expect(runs[0]!.timestamp).toBe("2024-05-01T10:00:00.000Z");
    expect(runs[1]!.failure_message).toBe(null);
  });

  it("does not mistake a plain runs list for a Playwright report", () => {
    const dir = tmp();
    const plain = join(dir, "rows.json");
    writeFileSync(plain, JSON.stringify([{ test_id: "a", result: "pass" }]));
    expect(loadFile(plain, null).map((r) => r.test_id)).toEqual(["a"]);
  });
});

describe("F2: within_run_retries evidence", () => {
  const evidenceFor = (runs: RunRecord[]) => {
    const grouped = groupByTestAndVersion(runs);
    return buildEvidence(runs[0]!.test_id, grouped.get(runs[0]!.test_id)!, durationStats(grouped))
      .evidence;
  };

  it("counts an execution whose attempts disagreed", () => {
    expect(
      evidenceFor([
        run({ result: false, attempt: 0 }),
        run({ result: true, attempt: 1 }),
      ]).within_run_retries,
    ).toBe(1);
  });

  it("does not count retries that all failed", () => {
    expect(
      evidenceFor([
        run({ result: false, attempt: 0 }),
        run({ result: false, attempt: 1 }),
      ]).within_run_retries,
    ).toBe(0);
  });

  it("counts two separate retried executions in the same version", () => {
    expect(
      evidenceFor([
        run({ result: false, attempt: 0 }),
        run({ result: true, attempt: 1 }),
        run({ result: false, attempt: 0 }),
        run({ result: true, attempt: 1 }),
      ]).within_run_retries,
    ).toBe(2);
  });

  it("is zero for history without attempt indexes", () => {
    expect(
      evidenceFor([run({ result: false }), run({ result: true })]).within_run_retries,
    ).toBe(0);
  });

  it("renders as an evidence bullet and lands in --json", () => {
    const report = buildReport(
      groupByTestAndVersion([run({ result: false, attempt: 0 }), run({ result: true, attempt: 1 })]),
      { metric: "flipRate", model: "weighted", lam: 0.1, minReruns: 2 },
    );
    expect(report.tests[0]!.evidence.within_run_retries).toBe(1);
    expect(renderHuman(report, 10, 1)).toContain("passed only on retry in 1 run");
  });

  it("surfaces Surefire reruns end to end through the CLI --json report", () => {
    const out = runCli(["analyze", join(fixtures, "junit-surefire-rerun.xml"), "--json"]);
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as ReturnType<typeof buildReport>;
    const flaky = report.tests.find((t) => t.test_id.endsWith("flakyOne"))!;
    expect(flaky.evidence.within_run_retries).toBe(1);
    expect(flaky.evidence.within_version_flips).toBe(1);
    expect(report.schema_version).toBe(1);
  });
});

// ------------------------------------------------------------------- F1 baseline

describe("F1: baseline update", () => {
  it("writes a sorted, timestamp-free file of only the flaky tests", () => {
    const dir = tmp();
    const path = join(dir, "baseline.json");
    const out = runCli(["baseline", "update", suite, "--baseline", path, "--commit", "v1"]);
    expect(out.status).toBe(0);

    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      schema_version: number;
      tests: { test_id: string; lower_bound_score: number }[];
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.tests.length).toBeGreaterThan(0);
    expect(parsed.tests.every((t) => t.lower_bound_score > 0)).toBe(true);
    expect(parsed.tests.map((t) => t.test_id)).toEqual([...parsed.tests.map((t) => t.test_id)].sort());
    expect(raw).not.toMatch(/timestamp|generated|\d{4}-\d{2}-\d{2}T/);
    // Deterministic: a second run must produce a byte-identical file (git diffs).
    runCli(["baseline", "update", suite, "--baseline", path, "--commit", "v1"]);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(out.stdout).toContain("known-flaky test(s)");
  });

  it("leaves no temp file behind (atomic write)", () => {
    const dir = tmp();
    runCli(["baseline", "update", suite, "--baseline", join(dir, "b.json")]);
    expect(readdirSync(dir)).toEqual(["b.json"]);
  });

  it("rejects a bad scoring flag with exit 2", () => {
    const out = runCli(["baseline", "update", suite, "--metric", "nope"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("--metric");
  });
});

describe("F1: readBaseline / writeBaseline", () => {
  it("treats a missing file as an empty baseline", () => {
    expect(readBaseline(join(tmp(), "absent.json"))).toEqual(new Set());
  });

  it("rejects a corrupt baseline as an input error", () => {
    const path = join(tmp(), "b.json");
    writeFileSync(path, "{ not json");
    expect(() => readBaseline(path)).toThrow(InputError);
  });

  it("rejects a baseline without a tests list", () => {
    const path = join(tmp(), "b.json");
    writeFileSync(path, JSON.stringify({ schema_version: 1 }));
    expect(() => readBaseline(path)).toThrow(/tests/);
  });

  it("round-trips ids and drops non-flaky entries", () => {
    const path = join(tmp(), "b.json");
    writeBaseline(path, [
      { test_id: "b", lower_bound_score: 0.4 },
      { test_id: "a", lower_bound_score: 0 },
    ]);
    expect(readBaseline(path)).toEqual(new Set(["b"]));
  });
});

describe("F1: ci --baseline gating", () => {
  const baselineAll = (dir: string) => {
    const path = join(dir, "baseline.json");
    expect(runCli(["baseline", "update", suite, "--baseline", path, "--commit", "v1"]).status).toBe(0);
    return path;
  };

  it("exits 0 when every breaching test is already baselined", () => {
    const path = baselineAll(tmp());
    const out = runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.01", "--baseline", path]);
    expect(out.status).toBe(0);
    expect(out.stderr).toMatch(/baselined \(known flaky\): \d+ tests/);
    expect(out.stderr).not.toContain("above --fail-above");
  });

  it("exits 1 for a test that is not in the baseline", () => {
    const dir = tmp();
    const path = join(dir, "baseline.json");
    writeFileSync(path, JSON.stringify({ schema_version: 1, tests: [] }));
    const out = runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.01", "--baseline", path]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("above --fail-above");
  });

  it("treats a missing baseline file as empty rather than an error", () => {
    const out = runCli([
      "ci",
      suite,
      "--commit",
      "v1",
      "--fail-above",
      "0.01",
      "--baseline",
      join(tmp(), "never-written.json"),
    ]);
    expect(out.status).toBe(1);
    expect(out.stderr).not.toMatch(/error:/);
  });

  it("adds baselined_breaches to --json without bumping schema_version", () => {
    const path = baselineAll(tmp());
    const out = runCli([
      "ci",
      suite,
      "--commit",
      "v1",
      "--fail-above",
      "0.01",
      "--baseline",
      path,
      "--json",
    ]);
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as {
      schema_version: number;
      baselined_breaches: { test_id: string; lower_bound_score: number }[];
    };
    expect(report.schema_version).toBe(1);
    expect(report.baselined_breaches.length).toBeGreaterThan(0);
    expect(report.baselined_breaches[0]!.lower_bound_score).toBeGreaterThan(0.01);
  });

  it("omits baselined_breaches entirely when no --baseline is given", () => {
    const out = runCli(["ci", suite, "--commit", "v1", "--json"]);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).not.toHaveProperty("baselined_breaches");
  });

  it("is rejected on analyze with exit 2", () => {
    const out = runCli(["analyze", suite, "--baseline", "b.json"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('use "ci" instead of "analyze"');
  });
});

describe("F1: baseline-aware rendering", () => {
  const report = buildReport(
    groupByTestAndVersion([
      run({ test_id: "known", result: false }),
      run({ test_id: "known", result: true }),
      run({ test_id: "fresh", result: false }),
      run({ test_id: "fresh", result: true }),
    ]),
    { metric: "flipRate", model: "weighted", lam: 0.1, minReruns: 2 },
  );
  const baseline = new Set(["known"]);

  it("labels newly flaky and baselined rows separately in human output", () => {
    const text = renderHuman(report, 10, 1, baseline);
    expect(text).toContain("1 newly flaky, 1 baselined (known flaky).");
    // M11: `/known\b/` alone was already satisfied by the "1 baselined (known
    // flaky)." header line, so the baselined row could vanish and this still passed.
    expect(text).toMatch(/^ {4}known$/m);
    expect(text).toContain("[BASELINED]");
    expect(text).toContain("[NEW]");
  });

  it("leaves human output untouched without a baseline", () => {
    const text = renderHuman(report, 10, 1);
    expect(text).not.toContain("[BASELINED]");
    expect(text).not.toContain("newly flaky");
  });

  it("demotes baselined annotations to ::notice and adds a status column", () => {
    const { annotations, markdown } = renderGithub(report, baseline);
    expect(annotations.filter((a) => a.startsWith("::notice"))).toHaveLength(1);
    expect(annotations.filter((a) => a.startsWith("::warning"))).toHaveLength(1);
    expect(annotations.find((a) => a.startsWith("::notice"))).toContain("(baselined)");
    expect(markdown).toContain("| status |");
    expect(markdown).toContain("baselined |");
    expect(markdown).toContain("1 newly flaky, 1 baselined (known flaky).");
  });

  it("keeps the v1 github output shape without a baseline", () => {
    const { annotations, markdown } = renderGithub(report);
    expect(annotations.every((a) => a.startsWith("::warning"))).toBe(true);
    expect(markdown).not.toContain("| status |");
  });
});

// ------------------------------------------------------------- F3 history ops

describe("F3: history merge", () => {
  const writeShard = (dir: string, name: string, runs: RunRecord[]) => {
    const path = join(dir, name);
    writeFileSync(path, runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return path;
  };

  it("dedups the same run across shards but keeps genuine repeats within one", () => {
    const dir = tmp();
    const a = run({ test_id: "a", timestamp: "2024-01-01T00:00:00" });
    const shard1 = writeShard(dir, "s1.jsonl", [a, a]);
    const shard2 = writeShard(dir, "s2.jsonl", [a]);
    const { runs, corruptLines } = mergeHistories([shard1, shard2]);
    expect(runs).toHaveLength(2);
    expect(corruptLines).toBe(0);
  });

  it("dedups matching run identities across reordered shards", () => {
    const dir = tmp();
    const pass = run({ test_id: "a", result: true, timestamp: null });
    const fail = run({ test_id: "a", result: false, timestamp: null });
    const first = writeShard(dir, "s1.jsonl", [pass, fail]);
    const second = writeShard(dir, "s2.jsonl", [fail, pass]);

    const expected = [true, false];
    expect(mergeHistories([first, second]).runs.map((r) => r.result)).toEqual(expected);
    expect(mergeHistories([first, second, second]).runs.map((r) => r.result)).toEqual(expected);
  });

  it("orders the merged history by timestamp, ties by input order", () => {
    const dir = tmp();
    const late = writeShard(dir, "late.jsonl", [
      run({ test_id: "late", timestamp: "2024-03-01T00:00:00" }),
    ]);
    const early = writeShard(dir, "early.jsonl", [
      run({ test_id: "early", timestamp: "2024-01-01T00:00:00" }),
    ]);
    expect(mergeHistories([late, early]).runs.map((r) => r.test_id)).toEqual(["early", "late"]);
  });

  it("counts corrupt lines instead of crashing", () => {
    const dir = tmp();
    const path = join(dir, "s.jsonl");
    writeFileSync(path, `${JSON.stringify(run())}\nnot json\n`);
    const { runs, corruptLines } = mergeHistories([path]);
    expect(runs).toHaveLength(1);
    expect(corruptLines).toBe(1);
  });

  it("merges through the CLI, writes atomically and leaves no tmp file", () => {
    const dir = tmp();
    const shard1 = writeShard(dir, "s1.jsonl", [run({ test_id: "a", timestamp: 1 })]);
    const shard2 = writeShard(dir, "s2.jsonl", [run({ test_id: "b", timestamp: 2 })]);
    const out = join(dir, "merged.jsonl");
    const result = runCli(["history", "merge", shard1, shard2, "--history", out]);
    expect(result.status).toBe(0);
    expect(readHistory(out).runs.map((r) => r.test_id)).toEqual(["a", "b"]);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(result.stdout).toContain("merged 2 run(s)");
  });

  it("exits 2 without --history", () => {
    const dir = tmp();
    const shard = writeShard(dir, "s.jsonl", [run()]);
    const result = runCli(["history", "merge", shard]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--history");
  });

  it("exits 2 when an input file does not exist", () => {
    const result = runCli(["history", "merge", join(tmp(), "nope.jsonl"), "--history", "out.jsonl"]);
    expect(result.status).toBe(2);
  });
});

describe("F3: history prune", () => {
  const day = 86_400_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("keeps only the newest n runs per test", () => {
    const runs = [
      run({ test_id: "a", timestamp: 1 }),
      run({ test_id: "a", timestamp: 2 }),
      run({ test_id: "a", timestamp: 3 }),
      run({ test_id: "b", timestamp: 1 }),
    ];
    // Output stays chronological (b@1 sorts with a@1), and a's oldest run is dropped.
    expect(pruneRuns(runs, { keepRunsPerTest: 2 }).map((r) => [r.test_id, r.timestamp])).toEqual([
      ["b", 1],
      ["a", 2],
      ["a", 3],
    ]);
  });

  it("drops runs older than --keep-days", () => {
    const runs = [
      run({ test_id: "old", timestamp: iso(10 * day) }),
      run({ test_id: "new", timestamp: iso(1 * day) }),
    ];
    expect(pruneRuns(runs, { keepDays: 7 }).map((r) => r.test_id)).toEqual(["new"]);
  });

  it("keeps runs whose timestamp cannot be aged, rather than losing them", () => {
    const runs = [run({ test_id: "opaque", timestamp: null })];
    expect(pruneRuns(runs, { keepDays: 1 })).toHaveLength(1);
  });

  it("intersects both filters when given together", () => {
    const runs = [
      run({ test_id: "a", timestamp: iso(10 * day) }),
      run({ test_id: "a", timestamp: iso(3 * day) }),
      run({ test_id: "a", timestamp: iso(2 * day) }),
    ];
    // keep-days alone leaves 2, keep-runs-per-test alone leaves 1 -> intersection is 1.
    expect(pruneRuns(runs, { keepDays: 7, keepRunsPerTest: 1 })).toHaveLength(1);
  });

  it("rewrites the history file in place through the CLI", () => {
    const dir = tmp();
    const path = join(dir, "history.jsonl");
    writeHistory(path, [
      run({ test_id: "a", timestamp: 1 }),
      run({ test_id: "a", timestamp: 2 }),
      run({ test_id: "a", timestamp: 3 }),
    ]);
    const result = runCli(["history", "prune", "--history", path, "--keep-runs-per-test", "1"]);
    expect(result.status).toBe(0);
    expect(readHistory(path).runs).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(["history.jsonl"]);
    expect(result.stdout).toContain("pruned 2 run(s)");
  });

  it("exits 2 when neither keep flag is given", () => {
    const path = join(tmp(), "history.jsonl");
    writeHistory(path, [run()]);
    const result = runCli(["history", "prune", "--history", path]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--keep-days");
    expect(readHistory(path).runs).toHaveLength(1); // untouched
  });

  it("exits 2 without --history", () => {
    expect(runCli(["history", "prune", "--keep-days", "7"]).status).toBe(2);
  });

  it("exits 2 on a non-numeric keep value", () => {
    const path = join(tmp(), "history.jsonl");
    writeHistory(path, [run()]);
    expect(runCli(["history", "prune", "--history", path, "--keep-days", "soon"]).status).toBe(2);
  });
});

// --------------------------------------- test-name injection into CI surfaces

describe("hostile test names", () => {
  /** Ingests a real JUnit file so the report is built from sanitized ids, as in production. */
  const reportFor = (name: string) => {
    const file = join(tmp(), "evil.xml");
    writeFileSync(
      file,
      `<testsuites>` +
        `<testsuite name="s" timestamp="2024-01-01T00:00:00"><testcase classname="c" name="${name}"><failure message="timeout waiting">x</failure></testcase></testsuite>` +
        `<testsuite name="s" timestamp="2024-01-01T00:01:00"><testcase classname="c" name="${name}"/></testsuite>` +
        `</testsuites>`,
    );
    return buildReport(groupByTestAndVersion(loadFile(file, "v1")), {
      metric: "flipRate",
      model: "weighted",
      lam: 0.1,
      minReruns: 1,
    });
  };

  // E13: the runner percent-decodes annotation text, so a literal `%0A` in a test
  // name arrived as a real newline inside the annotation the markdown path escaped.
  it("percent-escapes an encoded newline in a ::warning annotation", () => {
    const { annotations } = renderGithub(reportFor("a%0A::error title=pwn::injected"));
    expect(annotations[0]).toContain("a%250A");
    expect(annotations[0]).not.toContain("a%0A");
  });

  it("collapses a newline in a JUnit name so it cannot forge a ::error annotation", () => {
    const report = reportFor("a\n::error title=pwn::injected");
    expect(report.tests[0]!.test_id).toBe("c > a ::error title=pwn::injected");

    const { annotations, markdown } = renderGithub(report);
    // Every ::-prefixed line the runner sees must be one this tool wrote.
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.split("\n")).toHaveLength(1);
    expect(markdown.split("\n").some((l) => l.startsWith("::"))).toBe(false);
    expect(renderHuman(report, 10, 1).split("\n").some((l) => l.startsWith("::"))).toBe(false);
  });

  it("renders pipes and backticks in a test id inertly inside the markdown table", () => {
    const body = renderMarkdown(reportFor("a | b `tick` &lt;img src=x&gt;"), 10);
    const row = body.split("\n").find((l) => l.startsWith("| 1 |"))!;
    // 6 columns => 7 unescaped pipes => 8 parts; an id pipe would add a ninth.
    expect(row.split(/(?<!\\)\|/)).toHaveLength(8);
    // Fenced one backtick longer than the run inside it, so the span cannot close early.
    expect(row).toContain("`` c > a \\| b `tick` <img src=x> ``");
  });

  it("escapes the recovered list the same way", () => {
    const body = renderMarkdown(reportFor("plain"), 10, new Set(["gone | away"]));
    expect(body).toContain("Recovered: `gone \\| away`");
  });
});
