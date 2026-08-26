import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Report } from "../src/report.js";

// End-to-end flows through the BUILT cli (node dist/cli.js). Nothing is mocked:
// the seams are a local http server (ANTHROPIC_BASE_URL / OPENAI_BASE_URL), fake
// `claude`/`codex` shell scripts on a stripped PATH, and a temp XDG_CONFIG_HOME.

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const suite = join(root, "test", "fixtures", "suite");
const TOP_TEST = "checkout > applies promo code";

const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "FTS_CODEX_MODEL",
];

let configHome: string;
let binDir: string;
let baseEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("run `npm run build` first (npm test does it via pretest)");
});

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "fts-e2e-cfg-"));
  binDir = mkdtempSync(join(tmpdir(), "fts-e2e-bin-"));
  // PATH is stripped to binDir so no real claude/codex/git on this machine can
  // change the outcome; the developer's own keys are removed from the child env.
  baseEnv = { ...process.env, XDG_CONFIG_HOME: configHome, PATH: binDir };
  for (const key of PROVIDER_ENV) delete baseEnv[key];
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...baseEnv, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

/** A fake `claude`/`codex` binary that records argv + stdin and prints canned output. */
function fakeBinary(name: string, body: string): string {
  const log = join(binDir, `${name}.log`);
  const script = `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf '%s\\0' "$@" > "${log}.args"\ncat > "${log}.stdin"\n${body}\n`;
  const path = join(binDir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return log;
}

const configFile = () => join(configHome, "flaky-test-scorer", "config.json");
const readConfig = () => JSON.parse(readFileSync(configFile(), "utf8")) as unknown;

interface Recorded {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

async function withServer<T>(
  handler: (req: Recorded, res: ServerResponse) => void,
  fn: (ctx: { requests: Recorded[]; origin: string }) => Promise<T>,
): Promise<T> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const rec: Recorded = {
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    return await fn({ requests, origin: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const claudeReply = (text: string, stopReason = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: stopReason === "refusal" ? [] : [{ type: "text", text }],
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const codexReply = (text: string) => ({
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 0,
  model: "gpt-5.2-codex",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});

const ANALYSIS = `## ${TOP_TEST}\nThe live payment stub times out under load.`;

// --------------------------------------------------------------------- auth status

describe("auth status (real provider layer)", () => {
  it("reports both providers unconfigured and still exits 0", async () => {
    const { status, stdout } = await runCli(["auth", "status"]);
    expect(status).toBe(0);
    expect(stdout).toContain("claude");
    expect(stdout).toContain("codex");
    expect(stdout).toContain("unavailable");
    expect(stdout).toContain("not configured");
  });

  it("names the env var source and shows only a masked tail", async () => {
    const secret = "sk-ant-super-secret-wxyz";
    const { stdout } = await runCli(["auth", "status"], { env: { ANTHROPIC_API_KEY: secret } });
    expect(stdout).toContain("ANTHROPIC_API_KEY env");
    expect(stdout).toContain("...wxyz");
    expect(stdout).not.toContain(secret);
  });

  it("reports the config file source after set-key", async () => {
    await runCli(["auth", "set-key", "claude", "--key", "sk-stored-abcd"]);
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toMatch(/claude\s+available\s+config file\s+\.\.\.abcd/);
  });

  it("ignores provider CLIs on PATH", async () => {
    fakeBinary("claude", "echo hi");
    fakeBinary("codex", "echo hi");
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toMatch(/claude\s+unavailable\s+not configured$/m);
    expect(stdout).toMatch(/codex\s+unavailable\s+not configured$/m);
  });

  it("applies documented precedence: environment beats config and CLI binaries are ignored", async () => {
    fakeBinary("claude", "echo hi");
    await runCli(["auth", "set-key", "claude", "--key", "sk-config-cfg1"]);

    expect((await runCli(["auth", "status"])).stdout).toContain("config file");
    expect(
      (await runCli(["auth", "status"], { env: { ANTHROPIC_AUTH_TOKEN: "tok-tttt" } })).stdout,
    ).toContain("ANTHROPIC_AUTH_TOKEN env");
    expect(
      (
        await runCli(["auth", "status"], {
          env: { ANTHROPIC_AUTH_TOKEN: "tok-tttt", ANTHROPIC_API_KEY: "sk-env-envv" },
        })
      ).stdout,
    ).toContain("ANTHROPIC_API_KEY env");

    await runCli(["auth", "clear", "claude"]);
    expect((await runCli(["auth", "status"])).stdout).toMatch(/claude\s+unavailable\s+not configured$/m);
  });

  it("uses only config or environment credentials for codex", async () => {
    fakeBinary("codex", "echo hi");
    expect((await runCli(["auth", "status"])).stdout).toMatch(
      /codex\s+unavailable\s+not configured$/m,
    );
    await runCli(["auth", "set-key", "codex", "--key", "sk-codex-cfg2"]);
    expect((await runCli(["auth", "status"])).stdout).toContain("...cfg2");
    const withEnv = await runCli(["auth", "status"], { env: { OPENAI_API_KEY: "sk-open-env3" } });
    expect(withEnv.stdout).toContain("OPENAI_API_KEY env");
    expect(withEnv.stdout).toContain("...env3");
  });
});

// -------------------------------------------------------------- auth set-key / clear

describe("auth set-key / clear (real config file)", () => {
  it("stores a --key at 0600 in the documented shape without echoing it", async () => {
    const { status, stdout, stderr } = await runCli([
      "auth", "set-key", "claude", "--key", "sk-flag-secret-1",
    ]);
    expect(status).toBe(0);
    expect(stdout + stderr).not.toContain("sk-flag-secret-1");
    expect(readConfig()).toEqual({ providers: { claude: { api_key: "sk-flag-secret-1" } } });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
  });

  it("reads a key piped on stdin and never echoes it", async () => {
    const { status, stdout, stderr } = await runCli(["auth", "set-key", "codex"], {
      input: "sk-piped-secret-2\n",
    });
    expect(status).toBe(0);
    expect(stdout + stderr).not.toContain("sk-piped-secret-2");
    expect(readConfig()).toEqual({ providers: { codex: { api_key: "sk-piped-secret-2" } } });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
  });

  it("exits 2 on an empty stdin instead of storing a blank key", async () => {
    const { status, stderr } = await runCli(["auth", "set-key", "claude"], { input: "" });
    expect(status).toBe(2);
    expect(stderr).toContain("stdin");
    expect(existsSync(configFile())).toBe(false);
  });

  // Regression: writeConfig's EACCES escaped as a raw stack trace on stderr.
  it("reports an unwritable config home as an input error, not a stack trace", async () => {
    const locked = mkdtempSync(join(tmpdir(), "fts-e2e-ro-"));
    chmodSync(locked, 0o500);
    try {
      const { status, stderr } = await runCli(["auth", "set-key", "claude", "--key", "sk-x-1234"], {
        env: { XDG_CONFIG_HOME: locked },
      });
      expect(status).toBe(2);
      expect(stderr).toContain("could not write the config file");
      expect(stderr).not.toContain("at writeConfig");
      expect(stderr).not.toContain("sk-x-1234");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("exits 2 on an unknown provider without touching the config", async () => {
    const { status, stderr } = await runCli(["auth", "set-key", "gpt", "--key", "k"]);
    expect(status).toBe(2);
    expect(stderr).toContain("claude, codex or auto");
    expect(existsSync(configFile())).toBe(false);
  });

  it("clears only the named provider", async () => {
    await runCli(["auth", "set-key", "claude", "--key", "sk-a-1111"]);
    await runCli(["auth", "set-key", "codex", "--key", "sk-b-2222"]);
    const { status } = await runCli(["auth", "clear", "claude"]);
    expect(status).toBe(0);
    expect(readConfig()).toEqual({ providers: { codex: { api_key: "sk-b-2222" } } });
    const after = (await runCli(["auth", "status"])).stdout;
    expect(after).toMatch(/claude\s+unavailable/);
    expect(after).toContain("...2222");
  });
});

// ------------------------------------------------------------- explain: Claude API

describe("--explain against the Claude API (mock server)", () => {
  const claudeEnv = (origin: string) => ({
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_API_KEY: "sk-ant-e2e-key1",
  });

  it("sends the evidence bundle and renders an AI section in human output", async () => {
    const { result, requests } = await withServer(
      (_req, res) => json(res, 200, claudeReply(ANALYSIS)),
      async ({ requests, origin }) => ({
        result: await runCli(["analyze", suite, "--commit", "v1", "--explain"], {
          env: claudeEnv(origin),
        }),
        requests,
      }),
    );

    expect(result.status).toBe(0);
    const req = requests[0]!;
    expect(req.url.startsWith("/v1/messages")).toBe(true);
    expect(req.body["model"]).toBe("claude-opus-5");
    expect(req.body["fallbacks"]).toBe("default");
    expect(req.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    const sent = JSON.stringify(req.body);
    expect(sent).toContain(TOP_TEST);
    expect(sent).toContain("within_version_flips");

    expect(result.stdout).toContain("AI analysis (claude)");
    expect(result.stdout).toContain("claude-opus-5");
    expect(result.stdout).toContain("The live payment stub times out under load.");
    // deterministic report untouched and still ahead of the AI section
    expect(result.stdout).toContain("likely cause: timeout");
    expect(result.stdout.indexOf("#1  very_flaky")).toBeLessThan(
      result.stdout.indexOf("AI analysis"),
    );
  });

  it("adds ai_analysis to --json without bumping schema_version", async () => {
    const result = await withServer(
      (_req, res) => json(res, 200, claudeReply(ANALYSIS)),
      ({ origin }) =>
        runCli(["analyze", suite, "--commit", "v1", "--json", "--explain"], {
          env: claudeEnv(origin),
        }),
    );
    const report = JSON.parse(result.stdout) as Report & { ai_analysis: Record<string, unknown> };
    expect(report.schema_version).toBe(2);
    expect(report.ai_analysis).toEqual({
      provider: "claude",
      model: "claude-opus-5",
      per_test: [{ test_id: TOP_TEST, analysis: "The live payment stub times out under load." }],
      heuristic: false,
    });
  });

  it("caps the bundle with --explain-top and only sends flagged tests", async () => {
    const requests = await withServer(
      (_req, res) => json(res, 200, claudeReply(ANALYSIS)),
      async ({ requests, origin }) => {
        await runCli(["analyze", suite, "--commit", "v1", "--explain", "--explain-top", "1"], {
          env: claudeEnv(origin),
        });
        return requests;
      },
    );
    const sent = JSON.stringify(requests[0]!.body);
    expect(sent).toContain(TOP_TEST);
    expect(sent).not.toContain("renders cart"); // score 0, never sent
    expect(sent).not.toContain("syncs inventory"); // beyond --explain-top 1
  });

  it("warns and keeps exit 0 when the provider refuses", async () => {
    const { status, stdout, stderr } = await withServer(
      (_req, res) => json(res, 200, claudeReply("", "refusal")),
      ({ origin }) =>
        runCli(["analyze", suite, "--commit", "v1", "--explain"], { env: claudeEnv(origin) }),
    );
    expect(status).toBe(0);
    expect(stderr).toMatch(/declined/i);
    expect(stdout).toContain("#1  very_flaky");
    expect(stdout).not.toContain("AI analysis");
  });

  it("turns a 401 into a friendly warning that never echoes the key", async () => {
    const secret = "sk-ant-super-secret-9999";
    const { status, stdout, stderr } = await withServer(
      (_req, res) =>
        json(res, 401, {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
      ({ origin }) =>
        runCli(["analyze", suite, "--commit", "v1", "--explain"], {
          env: { ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: secret },
        }),
    );
    expect(status).toBe(0);
    expect(stderr).toContain("401");
    expect(stderr).toContain("auth set-key claude");
    expect(stderr).not.toContain(secret);
    expect(stdout).toContain("#1  very_flaky");
  });

  it("uses a key stored by set-key when no env credential is present", async () => {
    await runCli(["auth", "set-key", "claude", "--key", "sk-stored-e2e-1"]);
    const requests = await withServer(
      (_req, res) => json(res, 200, claudeReply(ANALYSIS)),
      async ({ requests, origin }) => {
        const { stdout } = await runCli(["analyze", suite, "--commit", "v1", "--explain"], {
          env: { ANTHROPIC_BASE_URL: origin },
        });
        expect(stdout).toContain("AI analysis (claude)");
        return requests;
      },
    );
    expect(requests[0]!.headers["x-api-key"]).toBe("sk-stored-e2e-1");
  });

  it("spends a one-test explanation budget on a newly flaky test before a baselined one", async () => {
    const baseline = join(configHome, "baseline.json");
    writeFileSync(
      baseline,
      JSON.stringify({
        schema_version: 2,
        tests: [{ test_id: TOP_TEST, gating_score: 0.5 }],
      }),
    );
    const requests = await withServer(
      (_req, res) => json(res, 200, claudeReply("## checkout > syncs inventory\nInvestigate timing.")),
      async ({ requests, origin }) => {
        await runCli(
          [
            "ci",
            suite,
            "--commit",
            "v1",
            "--baseline",
            baseline,
            "--json",
            "--explain",
            "--explain-top",
            "1",
          ],
          { env: claudeEnv(origin) },
        );
        return requests;
      },
    );
    const sent = JSON.stringify(requests[0]!.body);
    expect(sent).toContain("syncs inventory");
    expect(sent).not.toContain(TOP_TEST);
  });

  it("collapses AI analysis below the Markdown report", async () => {
    const { stdout } = await withServer(
      (_req, res) => json(res, 200, claudeReply(ANALYSIS)),
      ({ origin }) =>
        runCli(["ci", suite, "--commit", "v1", "--format", "markdown", "--explain"], {
          env: claudeEnv(origin),
        }),
    );
    expect(stdout.split("\n")[0]).toBe("<!-- flaky-test-scorer -->");
    expect(stdout.indexOf("### Top offenders")).toBeLessThan(stdout.indexOf("<details>"));
    expect(stdout).toContain("<summary>AI analysis (claude)");
    expect(stdout.trimEnd().endsWith("</details>")).toBe(true);
  });
});

// -------------------------------------------------------------- explain: Codex API

describe("--explain against the Codex API (mock server)", () => {
  it("renders the codex section in human output when selected explicitly", async () => {
    const { result, requests } = await withServer(
      (_req, res) => json(res, 200, codexReply(`## ${TOP_TEST}\nRetries hide a slow dependency.`)),
      async ({ requests, origin }) => ({
        result: await runCli(
          ["analyze", suite, "--commit", "v1", "--explain", "--provider", "codex"],
          { env: { OPENAI_BASE_URL: `${origin}/v1`, OPENAI_API_KEY: "sk-openai-e2e-1" } },
        ),
        requests,
      }),
    );
    expect(result.status).toBe(0);
    expect(requests[0]!.url).toBe("/v1/chat/completions");
    expect(requests[0]!.body["model"]).toBe("gpt-5.2-codex");
    expect(JSON.stringify(requests[0]!.body)).toContain("within_version_flips");
    expect(result.stdout).toContain("AI analysis (codex)");
    expect(result.stdout).toContain("gpt-5.2-codex");
    expect(result.stdout).toContain("Retries hide a slow dependency.");
  });

  it("auto-selects codex in --json when only codex is configured", async () => {
    const result = await withServer(
      (_req, res) => json(res, 200, codexReply(`## ${TOP_TEST}\nAuto-picked.`)),
      ({ origin }) =>
        runCli(["analyze", suite, "--commit", "v1", "--json", "--explain"], {
          env: { OPENAI_BASE_URL: `${origin}/v1`, OPENAI_API_KEY: "sk-openai-e2e-2" },
        }),
    );
    const report = JSON.parse(result.stdout) as { ai_analysis: { provider: string; model: string } };
    expect(report.ai_analysis.provider).toBe("codex");
    expect(report.ai_analysis.model).toBe("gpt-5.2-codex");
  });

  it("prefers claude when both providers are configured", async () => {
    const result = await withServer(
      (_req, res) => json(res, 200, claudeReply(ANALYSIS)),
      ({ origin }) =>
        runCli(["analyze", suite, "--commit", "v1", "--json", "--explain"], {
          env: {
            ANTHROPIC_BASE_URL: origin,
            ANTHROPIC_API_KEY: "sk-ant-e2e-key1",
            // deliberately unreachable: picking codex would fail the request
            OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
            OPENAI_API_KEY: "sk-openai-e2e-3",
          },
        }),
    );
    const report = JSON.parse(result.stdout) as { ai_analysis: { provider: string } };
    expect(report.ai_analysis.provider).toBe("claude");
  });
});

// ------------------------------------------------------- explain: CLI-binary modes

describe("--explain ignores provider CLI binaries", () => {
  it("does not execute a PATH-provided Claude CLI", async () => {
    const log = fakeBinary("claude", `printf '## ${TOP_TEST}\\nThe stub never returns.\\n'`);
    const { status, stdout, stderr } = await runCli(["analyze", suite, "--commit", "v1", "--explain"]);
    expect(status).toBe(0);
    expect(stderr).toContain("no AI provider configured");
    expect(existsSync(log + ".args")).toBe(false);
    expect(stdout).not.toContain("AI analysis");
  });

  it("does not execute an installed Codex CLI", async () => {
    const log = fakeBinary("codex", `printf '## ${TOP_TEST}\\nCodex says race.\\n'`);
    const { status, stdout, stderr } = await runCli([
      "analyze",
      suite,
      "--commit",
      "v1",
      "--json",
      "--explain",
      "--provider",
      "codex",
    ]);
    expect(status).toBe(0);
    expect(stderr).toContain("No Codex credentials");
    expect(existsSync(`${log}.args`)).toBe(false);
    expect(JSON.parse(stdout)).not.toHaveProperty("ai_analysis");
  });

});

// --------------------------------------------------------------- no provider / ci

describe("--explain without a usable provider", () => {
  it("names every way to configure one and leaves the report untouched", async () => {
    const { status, stdout, stderr } = await runCli([
      "analyze", suite, "--commit", "v1", "--explain",
    ]);
    expect(status).toBe(0);
    expect(stderr).toContain("ANTHROPIC_API_KEY");
    expect(stderr).toContain("OPENAI_API_KEY");
    expect(stderr).toContain("auth set-key");
    expect(stdout).toContain("#1  very_flaky");
    expect(stdout).not.toContain("AI analysis");
  });

  // Regression: a bad --explain-top value was swallowed by the explain warning path
  // and exited 0, while every other malformed flag value exits 2.
  it("exits 2 on a malformed --explain-top instead of degrading to a warning", async () => {
    const { status, stderr } = await runCli([
      "analyze", suite, "--commit", "v1", "--explain", "--explain-top", "vibes",
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain("--explain-top must be a number");
  });

  it("exits 2 on a bad --provider even before the report is built", async () => {
    const { status, stderr } = await runCli([
      "analyze", suite, "--commit", "v1", "--explain", "--provider", "gpt",
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain("claude, codex or auto");
  });

  it("still emits parseable JSON with no ai_analysis field", async () => {
    const { stdout } = await runCli(["analyze", suite, "--commit", "v1", "--json", "--explain"]);
    const report = JSON.parse(stdout) as Report & { ai_analysis?: unknown };
    expect(report.schema_version).toBe(2);
    expect(report.ai_analysis).toBeUndefined();
  });
});

describe("ci exit codes are independent of --explain", () => {
  it("still exits 1 above the threshold when the provider is missing", async () => {
    const { status, stderr } = await runCli([
      "ci", suite, "--commit", "v1", "--fail-above", "0.4", "--explain",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain(TOP_TEST);
  });

  it("still exits 0 below the threshold when the provider errors", async () => {
    fakeBinary("claude", "exit 7");
    const { status, stderr } = await runCli([
      "ci", suite, "--commit", "v1", "--fail-above", "0.9", "--explain",
    ]);
    expect(status).toBe(0);
    expect(stderr).toContain("no AI provider configured");
  });

  it("still exits 1 above the threshold when the provider succeeds", async () => {
    const { status, stdout } = await withServer(
      (_req, res) => json(res, 200, claudeReply(ANALYSIS)),
      ({ origin }) =>
        runCli(["ci", suite, "--commit", "v1", "--fail-above", "0.4", "--explain"], {
          env: { ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: "sk-ant-e2e-key1" },
        }),
    );
    expect(status).toBe(1);
    expect(stdout).toContain("AI analysis (claude)");
  });
});
