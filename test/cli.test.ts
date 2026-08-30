import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Report } from "../src/report.js";

// Provider flows run end-to-end against real seams in test/e2e.test.ts; nothing is
// mocked here. run() is only imported in-process for the one case a child process
// cannot express: an interactive (TTY) stdin.

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const suite = join(root, "test", "fixtures", "suite");
const tmp = () => mkdtempSync(join(tmpdir(), "fts-cli-"));

function runCli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("run `npm run build` first (npm test does it via pretest)");
});

describe("analyze", () => {
  const { status, stdout } = runCli(["analyze", suite, "--commit", "v1", "--json"]);
  const report = JSON.parse(stdout) as Report;

  it("exits 0 and emits the documented schema", () => {
    expect(status).toBe(0);
    expect(report.schema_version).toBe(2);
    expect(report.params).toEqual({ metric: "flipRate", model: "weighted", lam: 0.1, min_reruns: 2 });
    expect(report.summary).toEqual({ tests: 3, runs: 12, flaky: 2, very_flaky: 1, low_data: 0 });
  });

  it("ranks the alternating test first with the pinned scores", () => {
    expect(report.tests.map((t) => [t.rank, t.test_id, t.score, t.gating_score])).toEqual([
      [1, "checkout > applies promo code", 1, 0.5],
      [2, "checkout > syncs inventory", 0.3333, 0.1667],
      [3, "checkout > renders cart", 0, 0],
    ]);
    expect(report.tests[0]!.verdict).toBe("very_flaky");
    expect(report.tests[1]!.verdict).toBe("flaky");
    expect(report.tests[2]!.verdict).toBe("not_flaky");
  });

  it("attaches evidence, likely cause and a recommendation to every test", () => {
    const top = report.tests[0]!;
    expect(top.evidence.transitions).toEqual({ flips: 3, total_runs: 4 });
    expect(top.evidence.within_version_flips).toBe(1);
    expect(top.evidence.duration_variance!.ratio).toBeGreaterThan(2);
    expect(top.evidence.failure_clusters[0]!.count).toBe(2);
    expect(top.likely_cause).toMatchObject({ category: "timeout", heuristic: true });
    expect(top.recommendation).toBeTypeOf("string");
  });

  it("honours --metric and --model", () => {
    const entropyReport = JSON.parse(
      runCli(["analyze", suite, "--commit", "v1", "--json", "--metric", "entropy", "--model", "unweighted"]).stdout,
    ) as Report;
    expect(entropyReport.params.metric).toBe("entropy");
    expect(entropyReport.tests[0]!.score).toBe(1);
    expect(entropyReport.tests.find((t) => t.test_id === "checkout > syncs inventory")!.score).toBe(1);
  });

  it("prints a human report with evidence bullets by default", () => {
    const human = runCli(["analyze", suite, "--commit", "v1"]).stdout;
    expect(human).toContain("Analyzed 12 runs across 3 tests from 4 files.");
    expect(human).toContain("#1  very_flaky  score 1.000");
    expect(human).toContain("fails on unchanged commit in 1 version");
    expect(human).toContain("likely cause: timeout");
    expect(human).not.toContain("renders cart"); // not flaky, so not listed
  });

  it("limits the human list with --top", () => {
    const human = runCli(["analyze", suite, "--commit", "v1", "--top", "1"]).stdout;
    expect(human).toContain("applies promo code");
    expect(human).not.toContain("syncs inventory");
  });

  // Regression: --top 0 claimed "No flaky tests detected." one line under
  // "2 show flakiness", and --top -1 quietly dropped the last row.
  it("never contradicts the summary when --top hides the list", () => {
    const human = runCli(["analyze", suite, "--commit", "v1", "--top", "0"]).stdout;
    expect(human).toContain("2 tests show flakiness");
    expect(human).not.toContain("No flaky tests detected.");
    expect(runCli(["analyze", suite, "--commit", "v1", "--top=-1"]).stdout).not.toContain("#1");
  });
});

describe("history", () => {
  it("appends, dedups and scores over the full history", () => {
    const history = join(tmp(), "history.jsonl");
    const first = JSON.parse(
      runCli(["analyze", join(suite, "run-1.xml"), "--commit", "v1", "--history", history, "--json"]).stdout,
    ) as Report;
    expect(first.summary.runs).toBe(3);

    const second = JSON.parse(
      runCli(["analyze", join(suite, "run-2.xml"), "--commit", "v1", "--history", history, "--json"]).stdout,
    ) as Report;
    expect(second.summary.runs).toBe(6);
    expect(second.tests[0]!.test_id).toBe("checkout > applies promo code");

    // Re-ingesting run-2 must not grow the history.
    const third = JSON.parse(
      runCli(["analyze", join(suite, "run-2.xml"), "--commit", "v1", "--history", history, "--json"]).stdout,
    ) as Report;
    expect(third.summary.runs).toBe(6);
    expect(readFileSync(history, "utf8").trim().split("\n")).toHaveLength(6);
  });

  // Regression: dedup used to key on (test_id, version, timestamp, source_file) only.
  // In the shipped action.yml flow — same commit, same artifact path, no suite
  // timestamp — a rerun that flipped pass->fail was indistinguishable from a
  // re-upload and got discarded, so within_version_flips could never fire.
  it("keeps a rerun that flipped outcome on the same commit and artifact path", () => {
    const dir = tmp();
    const history = join(dir, "history.jsonl");
    const artifact = join(dir, "junit.xml");
    const xml = (body: string) =>
      `<?xml version="1.0"?><testsuite name="s"><testcase classname="A" name="t" time="1">${body}</testcase></testsuite>`;

    writeFileSync(artifact, xml(""));
    runCli(["analyze", artifact, "--commit", "SAME", "--history", history, "--json"]);

    writeFileSync(artifact, xml('<failure message="Timeout of 5000ms exceeded">x</failure>'));
    const report = JSON.parse(
      runCli(["analyze", artifact, "--commit", "SAME", "--history", history, "--json"]).stdout,
    ) as Report;

    expect(report.summary.runs).toBe(2);
    expect(report.tests[0]!.evidence.within_version_flips).toBe(1);
    expect(report.tests[0]!.score).toBe(1);

    // A third ingest of the identical failing artifact is still deduped.
    const again = JSON.parse(
      runCli(["analyze", artifact, "--commit", "SAME", "--history", history, "--json"]).stdout,
    ) as Report;
    expect(again.summary.runs).toBe(2);
  });
});

describe("ci", () => {
  it("exits 1 when a gating_score exceeds --fail-above", () => {
    const { status, stderr } = runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.4"]);
    expect(status).toBe(1);
    expect(stderr).toContain("applies promo code");
  });

  it("exits 0 when the threshold is above every gating score", () => {
    expect(runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.9"]).status).toBe(0);
  });

  it("uses the gating score, not the raw score", () => {
    // raw score is 1.0, gating score is 0.5 -> a 0.6 threshold must not fail.
    expect(runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.6"]).status).toBe(0);
  });

  it("emits ::warning annotations and a job summary with --format github", () => {
    const summaryFile = join(tmp(), "summary.md");
    const { stdout } = runCli(
      ["ci", suite, "--commit", "v1", "--format", "github", "--fail-above", "0.9"],
      { GITHUB_STEP_SUMMARY: summaryFile },
    );
    expect(stdout).toContain("::warning title=Flaky test::checkout > applies promo code");
    const summary = readFileSync(summaryFile, "utf8");
    expect(summary).toContain("## Flaky test report");
    expect(summary).toContain("| 1 | `checkout > applies promo code` | 1.000 |");
  });

  // Regression: an unwritable $GITHUB_STEP_SUMMARY threw out of the run and failed
  // the whole step; the job summary is cosmetic, so it must only warn.
  it("warns instead of failing when $GITHUB_STEP_SUMMARY cannot be written", () => {
    const { status, stdout, stderr } = runCli(
      ["ci", suite, "--commit", "v1", "--format", "github"],
      { GITHUB_STEP_SUMMARY: join(tmp(), "no-such-dir", "summary.md") },
    );
    expect(status).toBe(0);
    expect(stdout).toContain("::warning");
    expect(stderr).toContain("GITHUB_STEP_SUMMARY");
  });

  // Regression: annotations used to go to stdout unconditionally, so combining the
  // two documented ci flags left stdout as JSON followed by ::warning lines.
  it("keeps stdout parseable when --json and --format github are combined", () => {
    const summaryFile = join(tmp(), "summary.md");
    const { stdout, stderr } = runCli(
      ["ci", suite, "--commit", "v1", "--format", "github", "--json"],
      { GITHUB_STEP_SUMMARY: summaryFile },
    );
    const report = JSON.parse(stdout) as Report;
    expect(report.schema_version).toBe(2);
    expect(stdout).not.toContain("::warning");
    expect(stderr).toContain("::warning title=Flaky test::checkout > applies promo code");
    expect(readFileSync(summaryFile, "utf8")).toContain("## Flaky test report");
  });
});

describe("exit code 2 (usage and input errors)", () => {
  const cases: [string, string[]][] = [
    ["unknown command", ["explode", suite]],
    ["missing inputs", ["analyze"]],
    ["missing file", ["analyze", "./nope.xml"]],
    ["bad metric", ["analyze", suite, "--metric", "vibes"]],
    ["bad model", ["analyze", suite, "--model", "vibes"]],
    ["lam out of range", ["analyze", suite, "--lam", "0"]],
    ["lam above 1", ["analyze", suite, "--lam", "1.5"]],
    ["min-reruns below 1", ["analyze", suite, "--min-reruns", "0"]],
    ["unknown flag", ["analyze", suite, "--wat"]],
    ["unsupported format", ["ci", suite, "--format", "teamcity"]],
    // Regression: analyze used to accept and ignore both ci-only flags, so
    // `analyze --fail-above 0.5` was a CI gate that could never fail.
    ["ci-only --fail-above on analyze", ["analyze", suite, "--fail-above", "0.5"]],
    ["ci-only --format on analyze", ["analyze", suite, "--format", "github"]],
  ];
  for (const [name, args] of cases) {
    it(`exits 2 on ${name}`, () => {
      expect(runCli(args).status).toBe(2);
    });
  }

  // Regression: an unexpected throw escaped run() and took Node's default exit 1,
  // which the contract reserves for "threshold exceeded".
  it("exits 2, not 1, when the history file cannot be written", () => {
    const { status } = runCli([
      "ci", suite, "--commit", "v1", "--history", join(tmp(), "missing-dir", "h.jsonl"),
    ]);
    expect(status).toBe(2);
  });

  // Regression: the no-command usage text went to stdout while exiting 2.
  it("sends the no-command usage error to stderr, leaving stdout clean", () => {
    const { status, stdout, stderr } = runCli([]);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("flaky-test-scorer analyze");
  });

  it("points ci-only flags at the ci command", () => {
    expect(runCli(["analyze", suite, "--fail-above", "0.5"]).stderr).toContain('use "ci"');
  });

  it("prints usage on --help and exits 0", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("flaky-test-scorer analyze");
    expect(stdout).toContain("Exit codes: 0 ok, 1 threshold exceeded, 2 usage or input error.");
  });
});

// Commander defaults to exit 1 on usage errors, which the v1 contract reserves for
// "threshold exceeded". These pin the exitOverride mapping after the framework swap.
describe("commander exit-code contract", () => {
  const cases: [string, string[], number][] = [
    ["unknown flag on analyze", ["analyze", suite, "--nope"], 2],
    ["unknown flag on ci", ["ci", suite, "--nope"], 2],
    ["missing variadic argument", ["ci"], 2],
    ["--help", ["--help"], 0],
    ["analyze --help", ["analyze", "--help"], 0],
  ];
  for (const [name, args, expected] of cases) {
    it(`exits ${expected} on ${name}`, () => {
      expect(runCli(args).status).toBe(expected);
    });
  }

  it("keeps stdout clean on a usage error and prints help on stdout", () => {
    expect(runCli(["analyze", suite, "--nope"]).stdout).toBe("");
    expect(runCli(["analyze", "--help"]).stdout).toContain("--explain");
  });
});

describe("mixed input formats", () => {
  it("scores CSV and JSON run history too", () => {
    const report = JSON.parse(
      runCli(["analyze", join(root, "test/fixtures/runs.csv"), "--json"]).stdout,
    ) as Report;
    expect(report.summary.tests).toBe(3);
    expect(report.tests[0]!.test_id).toBe("login_flow");
    expect(report.tests[0]!.score).toBe(1); // [pass, fail, pass] -> flipRate 1.0
  });
});
