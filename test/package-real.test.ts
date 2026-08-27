import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const suite = join(root, "test", "fixtures", "suite");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", ...env },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed (status ${String(result.status)}${result.error ? `, ${result.error.message}` : ""})\n` +
        `stdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

describe("packed package", () => {
  it("serves CLI, library, and MCP consumers from the published files", async () => {
    // Keeping the temp package below node_modules lets its imports resolve this
    // clean install's dependencies without a second network install.
    const work = mkdtempSync(join(root, "node_modules", ".packed-consumer-"));
    let client: Client | undefined;
    try {
      const packedOutput = run(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", work, "--json"],
        root,
        { NPM_CONFIG_CACHE: join(work, "npm-cache") },
      );
      const packed: unknown = JSON.parse(packedOutput);
      const entry = Array.isArray(packed)
        ? packed[0]
        : packed && typeof packed === "object"
          ? Object.values(packed)[0]
          : undefined;
      if (!entry || typeof entry !== "object" || !("filename" in entry) || typeof entry.filename !== "string") {
        throw new Error(`npm pack returned no filename: ${packedOutput}`);
      }

      const archive = join(work, entry.filename);
      const packageDir = join(work, "node_modules", "flaky-test-scorer");
      mkdirSync(packageDir, { recursive: true });
      run("tar", ["-xzf", archive, "-C", packageDir, "--strip-components=1"], root);

      const manifest: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const binValue = isRecord(manifest) ? manifest["bin"] : undefined;
      const bin =
        typeof binValue === "string"
          ? binValue
          : isRecord(binValue) && typeof binValue["flaky-test-scorer"] === "string"
            ? binValue["flaky-test-scorer"]
            : undefined;
      if (!bin) throw new Error("packed package has no flaky-test-scorer bin");
      const cli = join(packageDir, bin);

      // SAFETY: this is the packed CLI's JSON mode; assertions check its public fields.
      const cliReport: { schema_version: number; tests: unknown[] } = JSON.parse(
        run(cli, ["analyze", suite, "--commit", "packed-v1", "--json"], work),
      );
      expect(cliReport.schema_version).toBe(2);
      expect(cliReport.tests.length).toBeGreaterThan(0);

      const consumer = join(work, "consumer.mjs");
      writeFileSync(
        consumer,
        `import { groupByTestAndVersion, scoreTests } from "flaky-test-scorer";
const runs = [
  {
          test_id: "packed library",
          result: false,
          version: "v1",
          timestamp: 1,
          duration_s: null,
          failure_message: null,
          source_file: null,
  },
  {
          test_id: "packed library",
          result: true,
          version: "v1",
          timestamp: 2,
          duration_s: null,
          failure_message: null,
          source_file: null,
  },
];
process.stdout.write(JSON.stringify(scoreTests(groupByTestAndVersion(runs))[0]));
`,
      );
      const libraryResult: { gating_score: number } = JSON.parse(
        run(process.execPath, [consumer], work),
      );
      expect(libraryResult.gating_score).toBeGreaterThan(0);

      client = new Client({ name: "packed-consumer", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: cli,
        args: ["mcp"],
        cwd: work,
        stderr: "pipe",
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "analyze_history",
        "get_test_evidence",
        "explain_test",
      ]);
    } finally {
      await client?.close();
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
