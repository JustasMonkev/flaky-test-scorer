import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const playwright = join(root, "node_modules", ".bin", "playwright");
const reporter = join(root, "dist", "reporter", "playwright.js");

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runNode(args: string[], cwd: string): ChildResult {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const child: ChildResult = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (result.error) child.error = result.error;
  return child;
}

function expectSuccess(label: string, result: ChildResult): void {
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed (status ${String(result.status)}${result.error ? `, ${result.error.message}` : ""})\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

describe("real Playwright reporter integration", () => {
  it("keeps parallel repeatEach retry chains separate, and skips non-runs", () => {
    if (!existsSync(playwright)) {
      throw new Error(`real Playwright CLI is required at ${playwright}; install @playwright/test first`);
    }
    if (!existsSync(cli) || !existsSync(reporter)) {
      throw new Error("run `npm run build` first (npm test does it via pretest)");
    }

    const work = mkdtempSync(join(root, "node_modules", ".real-playwright-"));
    try {
      const testDir = join(work, "tests");
      const history = join(work, "history.jsonl");
      const config = join(work, "playwright.config.mjs");
      const spec = join(testDir, "flaky.spec.js");

      mkdirSync(testDir);
      writeFileSync(
        config,
        `export default {
  testDir: ${JSON.stringify(testDir)},
  outputDir: ${JSON.stringify(join(work, "test-results"))},
  retries: 1,
  repeatEach: 2,
  workers: 2,
  reporter: [[${JSON.stringify(reporter)}, { history: ${JSON.stringify(history)}, commit: "real-v1" }], ["line"]],
};
`,
      );
      writeFileSync(
        spec,
        `import { test } from "@playwright/test";

test("flips after one retry", ({}, testInfo) => {
  if (testInfo.retry === 0) throw new Error("timeout on first attempt");
});

test.skip("is not a run", () => {});
`,
      );

      const runner = runNode([playwright, "test", "--config", config], work);
      expectSuccess("Playwright runner", runner);

      expect(existsSync(history)).toBe(true);
      const lines = readFileSync(history, "utf8").trim().split("\n");
      expect(lines).toHaveLength(4);
      // SAFETY: the reporter owns these JSONL lines; the assertions below check their fields.
      const runs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(new Set(runs.map((run) => run["test_id"]))).toEqual(new Set(["flaky.spec.js > flips after one retry"]));
      expect(new Set(runs.map((run) => run["version"]))).toEqual(new Set(["real-v1"]));
      const executionIds = [...new Set(runs.map((run) => run["execution_id"]))];
      expect(executionIds).toHaveLength(2);
      for (const id of executionIds) {
        expect(runs.filter((run) => run["execution_id"] === id).map((run) => run["attempt"])).toEqual([0, 1]);
      }
      expect(runs.every((run) => run["test_id"] !== "flaky.spec.js > is not a run")).toBe(true);

      const reportRun = runNode([cli, "analyze", history, "--commit", "real-v1", "--json"], work);
      expectSuccess("built CLI", reportRun);
      // SAFETY: the built CLI owns this JSON; the assertions below check its public shape.
      const report = JSON.parse(reportRun.stdout) as {
        summary: { tests: number; runs: number; flaky: number };
        tests: Array<{
          test_id: string;
          score: number;
          confidence: number;
          gating_score: number;
          total_runs: number;
          independent_runs: number;
          num_versions: number;
          low_data: boolean;
          evidence: {
            transitions: { flips: number; total_runs: number };
            within_version_flips: number;
            within_run_retries: number;
          };
        }>;
      };
      expect(report.summary).toMatchObject({ tests: 1, runs: 4, flaky: 1 });
      expect(report.tests).toHaveLength(1);
      expect(report.tests[0]).toMatchObject({
        test_id: "flaky.spec.js > flips after one retry",
        total_runs: 4,
        independent_runs: 2,
        num_versions: 1,
        low_data: false,
        evidence: {
          transitions: { total_runs: 4 },
          within_version_flips: 1,
          within_run_retries: 2,
        },
      });
      expect(report.tests[0]!.gating_score).toBeGreaterThan(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
