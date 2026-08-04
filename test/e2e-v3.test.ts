import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MARKDOWN_MARKER, type Report } from "../src/report.js";

// SPEC-V3 end to end: every flow runs through the BUILT artifacts — `node
// dist/cli.js` for the CLI and `dist/reporter/playwright.js` for the reporter —
// so packaging mistakes (missing export, bad subpath, unbuilt module) fail here
// even when the in-process unit tests are green. Hermetic: temp dirs, no network.

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const fixtures = join(root, "test", "fixtures");
const suite = join(fixtures, "suite");
const PROMO = "checkout > applies promo code";
const INVENTORY = "checkout > syncs inventory";

let work: string;

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("run `npm run build` first (npm test does it via pretest)");
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "fts-e2e-v3-"));
});

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: work,
    // --commit is always passed explicitly below, but a stripped PATH keeps a
    // stray `git` on the machine from ever answering detectCommit().
    env: { ...process.env, PATH: "", GITHUB_SHA: "", CI_COMMIT_SHA: "", GIT_COMMIT: "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(args: string[]): Report & { baselined_breaches?: { test_id: string }[] } {
  const { status, stdout, stderr } = runCli([...args, "--json"]);
  expect(stderr).not.toContain("error:");
  expect(status).toBe(0);
  return JSON.parse(stdout) as Report;
}

const testIds = (report: Report) => report.tests.map((t) => t.test_id);
const find = (report: Report, id: string) => report.tests.find((t) => t.test_id === id);

// --------------------------------------------------------------- F1 baseline

describe("baseline update -> ci --baseline", () => {
  const baseline = () => join(work, "baseline.json");

  it("records today's flaky tests, then lets the same run through unchanged", () => {
    const update = runCli(["baseline", "update", suite, "--commit", "v1", "--baseline", baseline()]);
    expect(update.status).toBe(0);
    expect(JSON.parse(readFileSync(baseline(), "utf8"))).toEqual({
      schema_version: 1,
      tests: [
        { test_id: PROMO, lower_bound_score: 0.5 },
        { test_id: INVENTORY, lower_bound_score: 0.1667 },
      ],
    });

    const gate = runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.1", "--baseline", baseline()]);
    expect(gate.status).toBe(0);
    expect(gate.stderr).toContain("baselined (known flaky): 2 tests");
  });

  it("fails only on the test the baseline does not know about", () => {
    writeFileSync(
      baseline(),
      JSON.stringify({ schema_version: 1, tests: [{ test_id: INVENTORY, lower_bound_score: 0.1 }] }),
    );
    const gate = runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.1", "--baseline", baseline()]);
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain("1 test(s) above --fail-above 0.1");
    expect(gate.stderr).toContain(PROMO);
    // The known-flaky one is reported, not gated on.
    expect(gate.stderr).toContain("baselined (known flaky): 1 test");
  });

  it("reports the same breach set in --json under baselined_breaches", () => {
    writeFileSync(
      baseline(),
      JSON.stringify({ schema_version: 1, tests: [{ test_id: INVENTORY, lower_bound_score: 0.1 }] }),
    );
    const { status, stdout } = runCli([
      "ci", suite, "--commit", "v1", "--fail-above", "0.1", "--baseline", baseline(), "--json",
    ]);
    expect(status).toBe(1);
    const report = JSON.parse(stdout) as Report & { baselined_breaches: { test_id: string }[] };
    expect(report.schema_version).toBe(1);
    expect(report.baselined_breaches).toEqual([{ test_id: INVENTORY, lower_bound_score: 0.1667 }]);
  });

  it("reports a test that recovered since the baseline was taken", () => {
    writeFileSync(
      baseline(),
      JSON.stringify({
        schema_version: 1,
        tests: [
          { test_id: PROMO, lower_bound_score: 0.5 },
          { test_id: "checkout > long fixed", lower_bound_score: 0.9 },
        ],
      }),
    );
    const { stdout } = runCli(["ci", suite, "--commit", "v1", "--baseline", baseline(), "--format", "markdown"]);
    expect(stdout).toContain("| recovered since baseline | 1 |");
    expect(stdout).toContain("Recovered: `checkout > long fixed`");
  });
});

// -------------------------------------------------------------- F2 ingestion

describe("retry-aware ingestion", () => {
  it("scores Surefire reruns as within-run retries", () => {
    const report = json(["analyze", join(fixtures, "junit-surefire-rerun.xml"), "--commit", "v1"]);
    const flaky = find(report, "com.example.FlakyIT > flakyOne")!;
    // Two <flakyFailure> attempts then the passing testcase = 3 ordered runs.
    expect(flaky.total_runs).toBe(3);
    expect(flaky.score).toBeGreaterThan(0);
    expect(flaky.evidence.within_run_retries).toBe(1);
    expect(flaky.evidence.within_version_flips).toBe(1);
    // A test that failed every rerun is broken, not flaky.
    expect(find(report, "com.example.FlakyIT > alwaysFails")!.score).toBe(0);
    expect(find(report, "com.example.FlakyIT > alwaysFails")!.evidence.within_run_retries).toBe(0);
  });

  it("ingests a Playwright JSON report, one run per results[] attempt", () => {
    const report = json(["analyze", join(fixtures, "playwright-report.json"), "--commit", "v1"]);
    expect(testIds(report)).toEqual([
      "tests/checkout.spec.ts > chromium > checkout > applies promo code",
      "tests/login.spec.ts > firefox > logs in",
    ]);
    const retried = report.tests[0]!;
    expect(retried.total_runs).toBe(2);
    expect(retried.evidence.within_run_retries).toBe(1);
    expect(retried.likely_cause.category).toBe("timeout");
    // The skipped spec contributes nothing at all.
    expect(testIds(report).some((id) => id.includes("never runs"))).toBe(false);
  });
});

// -------------------------------------------------------- F3 history merge/prune

describe("sharded history: merge then prune", () => {
  const line = (test_id: string, pass: boolean, timestamp: string, version = "v1") =>
    JSON.stringify({
      test_id,
      result: pass ? "pass" : "fail",
      version,
      timestamp,
      duration_s: 1,
      failure_message: pass ? null : "Timeout of 30000ms exceeded",
      source_file: "shard.xml",
    });

  it("folds two shards into one deduped history the CLI can then score and prune", () => {
    const shardA = join(work, "shard-a.jsonl");
    const shardB = join(work, "shard-b.jsonl");
    const merged = join(work, "history.jsonl");
    const shared = line("t > shared", true, "2024-05-01T10:00:00");
    writeFileSync(shardA, [shared, line("t > a", false, "2024-05-01T11:00:00"), "{ not json"].join("\n") + "\n");
    writeFileSync(shardB, [shared, line("t > a", true, "2024-05-01T12:00:00")].join("\n") + "\n");

    const merge = runCli(["history", "merge", shardA, shardB, "--history", merged]);
    expect(merge.status).toBe(0);
    expect(merge.stderr).toContain("skipped 1 corrupt line(s)");
    // 4 lines in, one exact duplicate across shards collapsed, one corrupt dropped.
    const lines = readFileSync(merged, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).timestamp)).toEqual([
      "2024-05-01T10:00:00",
      "2024-05-01T11:00:00",
      "2024-05-01T12:00:00",
    ]);

    // A single gate over the merged file sees the cross-shard flip.
    const report = json(["analyze", merged, "--commit", "v1"]);
    expect(find(report, "t > a")!.score).toBeGreaterThan(0);

    const prune = runCli(["history", "prune", "--history", merged, "--keep-runs-per-test", "1"]);
    expect(prune.status).toBe(0);
    expect(prune.stdout).toContain("pruned 1 run(s); 2 remain");
    const kept = readFileSync(merged, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(kept.map((r) => [r.test_id, r.timestamp])).toEqual([
      ["t > shared", "2024-05-01T10:00:00"],
      ["t > a", "2024-05-01T12:00:00"],
    ]);
  });
});

// ------------------------------------------------------------------- F6 MCP

describe("mcp subcommand over real stdio", () => {
  it("completes initialize, lists three tools and answers a tools/call", async () => {
    const history = join(work, "history.jsonl");
    const rows: [string, boolean, string][] = [
      [PROMO, true, "2024-05-01T10:00:00"],
      [PROMO, false, "2024-05-01T11:00:00"],
      [PROMO, true, "2024-05-01T12:00:00"],
      ["checkout > renders cart", true, "2024-05-01T10:00:00"],
      ["checkout > renders cart", true, "2024-05-01T11:00:00"],
    ];
    writeFileSync(
      history,
      rows
        .map(([test_id, pass, timestamp]) =>
          JSON.stringify({
            test_id,
            result: pass ? "pass" : "fail",
            version: "v1",
            timestamp,
            duration_s: pass ? 0.4 : 30,
            failure_message: pass ? null : "Timeout of 30000ms exceeded waiting for #promo",
            source_file: "ci.xml",
          }),
        )
        .join("\n") + "\n",
    );

    const client = new Client({ name: "e2e", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      env: { PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    try {
      // connect() performs the initialize handshake; a stdout diagnostic anywhere
      // in the CLI would corrupt the stream and hang this line.
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("flaky-test-scorer");

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "analyze_history",
        "explain_test",
        "get_test_evidence",
      ]);

      const result = await client.callTool({
        name: "get_test_evidence",
        arguments: { history_path: history, test_id: PROMO },
      });
      const text = (result.content as { text: string }[])[0]!.text;
      const test = JSON.parse(text) as Report["tests"][number];
      expect(test.test_id).toBe(PROMO);
      expect(test.evidence.within_version_flips).toBe(1);

      const missing = await client.callTool({
        name: "get_test_evidence",
        arguments: { history_path: history, test_id: "nope" },
      });
      expect(missing.isError).toBe(true);

      // Regression: artifacts already folded into the history must not be counted
      // twice when both sources are passed — double-counting halves flipRate.
      const fixture = join(fixtures, "junit-surefire-rerun.xml");
      const overlap = join(work, "overlap.jsonl");
      expect(runCli(["analyze", fixture, "--history", overlap]).status).toBe(0);
      const both = await client.callTool({
        name: "analyze_history",
        arguments: { history_path: overlap, inputs: [fixture] },
      });
      const report = JSON.parse((both.content as { text: string }[])[0]!.text) as Report;
      expect(report.summary.runs).toBe(6); // 3 + 2 + 1 attempts, each counted once
      expect(find(report, "com.example.FlakyIT > flakyOne")!.score).toBe(0.5);
    } finally {
      await client.close();
    }
  }, 30_000);
});

// ------------------------------------------------------------- F7 markdown

describe("--format markdown", () => {
  // The action finds an existing comment by grepping for this exact string. If the
  // two ever drift, every push stacks a new comment instead of editing the old one,
  // and nothing else in the suite would notice.
  it("uses the same marker the action greps for", () => {
    expect(readFileSync(join(root, "action.yml"), "utf8")).toContain(MARKDOWN_MARKER);
    expect(MARKDOWN_MARKER).toBe("<!-- flaky-test-scorer -->");
  });

  it("puts the sticky-comment marker on the first line of a clean stdout", () => {
    const { status, stdout } = runCli(["ci", suite, "--commit", "v1", "--format", "markdown"]);
    expect(status).toBe(0);
    expect(stdout.split("\n")[0]).toBe("<!-- flaky-test-scorer -->");
    expect(stdout).toContain("| status | count |");
    expect(stdout).toContain("### Top offenders");
    expect(stdout).toContain(`| 1 | \`${PROMO}\` | 1.000 | 0.500 | very_flaky | timeout |`);
    // No baseline given: no status column on the offenders table, no recovered line.
    expect(stdout).toContain("| rank | test | score | lower bound | verdict | likely cause |\n");
    expect(stdout).not.toContain("likely cause | status |");
    expect(stdout).not.toContain("Recovered:");
  });

  it("is available on analyze too, and byte-identical there", () => {
    const ci = runCli(["ci", suite, "--commit", "v1", "--format", "markdown"]);
    const analyze = runCli(["analyze", suite, "--commit", "v1", "--format", "markdown"]);
    expect(analyze.status).toBe(0);
    expect(analyze.stdout).toBe(ci.stdout);
  });

  it("is deterministic across runs", () => {
    const a = runCli(["ci", suite, "--commit", "v1", "--format", "markdown"]);
    const b = runCli(["ci", suite, "--commit", "v1", "--format", "markdown"]);
    expect(a.stdout).toBe(b.stdout);
  });

  it("exits 2 when combined with --json instead of picking a winner", () => {
    const { status, stdout, stderr } = runCli(["ci", suite, "--commit", "v1", "--format", "markdown", "--json"]);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("mutually exclusive");
  });

  it("still rejects an unknown format and still keeps --format github on ci", () => {
    expect(runCli(["ci", suite, "--format", "teamcity"]).status).toBe(2);
    expect(runCli(["analyze", suite, "--format", "github"]).status).toBe(2);
    expect(runCli(["analyze", suite, "--format", "github"]).stderr).toContain('use "ci"');
  });

  // A PATH-only provider binary must stay ignored.
  it(
    "keeps Markdown output deterministic when a PATH-only provider is ignored",
    () => {
      const bin = join(work, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/sh\nprintf '## ${PROMO}\\nThe promo endpoint answers late.\\n'\n`,
      );
      chmodSync(join(bin, "claude"), 0o755);
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [cli, "ci", suite, "--commit", "v1", "--format", "markdown", "--explain"],
        {
          encoding: "utf8",
          cwd: work,
          // Only the fake binary is reachable, and no key may pre-empt it.
          env: { ...process.env, PATH: bin, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", OPENAI_API_KEY: "" },
        },
      );
      expect(status).toBe(0);
      expect(stdout.split("\n")[0]).toBe("<!-- flaky-test-scorer -->");
      expect(stderr).toContain("no AI provider configured");
      expect(stdout).not.toContain("<details>");
      expect(stdout).not.toContain("The promo endpoint answers late.");
    },
  );

  it("says No flaky tests detected when the suite is clean", () => {
    const clean = join(work, "clean.jsonl");
    writeFileSync(
      clean,
      [0, 1, 2]
        .map((i) =>
          JSON.stringify({ test_id: "t > ok", result: "pass", version: "v1", timestamp: `2024-05-0${i + 1}` }),
        )
        .join("\n") + "\n",
    );
    const { status, stdout } = runCli(["ci", clean, "--commit", "v1", "--format", "markdown"]);
    expect(status).toBe(0);
    expect(stdout).toContain("No flaky tests detected.");
    expect(stdout).not.toContain("### Top offenders");
  });
});

// ------------------------------------------------------- F5 reporter -> CLI

describe("playwright reporter feeds the CLI", () => {
  interface SuiteLike { title: string; type?: string; parent?: SuiteLike }
  const file: SuiteLike = { title: "tests/checkout.spec.ts", type: "file" };
  const describeSuite: SuiteLike = { title: "checkout", type: "describe", parent: file };
  const testCase = {
    title: "applies promo code",
    parent: describeSuite,
    location: { file: "/repo/tests/checkout.spec.ts" },
  };
  const attempt = (retry: number, status: string, error?: string) => ({
    status,
    retry,
    duration: status === "passed" ? 900 : 5001,
    startTime: new Date(Date.UTC(2024, 4, 1, 10, retry)),
    ...(error ? { error: { message: error } } : {}),
  });

  it("writes a history the built CLI scores as a within-run retry", async () => {
    const { default: FlakyHistoryReporter } = (await import(
      join(root, "dist", "reporter", "playwright.js")
    )) as { default: new (o: { history: string; commit?: string }) => any };

    const history = join(work, "history.jsonl");
    const reporter = new FlakyHistoryReporter({ history, commit: "v1" });
    reporter.onBegin({ rootDir: "/repo" });
    reporter.onTestEnd(testCase, attempt(0, "failed", "Timeout 5000ms exceeded waiting for #promo"));
    reporter.onTestEnd(testCase, attempt(1, "passed"));
    reporter.onEnd();

    const report = json(["analyze", history, "--commit", "v1"]);
    const [test] = report.tests;
    // Same id shape the Playwright JSON ingester produces, so both sources merge.
    expect(test!.test_id).toBe("tests/checkout.spec.ts > checkout > applies promo code");
    expect(test!.total_runs).toBe(2);
    expect(test!.score).toBe(1);
    expect(test!.likely_cause.category).toBe("timeout");

    // A second run appends genuinely new attempts without re-adding the old ones.
    const second = new FlakyHistoryReporter({ history, commit: "v2" });
    second.onBegin({ rootDir: "/repo" });
    second.onTestEnd(testCase, attempt(0, "passed"));
    second.onEnd();
    expect(readFileSync(history, "utf8").trim().split("\n")).toHaveLength(3);

    // Re-running the identical reporter pass is a no-op (dedup on run identity).
    const replay = new FlakyHistoryReporter({ history, commit: "v2" });
    replay.onBegin({ rootDir: "/repo" });
    replay.onTestEnd(testCase, attempt(0, "passed"));
    replay.onEnd();
    expect(readFileSync(history, "utf8").trim().split("\n")).toHaveLength(3);

    const merged = json(["analyze", history, "--commit", "v2"]);
    expect(merged.tests[0]!.num_versions).toBe(2);
  });
});
