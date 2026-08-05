// stdio MCP server (SPEC-V3.md F6). Every tool is a thin wrapper: ingestion,
// scoring, evidence and AI explain all stay in their existing modules.
// stdout is the JSON-RPC transport — diagnostics go to stderr, never stdout.
import { existsSync, readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { explain, requireProvider, type ProviderName } from "../ai/index.js";
import { InputError, dedupAgainst, detectCommit, expandInputs, loadRuns, readHistory } from "../ingest.js";
import { buildReport, type Report, type ReportTest } from "../report.js";
import { SCORE_DEFAULTS, groupByTestAndVersion, type RunRecord } from "../score.js";

// Resolves to the package root from both src/mcp/ (vitest) and dist/mcp/ (published).
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const warn = (message: string): void => void process.stderr.write(`flaky-test-scorer mcp: ${message}\n`);

// ------------------------------------------------------------ argument decoding

type Args = Record<string, unknown>;

function optString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${key} must be a non-empty string`);
  }
  return value;
}

function requireString(args: Args, key: string): string {
  const value = optString(args, key);
  if (value === undefined) throw new InputError(`${key} is required`);
  return value;
}

function optEnum<T extends string>(args: Args, key: string, allowed: readonly T[], fallback: T): T {
  const value = optString(args, key);
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) {
    throw new InputError(`${key} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

function optNumber(args: Args, key: string, fallback: number, ok: (n: number) => boolean, hint: string): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || !ok(n)) throw new InputError(`${key} must be ${hint}`);
  return n;
}

function optStrings(args: Args, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new InputError(`${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

// ------------------------------------------------------------------ tool bodies

function historyRuns(path: string): RunRecord[] {
  if (!existsSync(path)) throw new InputError(`history file not found: ${path}`);
  const { runs, corruptLines } = readHistory(path);
  if (corruptLines > 0) warn(`skipped ${corruptLines} corrupt line(s) in ${path}`);
  return runs;
}

function analyzeHistory(args: Args): Report {
  const historyPath = optString(args, "history_path");
  const inputs = optStrings(args, "inputs");
  if (historyPath === undefined && inputs.length === 0) {
    throw new InputError("provide history_path, inputs, or both");
  }
  // Artifacts already folded into the history would otherwise be counted twice,
  // halving flipRate. Same identity rule the CLI uses when it appends — which
  // means the same version too: stamping `null` here made every fresh run a
  // different identity from its own history row, so dedup matched nothing and
  // bucketed the runs under `__all__` where the CLI uses the detected commit.
  const history = historyPath === undefined ? [] : historyRuns(historyPath);
  const fresh = inputs.length === 0 ? [] : loadRuns(expandInputs(inputs), detectCommit());
  const runs = [...history, ...dedupAgainst(history, fresh)];
  if (runs.length === 0) {
    throw new InputError(`no usable test runs found in ${historyPath ?? inputs.join(", ")}`);
  }
  return buildReport(groupByTestAndVersion(runs), {
    metric: optEnum(args, "metric", ["flipRate", "entropy"] as const, SCORE_DEFAULTS.metric),
    model: optEnum(args, "model", ["weighted", "unweighted"] as const, SCORE_DEFAULTS.model),
    lam: optNumber(args, "lam", SCORE_DEFAULTS.lam, (n) => n > 0 && n <= 1, "a number in the range (0, 1]"),
    minReruns: optNumber(args, "min_reruns", SCORE_DEFAULTS.minReruns, (n) => n >= 1, "a number >= 1"),
  });
}

function getTestEvidence(args: Args): ReportTest {
  requireString(args, "history_path");
  const testId = requireString(args, "test_id");
  const report = analyzeHistory(args);
  const test = report.tests.find((t) => t.test_id === testId);
  if (!test) {
    throw new InputError(
      `unknown test_id: "${testId}" — this history holds ${report.tests.length} test(s); ` +
        `call analyze_history to list the exact ids`,
    );
  }
  return test;
}

async function explainTest(args: Args): Promise<unknown> {
  const test = getTestEvidence(args);
  const requested = optEnum(args, "provider", ["claude", "codex", "auto"] as const, "auto");
  const provider: ProviderName = requireProvider(requested === "auto" ? undefined : requested);
  const result = await explain(provider, { tests: [test] });
  return {
    test_id: test.test_id,
    provider: result.provider,
    model: result.model,
    analysis: result.perTest[0]?.analysis ?? "",
    heuristic: false,
  };
}

// ------------------------------------------------------------------- the server

const HISTORY_PATH_PROP = {
  history_path: { type: "string", description: "Path to a JSONL history file (read-only)." },
} as const;

const TEST_ID_PROP = {
  test_id: { type: "string", description: "Exact test id as reported by analyze_history." },
} as const;

const SCORE_PROPS = {
  metric: { type: "string", enum: ["flipRate", "entropy"], description: "Default flipRate." },
  model: { type: "string", enum: ["weighted", "unweighted"], description: "Default weighted." },
  lam: { type: "number", description: "EWMA decay in (0, 1], default 0.1." },
  min_reruns: { type: "number", description: "Below this run count a test is low_data, default 2." },
} as const;

const TOOLS: Tool[] = [
  {
    name: "analyze_history",
    description:
      "Score a whole test-run history and return the full deterministic flakiness report as JSON " +
      "(schema_version 1): summary counts, the scoring params used, and every test ranked with score, " +
      "confidence, lower_bound_score, verdict, evidence and a keyword-heuristic likely cause. " +
      "Use this first, whenever you need the overall picture of which tests are flaky and how badly, " +
      "before drilling into any single test. Pass history_path (a JSONL history file), inputs (JUnit XML / " +
      "JSON / CSV paths or globs), or both; both are read-only — nothing is written, appended or created. " +
      "It returns no AI prose, no source code and no raw run rows: for a natural-language hypothesis use explain_test.",
    inputSchema: {
      type: "object",
      properties: {
        ...HISTORY_PATH_PROP,
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "JUnit XML / JSON / CSV files, directories or simple globs to score.",
        },
        ...SCORE_PROPS,
      },
    },
  },
  {
    name: "get_test_evidence",
    description:
      "Return the single report object for one test_id: rank, score, confidence, lower_bound_score, verdict, " +
      "run/version counts and the deterministic evidence block (outcome flips, within-version flips, duration " +
      "variance, failure clusters) plus the heuristic likely cause and its recommendation. " +
      "Use it once analyze_history has named a suspect and you want that test's evidence without re-reading " +
      "the whole report. Requires history_path and an exact test_id as it appears in the report (usually " +
      "\"classname > name\"); an unrecognized id is an error, not an empty result. " +
      "It returns nothing about any other test, no raw run rows and no AI explanation.",
    inputSchema: {
      type: "object",
      properties: { ...HISTORY_PATH_PROP, ...TEST_ID_PROP, ...SCORE_PROPS },
      required: ["history_path", "test_id"],
    },
  },
  {
    name: "explain_test",
    description:
      "Explain in prose why one test is flaky by sending its deterministic evidence bundle to a configured AI " +
      "provider (claude or codex) and returning the provider's answer with the provider and model used. " +
      "Use it only after get_test_evidence, when the deterministic evidence is not enough on its own and you " +
      "want a root-cause hypothesis in words. Requires history_path and test_id; provider is optional and " +
      "defaults to the first configured one, and a missing credential or a provider failure comes back as a " +
      "tool error rather than crashing the server. The prose is a hypothesis, not evidence: no scores, no " +
      "evidence fields and no code changes are returned.",
    inputSchema: {
      type: "object",
      properties: {
        ...HISTORY_PATH_PROP,
        ...TEST_ID_PROP,
        provider: {
          type: "string",
          enum: ["claude", "codex", "auto"],
          description: "Default auto: first configured provider, claude before codex.",
        },
      },
      required: ["history_path", "test_id"],
    },
  },
];

const ok = (payload: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});

const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * ponytail: the low-level `Server` (deprecated in favour of `McpServer`) is used
 * on purpose — `McpServer.registerTool` only accepts zod schemas, and zod is not
 * a declared dependency of this package. Upgrade path: add zod to package.json,
 * then swap this for McpServer + registerTool.
 */
export function createMcpServer(): Server {
  const server = new Server({ name: "flaky-test-scorer", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Args;
    try {
      switch (request.params.name) {
        case "analyze_history":
          return ok(analyzeHistory(args));
        case "get_test_evidence":
          return ok(getTestEvidence(args));
        case "explain_test":
          return ok(await explainTest(args));
        default:
          return fail(`unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      // Bad input, a missing file or a dead provider come back as tool errors:
      // a long-lived server must survive every one of them.
      return fail((err as Error).message);
    }
  });

  return server;
}

/** Runs the stdio MCP server until the transport closes. Diagnostics to stderr only. */
export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  await closed;
}
