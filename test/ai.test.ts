import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProviderError,
  authStatus,
  autoSelectProvider,
  clearKey,
  explain,
  setKey,
  type ProviderName,
} from "../src/ai/index.js";
import { splitByTest } from "../src/ai/prompt.js";

// ------------------------------------------------------------------ test seams

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "FTS_CODEX_MODEL",
  "XDG_CONFIG_HOME",
  "PATH",
] as const;

let saved: Record<string, string | undefined>;
let binDir: string;
let configHome: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  configHome = mkdtempSync(join(tmpdir(), "fts-cfg-"));
  binDir = mkdtempSync(join(tmpdir(), "fts-bin-"));
  process.env["XDG_CONFIG_HOME"] = configHome;
  // Clean PATH: no real claude/codex binaries leak into resolution.
  process.env["PATH"] = binDir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A fake `claude`/`codex` binary that records argv + stdin and prints canned output. */
function fakeBinary(name: string, body: string): string {
  const log = join(binDir, `${name}.log`);
  // PATH is stripped to binDir for resolution tests, so restore it for the script's own tools.
  const script = `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf '%s\\0' "$@" > "${log}.args"\ncat > "${log}.stdin"\n${body}\n`;
  const path = join(binDir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return log;
}

interface Recorded {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

async function startServer(
  handler: (req: Recorded, res: ServerResponse) => void,
): Promise<{ requests: Recorded[]; origin: string; server: Server }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
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
  return { requests, origin: `http://127.0.0.1:${port}`, server };
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

const BUNDLE = {
  tests: [
    {
      test_id: "suite.Login > flaky_login",
      score: 0.86,
      evidence: { transitions: 7, within_version_flips: 2 },
      likely_cause: { category: "timeout" },
    },
    { test_id: "suite.Cart > flaky_cart", score: 0.4, evidence: { transitions: 2 } },
  ],
};

const withServer = async <T>(
  handler: (req: Recorded, res: ServerResponse) => void,
  fn: (ctx: { requests: Recorded[]; origin: string }) => Promise<T>,
): Promise<T> => {
  const ctx = await startServer(handler);
  try {
    return await fn(ctx);
  } finally {
    await new Promise<void>((r) => ctx.server.close(() => r()));
  }
};

// ------------------------------------------------------------------ resolution

describe("credential resolution order", () => {
  it("claude: ANTHROPIC_API_KEY env wins over auth token, config and CLI", () => {
    setKey("claude", "sk-config-aaaa");
    fakeBinary("claude", "echo hi");
    process.env["ANTHROPIC_AUTH_TOKEN"] = "tok-bbbb";
    process.env["ANTHROPIC_API_KEY"] = "sk-env-wxyz";
    const [claude] = authStatus();
    expect(claude).toEqual({
      provider: "claude",
      available: true,
      source: "ANTHROPIC_API_KEY env",
      keyTail: "...wxyz",
    });
  });

  it("claude: ANTHROPIC_AUTH_TOKEN env wins over config and CLI", () => {
    setKey("claude", "sk-config-aaaa");
    fakeBinary("claude", "echo hi");
    process.env["ANTHROPIC_AUTH_TOKEN"] = "tok-bbbb";
    expect(authStatus()[0]).toMatchObject({ source: "ANTHROPIC_AUTH_TOKEN env", keyTail: "...bbbb" });
  });

  it("claude: stored config key is used even when a CLI binary is present", () => {
    setKey("claude", "sk-config-aaaa");
    fakeBinary("claude", "echo hi");
    expect(authStatus()[0]).toMatchObject({ source: "config file", keyTail: "...aaaa" });
  });

  it("claude: ignores an installed CLI and requires API credentials", () => {
    fakeBinary("claude", "echo hi");
    expect(authStatus()[0]).toEqual({
      provider: "claude",
      available: false,
      source: "not configured",
      keyTail: null,
    });
  });

  it("claude: unavailable with no env, no config and no binary", () => {
    expect(authStatus()[0]).toEqual({
      provider: "claude",
      available: false,
      source: "not configured",
      keyTail: null,
    });
  });

  it("codex: ignores an installed CLI and only uses API credentials", () => {
    expect(authStatus()[1]).toMatchObject({ available: false, source: "not configured" });
    fakeBinary("codex", "echo hi");
    expect(authStatus()[1]).toMatchObject({ available: false, source: "not configured" });
    setKey("codex", "sk-codex-cfg1");
    expect(authStatus()[1]).toMatchObject({ source: "config file", keyTail: "...cfg1" });
    process.env["OPENAI_API_KEY"] = "sk-codex-env2";
    expect(authStatus()[1]).toMatchObject({ source: "OPENAI_API_KEY env", keyTail: "...env2" });
  });

  it("never surfaces full key material in auth status", () => {
    const secret = "sk-super-secret-value-1234";
    setKey("claude", secret);
    const dumped = JSON.stringify(authStatus());
    expect(dumped).not.toContain(secret);
    expect(dumped).toContain("...1234");
  });
});

describe("config store", () => {
  it("writes the documented shape at 0600 under XDG_CONFIG_HOME", () => {
    setKey("claude", "sk-a1");
    setKey("codex", "sk-b2");
    const file = join(configHome, "flaky-test-scorer", "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      providers: { claude: { api_key: "sk-a1" }, codex: { api_key: "sk-b2" } },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps 0600 when overwriting an existing, more permissive file", () => {
    setKey("claude", "sk-a1");
    const file = join(configHome, "flaky-test-scorer", "config.json");
    chmodSync(file, 0o644);
    setKey("claude", "sk-a2");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("clearKey removes only the named provider", () => {
    setKey("claude", "sk-a1");
    setKey("codex", "sk-b2");
    clearKey("claude");
    expect(authStatus()[0]).toMatchObject({ available: false });
    expect(authStatus()[1]).toMatchObject({ source: "config file", keyTail: "...k-b2" });
  });

  it("treats a corrupt config file as no stored keys", () => {
    const dir = join(configHome, "flaky-test-scorer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{not json");
    expect(authStatus().every((s) => !s.available)).toBe(true);
  });
});

describe("autoSelectProvider", () => {
  it("prefers claude when both are available", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-a";
    process.env["OPENAI_API_KEY"] = "sk-b";
    expect(autoSelectProvider()).toBe("claude");
  });
  it("falls through to codex when only codex API credentials are available", () => {
    const claude = fakeBinary("claude", "echo unsafe");
    const codex = fakeBinary("codex", "echo unsafe");
    process.env["OPENAI_API_KEY"] = "sk-b";
    expect(autoSelectProvider()).toBe("codex");
    expect(existsSync(`${claude}.args`)).toBe(false);
    expect(existsSync(`${codex}.args`)).toBe(false);
  });
  it("returns null when neither is configured", () => {
    expect(autoSelectProvider()).toBe(null);
  });
});

// ------------------------------------------------------------------ Claude API

describe("explain via the Claude API", () => {
  it("sends the documented request shape and splits the answer per test", async () => {
    const result = await withServer(
      (_req, res) =>
        json(
          res,
          200,
          claudeReply(
            "## suite.Login > flaky_login\nTimeouts under load.\n## suite.Cart > flaky_cart\nRace on cart state.",
          ),
        ),
      async ({ requests, origin }) => {
        process.env["ANTHROPIC_BASE_URL"] = origin;
        process.env["ANTHROPIC_API_KEY"] = "sk-test-key9";
        const r = await explain("claude", BUNDLE);
        const req = requests[0]!;
        expect(req.url.startsWith("/v1/messages")).toBe(true);
        expect(req.body["model"]).toBe("claude-opus-5");
        expect(req.body["max_tokens"]).toBe(16000);
        expect(req.body["fallbacks"]).toBe("default");
        expect(req.body["thinking"]).toBeUndefined();
        expect(req.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
        expect(JSON.stringify(req.body)).toContain("within_version_flips");
        expect(JSON.stringify(req.body)).toContain("suite.Login > flaky_login");
        return r;
      },
    );
    expect(result.provider).toBe("claude");
    expect(result.model).toBe("claude-opus-5");
    expect(result.perTest).toEqual([
      { test_id: "suite.Login > flaky_login", analysis: "Timeouts under load." },
      { test_id: "suite.Cart > flaky_cart", analysis: "Race on cart state." },
    ]);
  });

  it("keeps unsectioned prose instead of dropping it", async () => {
    const result = await withServer(
      (_req, res) => json(res, 200, claudeReply("Both tests look timing sensitive.")),
      async ({ origin }) => {
        process.env["ANTHROPIC_BASE_URL"] = origin;
        process.env["ANTHROPIC_API_KEY"] = "sk-test-key9";
        return explain("claude", BUNDLE);
      },
    );
    expect(result.perTest).toEqual([
      { test_id: "suite.Login > flaky_login", analysis: "Both tests look timing sensitive." },
    ]);
  });

  it("handles stop_reason refusal before reading content", async () => {
    const err = await withServer(
      (_req, res) => json(res, 200, claudeReply("", "refusal")),
      async ({ origin }) => {
        process.env["ANTHROPIC_BASE_URL"] = origin;
        process.env["ANTHROPIC_API_KEY"] = "sk-test-key9";
        return explain("claude", BUNDLE).catch((e: unknown) => e);
      },
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe("claude");
    expect((err as ProviderError).message).toMatch(/declined/i);
  });

  it("maps a 401 to a friendly ProviderError that never echoes the key", async () => {
    const err = await withServer(
      (_req, res) =>
        json(res, 401, {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
      async ({ origin }) => {
        process.env["ANTHROPIC_BASE_URL"] = origin;
        process.env["ANTHROPIC_API_KEY"] = "sk-super-secret-abcd";
        return explain("claude", BUNDLE).catch((e: unknown) => e);
      },
    );
    expect(err).toBeInstanceOf(ProviderError);
    const message = (err as ProviderError).message;
    expect(message).toContain("401");
    expect(message).toContain("auth set-key claude");
    expect(message).not.toContain("sk-super-secret-abcd");
  });

  it("maps other API errors to ProviderError with the status", async () => {
    const err = await withServer(
      (_req, res) =>
        json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }),
      async ({ origin }) => {
        process.env["ANTHROPIC_BASE_URL"] = origin;
        process.env["ANTHROPIC_API_KEY"] = "sk-test-key9";
        return explain("claude", BUNDLE).catch((e: unknown) => e);
      },
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain("400");
  });

  it("uses the stored config key when no env credential is present", async () => {
    await withServer(
      (_req, res) => json(res, 200, claudeReply("## suite.Cart > flaky_cart\nok")),
      async ({ requests, origin }) => {
        process.env["ANTHROPIC_BASE_URL"] = origin;
        setKey("claude", "sk-from-config");
        await explain("claude", BUNDLE);
        expect(requests[0]!.headers["x-api-key"]).toBe("sk-from-config");
      },
    );
  });

  it("sends ANTHROPIC_AUTH_TOKEN as a bearer token, not x-api-key", async () => {
    await withServer(
      (_req, res) => json(res, 200, claudeReply("## suite.Cart > flaky_cart\nok")),
      async ({ requests, origin }) => {
        process.env["ANTHROPIC_BASE_URL"] = origin;
        process.env["ANTHROPIC_AUTH_TOKEN"] = "tok-1234";
        await explain("claude", BUNDLE);
        expect(requests[0]!.headers["authorization"]).toBe("Bearer tok-1234");
        expect(requests[0]!.headers["x-api-key"]).toBeUndefined();
      },
    );
  });
});

// ------------------------------------------------------------------- Codex API

describe("explain via the Codex API", () => {
  it("defaults to gpt-5.2-codex, omits temperature and carries the evidence", async () => {
    const result = await withServer(
      (_req, res) => json(res, 200, codexReply("## suite.Login > flaky_login\nSlow dependency.")),
      async ({ requests, origin }) => {
        process.env["OPENAI_BASE_URL"] = `${origin}/v1`;
        process.env["OPENAI_API_KEY"] = "sk-openai-1234";
        const r = await explain("codex", BUNDLE);
        const req = requests[0]!;
        expect(req.url).toBe("/v1/chat/completions");
        expect(req.body["model"]).toBe("gpt-5.2-codex");
        expect(req.body["temperature"]).toBeUndefined();
        expect(req.headers["authorization"]).toBe("Bearer sk-openai-1234");
        expect(JSON.stringify(req.body)).toContain("within_version_flips");
        return r;
      },
    );
    expect(result).toEqual({
      provider: "codex",
      model: "gpt-5.2-codex",
      perTest: [{ test_id: "suite.Login > flaky_login", analysis: "Slow dependency." }],
    });
  });

  it("honours the FTS_CODEX_MODEL override", async () => {
    const result = await withServer(
      (_req, res) => json(res, 200, codexReply("## suite.Login > flaky_login\nx")),
      async ({ requests, origin }) => {
        process.env["OPENAI_BASE_URL"] = `${origin}/v1`;
        process.env["OPENAI_API_KEY"] = "sk-openai-1234";
        process.env["FTS_CODEX_MODEL"] = "gpt-custom-9";
        const r = await explain("codex", BUNDLE);
        expect(requests[0]!.body["model"]).toBe("gpt-custom-9");
        return r;
      },
    );
    expect(result.model).toBe("gpt-custom-9");
  });

  it("maps a 401 to a friendly ProviderError without the key", async () => {
    const err = await withServer(
      (_req, res) => json(res, 401, { error: { message: "bad key", type: "invalid_request_error" } }),
      async ({ origin }) => {
        process.env["OPENAI_BASE_URL"] = `${origin}/v1`;
        process.env["OPENAI_API_KEY"] = "sk-openai-secret-zzzz";
        return explain("codex", BUNDLE).catch((e: unknown) => e);
      },
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe("codex");
    expect((err as ProviderError).message).toContain("auth set-key codex");
    expect((err as ProviderError).message).not.toContain("sk-openai-secret-zzzz");
  });
});

// ------------------------------------------------------------- ignored CLI binaries

describe("CLI binaries are ignored", () => {
  it("does not execute Claude or Codex binaries, even when Codex API is configured", () => {
    const claude = fakeBinary("claude", "exit 99");
    const codex = fakeBinary("codex", "exit 99");
    process.env["OPENAI_API_KEY"] = "sk-test";
    expect(autoSelectProvider()).toBe("codex");
    expect(existsSync(claude + ".args")).toBe(false);
    expect(existsSync(codex + ".args")).toBe(false);
  });

});

describe("AI response section matching", () => {
  it("prefers an exact test ID over an earlier substring", () => {
    expect(splitByTest("## my test\nexact", ["test", "my test"])).toEqual([
      { test_id: "my test", analysis: "exact" },
    ]);
  });

  it("uses the longest matching ID when a header adds model prose", () => {
    expect(splitByTest("## Result for my test (retry)\nspecific", ["test", "my test"])).toEqual([
      { test_id: "my test", analysis: "specific" },
    ]);
  });
});

describe("no provider available", () => {
  it("explains how to configure each provider", async () => {
    for (const provider of ["claude", "codex"] as ProviderName[]) {
      const err = await explain(provider, BUNDLE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).message).toContain("auth set-key");
    }
    expect(existsSync(join(binDir, "claude"))).toBe(false);
  });
});
