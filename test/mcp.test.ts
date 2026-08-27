import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/index.js";
import type { Report, ReportTest } from "../src/report.js";

// The server is exercised over real JSON-RPC: an in-memory transport pair for the
// tool surface, plus one spawned stdio entry file proving the transport wiring.
// Nothing here goes through dist/cli.js — the `mcp` subcommand is wired elsewhere.

const root = fileURLToPath(new URL("..", import.meta.url));
const suite = join(root, "test", "fixtures", "suite");
const FLAKY = "checkout > applies promo code";
const STABLE = "checkout > renders cart";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "XDG_CONFIG_HOME",
  "PATH",
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let history: string;

/** A history with one clearly flaky test (incl. a within-version flip) and one stable one. */
function writeHistory(path: string): void {
  const runs: [string, boolean, string, string][] = [
    [FLAKY, true, "v1", "2024-05-01T10:00:00"],
    [FLAKY, false, "v1", "2024-05-01T11:00:00"],
    [FLAKY, true, "v1", "2024-05-01T12:00:00"],
    [FLAKY, false, "v2", "2024-05-02T10:00:00"],
    [FLAKY, true, "v2", "2024-05-02T11:00:00"],
    [STABLE, true, "v1", "2024-05-01T10:00:00"],
    [STABLE, true, "v1", "2024-05-01T11:00:00"],
    [STABLE, true, "v2", "2024-05-02T10:00:00"],
  ];
  const lines = runs.map(([test_id, result, version, timestamp]) =>
    JSON.stringify({
      test_id,
      result: result ? "pass" : "fail",
      version,
      timestamp,
      duration_s: result ? 0.4 : 30.2,
      failure_message: result ? null : "Timeout of 30000ms exceeded waiting for selector #promo",
      source_file: "ci.xml",
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), "fts-mcp-"));
  history = join(tmp, "history.jsonl");
  writeHistory(history);
  // No provider credentials and an empty PATH by default: explain must not reach
  // the developer's own claude/codex install.
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["PATH"] = join(tmp, "empty-bin");
  process.env["XDG_CONFIG_HOME"] = join(tmp, "empty-config");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------- JSON-RPC seam

interface ToolOutcome {
  isError: boolean;
  text: string;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? "" };
}

const okJson = <T>(outcome: ToolOutcome): T => {
  expect(outcome.isError, outcome.text).toBe(false);
  return JSON.parse(outcome.text) as T;
};

// ------------------------------------------------------- fake Anthropic backend

function startAnthropic(
  handler: (body: Record<string, unknown>, res: ServerResponse) => void,
): Promise<{ origin: string; requests: Record<string, unknown>[]; close: () => Promise<void> }> {
  const requests: Record<string, unknown>[] = [];
  const server: HttpServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push(body);
      handler(body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const claudeReply = (text: string) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

// ------------------------------------------------------------------ handshake

describe("initialize", () => {
  it("completes the handshake and advertises the tools capability", async () => {
    await withClient(async (client) => {
      expect(client.getServerVersion()?.name).toBe("flaky-test-scorer");
      expect(client.getServerVersion()?.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(client.getServerCapabilities()?.tools).toBeDefined();
    });
  });
});

describe("tools/list", () => {
  it("exposes exactly the three specified tools", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "analyze_history",
        "explain_test",
        "get_test_evidence",
      ]);
    });
  });

  it("describes each tool with when-to-use guidance and what is not returned", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const description = tool.description ?? "";
        // 3-4 sentences, per spec.
        const sentences = description.split(". ").length;
        expect(sentences, tool.name).toBeGreaterThanOrEqual(3);
        expect(description, tool.name).toMatch(/Use (it|this)/);
        expect(description, tool.name).toMatch(/(returns no|are returned|nothing about)/i);
        expect(tool.inputSchema.type).toBe("object");
      }
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get("get_test_evidence")?.inputSchema["required"]).toEqual([
        "history_path",
        "test_id",
      ]);
      expect(byName.get("explain_test")?.inputSchema["required"]).toEqual([
        "history_path",
        "test_id",
      ]);
    });
  });
});

// -------------------------------------------------------------- analyze_history

describe("analyze_history", () => {
  it("returns the full schema 2 report for a history file", async () => {
    await withClient(async (client) => {
      const report = okJson<Report>(await call(client, "analyze_history", { history_path: history }));
      expect(report.schema_version).toBe(2);
      expect(report.summary.runs).toBe(8);
      expect(report.summary.tests).toBe(2);
      const top = report.tests[0]!;
      expect(top.test_id).toBe(FLAKY);
      expect(top.rank).toBe(1);
      expect(top.score).toBeGreaterThan(0);
      expect(top.evidence.within_version_flips).toBeGreaterThan(0);
      expect(top.likely_cause.category).toBe("timeout");
      expect(report.tests.find((t) => t.test_id === STABLE)?.score).toBe(0);
    });
  });

  it("scores raw JUnit inputs when no history is given", async () => {
    await withClient(async (client) => {
      const report = okJson<Report>(
        await call(client, "analyze_history", { inputs: [join(suite, "*.xml")] }),
      );
      expect(report.summary.tests).toBeGreaterThan(0);
      expect(report.tests.some((t) => t.score > 0)).toBe(true);
    });
  });

  it("honours metric, model, lam and min_reruns", async () => {
    await withClient(async (client) => {
      const report = okJson<Report>(
        await call(client, "analyze_history", {
          history_path: history,
          metric: "entropy",
          model: "unweighted",
          lam: 0.5,
          min_reruns: 20,
        }),
      );
      expect(report.params).toEqual({
        metric: "entropy",
        model: "unweighted",
        lam: 0.5,
        min_reruns: 20,
      });
      expect(report.tests.every((t) => t.low_data)).toBe(true);
    });
  });

  it("errors when neither history_path nor inputs are given", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "analyze_history", {});
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("provide history_path, inputs, or both");
    });
  });

  it("reports a missing history file as a tool error and keeps serving", async () => {
    await withClient(async (client) => {
      const missing = join(tmp, "nope.jsonl");
      const outcome = await call(client, "analyze_history", { history_path: missing });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain(missing);
      // The transport survived: the very next call still works.
      const report = okJson<Report>(await call(client, "analyze_history", { history_path: history }));
      expect(report.summary.tests).toBe(2);
    });
  });

  it("rejects an unknown metric value", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "analyze_history", {
        history_path: history,
        metric: "vibes",
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("metric must be one of");
    });
  });

  it("reports an unknown tool name without dying", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "quarantine_everything", {});
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("unknown tool");
    });
  });
});

// ------------------------------------------------------------ get_test_evidence

describe("get_test_evidence", () => {
  it("returns that one test's report object", async () => {
    await withClient(async (client) => {
      const test = okJson<ReportTest>(
        await call(client, "get_test_evidence", { history_path: history, test_id: FLAKY }),
      );
      expect(test.test_id).toBe(FLAKY);
      expect(test.evidence.transitions.total_runs).toBe(5);
      expect(test.evidence.failure_clusters.length).toBeGreaterThan(0);
      expect(test.recommendation).toBeTruthy();
      expect(test).not.toHaveProperty("tests");
    });
  });

  it("errors on an unknown test_id", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "get_test_evidence", {
        history_path: history,
        test_id: "checkout > no such test",
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("unknown test_id");
      expect(outcome.text).toContain("analyze_history");
    });
  });

  it("errors when test_id is missing", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "get_test_evidence", { history_path: history });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("test_id is required");
    });
  });
});

// ---------------------------------------------------------------- explain_test

describe("explain_test", () => {
  it("returns provider prose for one test", async () => {
    const backend = await startAnthropic((_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(claudeReply(`## ${FLAKY}\nThe promo lookup waits on a live endpoint.`)));
    });
    try {
      process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
      process.env["ANTHROPIC_BASE_URL"] = backend.origin;
      await withClient(async (client) => {
        const result = okJson<{ test_id: string; provider: string; model: string; analysis: string }>(
          await call(client, "explain_test", { history_path: history, test_id: FLAKY }),
        );
        expect(result.test_id).toBe(FLAKY);
        expect(result.provider).toBe("claude");
        expect(result.model).toBe("claude-opus-5");
        expect(result.analysis).toContain("live endpoint");
        // The deterministic bundle for exactly that one test was what got sent.
        const sent = JSON.stringify(backend.requests[0]);
        expect(sent).toContain(FLAKY);
        expect(sent).not.toContain(STABLE);
      });
    } finally {
      await backend.close();
    }
  });

  it("errors cleanly when no provider is configured", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "explain_test", { history_path: history, test_id: FLAKY });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("no AI provider configured");
      expect(outcome.text).toContain("ANTHROPIC_API_KEY");
    });
  });

  it("surfaces a provider auth failure as a tool error and keeps serving", async () => {
    const backend = await startAnthropic((_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
    });
    try {
      process.env["ANTHROPIC_API_KEY"] = "sk-bad-key";
      process.env["ANTHROPIC_BASE_URL"] = backend.origin;
      await withClient(async (client) => {
        const outcome = await call(client, "explain_test", { history_path: history, test_id: FLAKY });
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toMatch(/credentials|401/);
        const test = okJson<ReportTest>(
          await call(client, "get_test_evidence", { history_path: history, test_id: FLAKY }),
        );
        expect(test.test_id).toBe(FLAKY);
      });
    } finally {
      await backend.close();
    }
  });

  it("errors on an unknown test_id before contacting any provider", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "explain_test", {
        history_path: history,
        test_id: "nope",
        provider: "claude",
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("unknown test_id");
    });
  });

  it("rejects an unknown provider name", async () => {
    await withClient(async (client) => {
      const outcome = await call(client, "explain_test", {
        history_path: history,
        test_id: FLAKY,
        provider: "ouija",
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("provider must be one of");
    });
  });
});

// ------------------------------------------------------------------ real stdio

describe("stdio transport", () => {
  const built = join(root, "dist", "mcp", "index.js");

  beforeAll(() => {
    if (!existsSync(built)) throw new Error("run `npm run build` first");
  });

  it("serves JSON-RPC over stdin/stdout from a spawned process", async () => {
    const entry = join(tmp, "mcp-entry.mjs");
    writeFileSync(
      entry,
      `import { runMcpServer } from ${JSON.stringify(pathToFileURL(built).href)};\nawait runMcpServer();\n`,
      "utf8",
    );
    const client = new Client({ name: "stdio-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("flaky-test-scorer");
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(3);
      const result = await client.callTool({
        name: "analyze_history",
        arguments: { history_path: history },
      });
      const content = result.content as { text: string }[];
      const report = JSON.parse(content[0]!.text) as Report;
      expect(report.tests[0]?.test_id).toBe(FLAKY);
    } finally {
      await client.close();
    }
  });
});

// stdout IS the stdio transport, so diagnostics must go to stderr: a corrupt-line
// warning printed to stdout would desynchronize every client on the wire.
describe("diagnostics", () => {
  it("routes the corrupt-history warning to stderr, never stdout", async () => {
    const corrupt = join(tmp, "corrupt.jsonl");
    writeFileSync(corrupt, "not json\n{bad\n", "utf8");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const capture = (chunks: string[]) =>
      ((chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stdout.write;
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = capture(stdout);
    process.stderr.write = capture(stderr);
    try {
      await withClient(async (client) => {
        const outcome = await call(client, "analyze_history", { history_path: corrupt });
        expect(outcome.isError).toBe(true);
      });
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    expect(stderr.join("")).toContain("corrupt line(s)");
    expect(stdout.join("")).not.toContain("corrupt");
  });
});
