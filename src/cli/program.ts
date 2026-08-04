import { Command, CommanderError } from "commander";
import { InputError } from "../ingest.js";
import { runReport } from "./analyze.js";
import { readKeyFromStdin, runAuthStatus, writeConfig } from "./auth.js";
import { runBaselineUpdate } from "./baseline.js";
import { runHistoryMerge, runHistoryPrune } from "./history.js";
import { loadAi } from "./lazy-ai.js";
import { asProvider, type ReportOptions } from "./options.js";
import { USAGE } from "./usage.js";

function buildProgram(setCode: (code: number) => void): Command {
  const program = new Command();
  program.name("flaky-test-scorer").exitOverride();

  const withCommonOptions = (cmd: Command): Command =>
    cmd
      .argument("<globs-or-paths...>")
      .option("--history <file>")
      .option("--commit <sha>")
      .option("--json", "", false)
      .option("--metric <name>")
      .option("--model <name>")
      .option("--lam <n>")
      .option("--min-reruns <n>")
      .option("--top <n>")
      .option("--explain", "", false)
      .option("--provider <name>")
      .option("--explain-top <n>")
      // Declared on both commands so `analyze --fail-above` gets the "use ci"
      // message instead of a generic unknown-option error.
      .option("--fail-above <n>")
      .option("--format <name>")
      .option("--baseline <file>");

  for (const name of ["analyze", "ci"] as const) {
    withCommonOptions(program.command(name)).action(async (inputs: string[], values: ReportOptions) => {
      setCode(await runReport(name, inputs, values));
    });
  }

  program
    .command("baseline")
    .command("update")
    .argument("<globs-or-paths...>")
    .option("--history <file>")
    .option("--commit <sha>")
    .option("--baseline <file>")
    .option("--metric <name>")
    .option("--model <name>")
    .option("--lam <n>")
    .option("--min-reruns <n>")
    .action(async (inputs: string[], values: ReportOptions) => {
      setCode(await runBaselineUpdate(inputs, values));
    });

  const history = program.command("history");
  history
    .command("merge")
    .argument("<jsonl...>")
    .option("--history <file>")
    .action((inputs: string[], values: { history?: string }) => {
      setCode(runHistoryMerge(inputs, values));
    });
  history
    .command("prune")
    .option("--history <file>")
    .option("--keep-days <n>")
    .option("--keep-runs-per-test <n>")
    .action((values: { history?: string; keepDays?: string; keepRunsPerTest?: string }) => {
      setCode(runHistoryPrune(values));
    });

  // Lazy import: the MCP SDK is only paid for when the server is actually run,
  // and it keeps this file independent of src/mcp's build state.
  program.command("mcp").action(async () => {
    const { runMcpServer } = await import("../mcp/index.js");
    await runMcpServer();
    setCode(0);
  });

  const auth = program.command("auth");
  auth.command("status").action(async () => setCode(await runAuthStatus()));
  auth
    .command("set-key")
    .argument("<provider>")
    .option("--key <k>", "the key; omit it and the key is read from stdin (keeps it out of shell history)")
    .action(async (provider: string, values: { key?: string }) => {
      const name = asProvider(provider, "provider");
      const key = values.key ?? readKeyFromStdin();
      const { setKey } = await loadAi();
      writeConfig(() => setKey(name, key));
      process.stdout.write(`stored ${provider} key\n`);
    });
  auth
    .command("clear")
    .argument("<provider>")
    .action(async (provider: string) => {
      const name = asProvider(provider, "provider");
      const { clearKey } = await loadAi();
      writeConfig(() => clearKey(name));
      process.stdout.write(`cleared ${provider} key\n`);
    });

  // Configured after the subcommands exist so only the top-level help is replaced
  // by the v1 usage text; `analyze --help` keeps Commander's generated help.
  program.configureHelp({ formatHelp: () => `${USAGE}\n` });
  return program;
}

export async function run(argv: string[]): Promise<number> {
  let code = 0;
  const program = buildProgram((c) => {
    code = c;
  });

  if (argv.length === 0) {
    // Usage-as-error goes to stderr like every other exit-2 path; stdout stays clean.
    process.stderr.write(`error: no command given\n\n${USAGE}\n`);
    return 2;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (err) {
    // Commander exits 1 on usage errors by default, which collides with
    // "threshold exceeded"; exitOverride routes every one of them here instead.
    // exitCode 0 is Commander's "I printed help/version on request"; anything else
    // (unknown option, missing argument, `auth` with no subcommand) is a usage error.
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
    // Everything else lands on exit 2 too. An unexpected throw (unwritable history
    // dir, EACCES) used to escape and take Node's default exit 1.
    const detail = err instanceof InputError ? err.message : ((err as Error).stack ?? String(err));
    process.stderr.write(`error: ${detail}\n`);
    return 2;
  }
}
