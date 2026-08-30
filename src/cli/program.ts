import { Command, CommanderError } from "commander";
import { InputError } from "../ingest.js";
import { runReport } from "./analyze.js";
import { runBaselineUpdate } from "./baseline.js";
import { runHistoryMerge, runHistoryPrune } from "./history.js";
import { USAGE } from "./usage.js";
import type {ReportOptions} from "./options.js";

function buildProgram(setCode: (code: number) => void): Command {
  const program = new Command();
  program.name("flaky-test-scorer").exitOverride();

  // The ingest/score options shared by analyze, ci and baseline update.
  const withScoreOptions = (cmd: Command): Command =>
    cmd
      .argument("<globs-or-paths...>")
      .option("--history <file>")
      .option("--commit <sha>")
      .option("--baseline <file>")
      .option("--metric <name>")
      .option("--model <name>")
      .option("--lam <n>")
      .option("--min-reruns <n>");

  const withCommonOptions = (cmd: Command): Command =>
    withScoreOptions(cmd)
      .option("--json", "", false)
      .option("--top <n>")
      .option("--explain", "", false)
      .option("--provider <name>")
      .option("--explain-top <n>")
      // Declared on both commands so `analyze --fail-above` gets the "use ci"
      // message instead of a generic unknown-option error.
      .option("--fail-above <n>")
      .option("--format <name>");

  for (const name of ["analyze", "ci"] as const) {
    withCommonOptions(program.command(name)).action(async (inputs: string[], values: ReportOptions) => {
      setCode(await runReport(name, inputs, values));
    });
  }

  withScoreOptions(program.command("baseline").command("update")).action(
    async (inputs: string[], values: ReportOptions) => {
      setCode(await runBaselineUpdate(inputs, values));
    },
  );

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

  // Configured after the subcommands exist so only the top-level help is replaced
  // by the custom usage text; `analyze --help` keeps Commander's generated help.
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
