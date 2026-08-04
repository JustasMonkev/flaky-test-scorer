// v4 regression tests: one case per defect found in the v4 review/campaign.
// Everything here is hermetic — no provider is ever contacted.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { readHistory } from "../src/ingest.js";
import { createMcpServer } from "../src/mcp/index.js";
import type { Report } from "../src/report.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const suite = join(root, "test", "fixtures", "suite");
const tmp = () => mkdtempSync(join(tmpdir(), "fts-v4-"));

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n");

// ------------------------------------------------------------------ H1 (MCP)

describe("H1: MCP analyze_history does not double-count artifacts already in the history", () => {
  const saved = process.env["GITHUB_SHA"];
  afterEach(() => {
    if (saved === undefined) delete process.env["GITHUB_SHA"];
    else process.env["GITHUB_SHA"] = saved;
  });

  async function analyze(args: Record<string, unknown>): Promise<Report> {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const result = (await client.callTool({ name: "analyze_history", arguments: args })) as {
        content: { text: string }[];
      };
      return JSON.parse(result.content[0]!.text) as Report;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("returns the same run count for history_path alone and history_path + the same inputs", async () => {
    // The CLI stamps the detected commit onto ingested runs; the MCP server used to
    // stamp null, so its identities never matched the history's and dedup was a no-op.
    process.env["GITHUB_SHA"] = "abc123";
    const dir = tmp();
    const history = join(dir, "h.jsonl");
    expect(runCli(["analyze", suite, "--history", history], { env: { GITHUB_SHA: "abc123" } }).status).toBe(0);

    const alone = await analyze({ history_path: history });
    const both = await analyze({ history_path: history, inputs: [suite] });
    expect(both.summary.runs).toBe(alone.summary.runs);
    expect(both.summary.tests).toBe(alone.summary.tests);
    expect(both.tests[0]!.num_versions).toBe(alone.tests[0]!.num_versions);
  });
});

// ------------------------------------------------------------ H2 (merge safety)

describe("H2: history merge never destroys the destination", () => {
  it("folds the destination's existing runs into the merge", () => {
    const dir = tmp();
    const shardA = join(dir, "a.jsonl");
    const shardB = join(dir, "b.jsonl");
    const acc = join(dir, "acc.jsonl");
    runCli(["analyze", suite, "--commit", "v1", "--history", shardA]);
    runCli(["analyze", suite, "--commit", "v2", "--history", shardB]);
    // The accumulated history restored from actions/cache, then merged into.
    runCli(["history", "merge", shardA, "--history", acc]);
    const before = lines(acc).length;

    const { status, stdout } = runCli(["history", "merge", shardB, "--history", acc]);
    expect(status).toBe(0);
    expect(lines(acc).length).toBe(before + lines(shardB).length);
    expect(stdout).toContain(`into ${acc}`);
  });

  it("keeps every destination run when the inputs contribute nothing", () => {
    const dir = tmp();
    const acc = join(dir, "acc.jsonl");
    runCli(["analyze", suite, "--commit", "v1", "--history", acc]);
    const before = lines(acc).length;

    // JUnit XML is not a history file: this used to truncate acc to empty, exit 0.
    const { status } = runCli(["history", "merge", join(suite, "run-1.xml"), "--history", acc]);
    expect(status).toBe(0);
    expect(lines(acc).length).toBe(before);
  });

  it("errors instead of creating an empty history when there is nothing to merge", () => {
    const dir = tmp();
    const fresh = join(dir, "fresh.jsonl");
    const { status, stderr } = runCli(["history", "merge", join(suite, "run-1.xml"), "--history", fresh]);
    expect(status).toBe(2);
    expect(stderr).toContain("produced 0 runs");
    expect(stderr).toContain("refusing to overwrite");
    expect(existsSync(fresh)).toBe(false);
  });

  it("names the input file that held a corrupt line", () => {
    const dir = tmp();
    const good = join(dir, "good.jsonl");
    const bad = join(dir, "bad.jsonl");
    runCli(["analyze", suite, "--commit", "v1", "--history", good]);
    writeFileSync(bad, `${lines(good)[0]}\nNOT JSON\n`, "utf8");
    const { stderr } = runCli(["history", "merge", good, bad, "--history", join(dir, "out.jsonl")]);
    expect(stderr).toContain("bad.jsonl");
    expect(stderr).not.toContain("input file(s)");
  });
});

// ------------------------------------------------------ M2/M3/M4 (friendly errors)

describe("input/output errors name the file instead of printing a stack", () => {
  it("M2: an unwritable --history path", () => {
    const { status, stderr } = runCli([
      "analyze", suite, "--history", join(tmp(), "missing-dir", "h.jsonl"),
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain("could not write");
    expect(stderr).toContain("h.jsonl");
    expect(stderr).not.toContain("    at ");
  });

  it("M3: an unreadable input directory", () => {
    if (process.getuid?.() === 0) return; // root can read mode-000 directories
    const dir = tmp();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const { status, stderr } = runCli(["analyze", dir]);
      expect(status).toBe(2);
      expect(stderr).toContain("cannot read directory");
      expect(stderr).toContain("locked");
      expect(stderr).not.toContain("    at ");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("M4: a --history path that is a directory", () => {
    const dir = tmp();
    mkdirSync(join(dir, "adir"));
    const { status, stderr } = runCli(["analyze", suite, "--history", join(dir, "adir")]);
    expect(status).toBe(2);
    expect(stderr).toContain("cannot read history file");
    expect(stderr).not.toContain("    at ");
  });
});

// --------------------------------------------------------- M5 (corrupt jsonl input)

describe("M5: corrupt lines in a .jsonl given as a positional input", () => {
  it("counts and warns instead of scoring the file silently", () => {
    const dir = tmp();
    const history = join(dir, "h.jsonl");
    runCli(["analyze", suite, "--commit", "v1", "--history", history]);
    const kept = lines(history);
    const mixed = join(dir, "mixed.jsonl");
    writeFileSync(mixed, `${kept[0]}\n{ truncated\n${kept[1]}\n`, "utf8");

    const { status, stderr } = runCli(["analyze", mixed]);
    expect(status).toBe(0);
    expect(stderr).toContain("skipped 1 corrupt line(s)");
    expect(stderr).toContain("mixed.jsonl");
  });
});

// ------------------------------------------------------- M6 (unknown field survival)

describe("M6: history rewrites preserve fields this version does not model", () => {
  const row = (extra: Record<string, unknown>) =>
    JSON.stringify({
      test_id: "a > b",
      result: "pass",
      version: "v1",
      timestamp: "2024-05-01T10:00:00",
      ...extra,
    });

  it("carries unknown columns through merge and prune", () => {
    const dir = tmp();
    const src = join(dir, "src.jsonl");
    const out = join(dir, "out.jsonl");
    writeFileSync(src, `${row({ ci_job: "shard-3", branch: "main" })}\n`, "utf8");

    runCli(["history", "merge", src, "--history", out]);
    expect(JSON.parse(lines(out)[0]!)).toMatchObject({ ci_job: "shard-3", branch: "main" });

    runCli(["history", "prune", "--history", out, "--keep-runs-per-test", "5"]);
    expect(JSON.parse(lines(out)[0]!)).toMatchObject({ ci_job: "shard-3", branch: "main" });
  });

  it("does not stamp the history file's own path onto rows that carry no source_file", () => {
    const dir = tmp();
    const src = join(dir, "src.jsonl");
    const out = join(dir, "out.jsonl");
    writeFileSync(src, `${row({})}\n`, "utf8");
    runCli(["history", "merge", src, "--history", out]);
    expect(JSON.parse(lines(out)[0]!).source_file).toBeNull();
  });
});

// ------------------------------------------------- M7 (checkout-path-independent dedup)

describe("M7: the same artifact ingested from two checkout paths is one run", () => {
  it("dedups against a shared history when only the absolute prefix differs", () => {
    const dir = tmp();
    const history = join(dir, "h.jsonl");
    const a = join(dir, "work-1");
    const b = join(dir, "work-2");
    for (const checkout of [a, b]) cpSync(suite, join(checkout, "results"), { recursive: true });

    runCli(["analyze", "results", "--commit", "v1", "--history", history], { cwd: a });
    const after = lines(history).length;
    runCli(["analyze", "results", "--commit", "v1", "--history", history], { cwd: b });
    expect(lines(history).length).toBe(after);
  });
});

// --------------------------------------------------------- M8 (concurrent appends)

describe("M8: concurrent --history writers leave a parseable file", () => {
  it("never splits a record across another writer's line", async () => {
    const dir = tmp();
    const history = join(dir, "h.jsonl");
    await Promise.all(
      ["v1", "v2", "v3", "v4"].map(
        (commit) =>
          new Promise<void>((done) => {
            const child = spawn(
              process.execPath,
              [cli, "analyze", suite, "--commit", commit, "--history", history],
              { cwd: root, stdio: "ignore" },
            );
            child.on("close", () => done());
          }),
      ),
    );
    const { runs, corruptLines } = readHistory(history);
    expect(corruptLines).toBe(0);
    expect(runs.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------ M9 (baselined tests eat the budget)

describe("M9: the top-N budget goes to newly-flaky tests first", () => {
  /** Baselines the highest-ranked flaky test, leaving one lower-ranked new one. */
  function baselineTop(dir: string): string {
    const path = join(dir, "base.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        tests: [{ test_id: "checkout > applies promo code", lower_bound_score: 0.5 }],
      }),
      "utf8",
    );
    return path;
  }

  it("shows the new test, not the baselined one, in a one-row markdown table", () => {
    const dir = tmp();
    const { stdout } = runCli([
      "ci", suite, "--commit", "v1", "--baseline", baselineTop(dir), "--format", "markdown", "--top", "1",
    ]);
    expect(stdout).toContain("syncs inventory");
    expect(stdout).not.toContain("| 1 | `checkout > applies promo code`");
  });

});

// ------------------------------------------------------------------- ergonomics

describe("ergonomics warnings", () => {
  it("E4: warns that ci without --fail-above is not a gate", () => {
    const { status, stderr } = runCli(["ci", suite, "--commit", "v1"]);
    expect(status).toBe(0);
    expect(stderr).toContain("never fails the build");
  });

  it("E5: accepts --provider auto, the vocabulary the MCP tool already used", () => {
    const { status, stderr } = runCli(["analyze", suite, "--commit", "v1", "--provider", "auto"]);
    expect(status).toBe(0);
    expect(stderr).not.toContain("must be claude");
  });

  it("E6: warns that --provider / --explain-top do nothing without --explain", () => {
    const { stderr } = runCli(["analyze", suite, "--commit", "v1", "--explain-top", "1"]);
    expect(stderr).toContain("--explain-top has no effect without --explain");
  });

  it("E8: explains why --keep-days pruned nothing when runs carry no timestamp", () => {
    const dir = tmp();
    const history = join(dir, "h.jsonl");
    // JUnit <testsuite> elements often carry no timestamp attribute at all.
    writeFileSync(history, `${JSON.stringify({ test_id: "a > b", result: "pass", version: "v1" })}\n`, "utf8");
    const { stdout, stderr } = runCli(["history", "prune", "--history", history, "--keep-days", "7"]);
    expect(stdout).toContain("pruned 0 run(s)");
    expect(stderr).toContain("no comparable timestamp");
  });

  it("LOW: --metric is canonicalized, not echoed, into the stable schema", () => {
    const { stdout } = runCli(["analyze", suite, "--commit", "v1", "--metric", "FLIPRATE", "--json"]);
    expect((JSON.parse(stdout) as Report).params.metric).toBe("flipRate");
  });
});
