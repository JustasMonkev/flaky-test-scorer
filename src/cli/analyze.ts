import { appendFileSync } from "node:fs";
import type { ProviderName } from "../ai/index.js";
import {
  InputError,
  appendHistory,
  detectCommit,
  expandInputs,
  loadRuns,
  readBaseline,
  readHistory,
  warnCorrupt,
} from "../ingest.js";
import { buildReport, flakyRanked, renderGithub, renderHuman, renderMarkdown, type Report } from "../report.js";
import { groupByTestAndVersion } from "../score.js";
import { loadAi } from "./lazy-ai.js";
import { numberOption, parseProvider, parseScoreParams, type ReportOptions, type ScoreParams } from "./options.js";

interface AiAnalysis {
  provider: ProviderName;
  model: string;
  per_test: { test_id: string; analysis: string }[];
  heuristic: false;
}

/**
 * Explain is strictly additive: a missing key, a refusal or a dead provider warns and
 * returns null. Letting it throw would turn `ci --fail-above` (exit 1) or a clean run
 * (exit 0) into an exit 2, which the contract reserves for bad input.
 */
async function tryExplain(
  report: Report,
  chosen: ProviderName | undefined,
  top: number,
  baseline: ReadonlySet<string> | null,
): Promise<AiAnalysis | null> {
  try {
    const { requireProvider, explain } = await loadAi();
    const provider = requireProvider(chosen);
    // Newly-flaky first: the explain budget is paid per test, and a repo with a
    // dozen baselined tests spent all of it on flakiness the user already accepted.
    const tests = flakyRanked(report, baseline).slice(0, top);
    if (tests.length === 0) return null;
    const result = await explain(provider, { tests });
    return {
      provider: result.provider,
      model: result.model,
      per_test: result.perTest,
      heuristic: false,
    };
  } catch (err) {
    process.stderr.write(`warning: --explain failed: ${(err as Error).message}\n`);
    return null;
  }
}

function renderAi(ai: AiAnalysis): string {
  const out = ["", `AI analysis (${ai.provider}) — model ${ai.model}; hypotheses, not deterministic evidence`];
  for (const entry of ai.per_test) {
    out.push("", `    ${entry.test_id}`);
    for (const line of entry.analysis.split("\n")) out.push(`      ${line}`);
  }
  return out.join("\n");
}

/** Ingest (optionally folding into history) and score — shared by analyze/ci/baseline. */
export function loadReport(
  inputs: string[],
  values: ReportOptions,
  params: ScoreParams,
): { report: Report; files: string[] } {
  const files = expandInputs(inputs);
  const version = values.commit ?? detectCommit();
  let runs = loadRuns(files, version);

  if (values.history) {
    const { runs: existing, corruptLines } = readHistory(values.history);
    warnCorrupt(corruptLines, values.history);
    runs = appendHistory(values.history, existing, runs);
  }

  return { report: buildReport(groupByTestAndVersion(runs), params), files };
}

export async function runReport(
  command: "analyze" | "ci",
  inputs: string[],
  values: ReportOptions,
): Promise<number> {
  const params = parseScoreParams(values);
  const top = numberOption(values.top, "top", 10);
  const failAbove = values.failAbove === undefined ? null : numberOption(values.failAbove, "fail-above", 0);
  if (values.format !== undefined && values.format !== "github" && values.format !== "markdown") {
    throw new InputError(`--format must be github or markdown, got "${values.format}"`);
  }
  // Both write to stdout and only one can own it; silently picking a winner would
  // hand a PR-comment pipeline a JSON blob (or vice versa) with exit 0.
  if (values.format === "markdown" && values.json) {
    throw new InputError("--format markdown and --json are mutually exclusive");
  }
  // Validated up here, not inside tryExplain: a bad flag value is a usage error
  // (exit 2), only a failing *provider* is allowed to degrade to a warning.
  const provider = parseProvider(values.provider);
  const explainTop = Math.max(0, numberOption(values.explainTop, "explain-top", 3));
  // Silently ignored flags read as "it ran and found nothing worth explaining".
  if (!values.explain) {
    if (values.provider !== undefined) {
      process.stderr.write("warning: --provider has no effect without --explain\n");
    }
    if (values.explainTop !== undefined) {
      process.stderr.write("warning: --explain-top has no effect without --explain\n");
    }
  }
  if (command === "ci" && failAbove === null) {
    process.stderr.write(
      "warning: ci without --fail-above never fails the build; add --fail-above <n> to gate on it\n",
    );
  }
  if (command === "analyze") {
    // These are ci-only. Accepting them silently made `analyze --fail-above` a
    // permanently green CI gate. `--format markdown` is the exception: a rendering
    // choice, not a CI gate — SPEC-V3 F7 puts it on both commands.
    const ciOnly = (flag: string) =>
      new InputError(`--${flag} is only supported by the "ci" command; use "ci" instead of "analyze"`);
    if (values.failAbove !== undefined) throw ciOnly("fail-above");
    if (values.format !== undefined && values.format !== "markdown") throw ciOnly("format");
    if (values.baseline !== undefined) throw ciOnly("baseline");
  }
  // A missing baseline file is an empty baseline (first run in a fresh repo); a
  // corrupt one is an input error, because silently gating on nothing is worse.
  const baseline = values.baseline === undefined ? null : readBaseline(values.baseline);

  const { report, files } = loadReport(inputs, values, params);
  const ai = values.explain ? await tryExplain(report, provider, explainTop, baseline) : null;

  const overThreshold =
    failAbove === null ? [] : report.tests.filter((t) => t.lower_bound_score > failAbove);
  const baselinedBreaches = overThreshold.filter((t) => baseline?.has(t.test_id));
  const newBreaches = overThreshold.filter((t) => !baseline?.has(t.test_id));

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...report,
          ...(baseline
            ? {
                baselined_breaches: baselinedBreaches.map((t) => ({
                  test_id: t.test_id,
                  lower_bound_score: t.lower_bound_score,
                })),
              }
            : {}),
          ...(ai ? { ai_analysis: ai } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else if (values.format === "markdown") {
    // Comment body only — stdout is piped straight into `gh api`. --explain is
    // still honoured (otherwise the provider call would be paid for and thrown
    // away), but collapsed, so hypotheses never outrank the evidence table.
    process.stdout.write(renderMarkdown(report, top, baseline));
    if (ai) {
      process.stdout.write(
        `\n<details><summary>AI analysis (${ai.provider}) — hypotheses, not evidence</summary>\n\n` +
          ai.per_test.map((e) => `**${e.test_id}**\n\n${e.analysis}\n`).join("\n") +
          "\n</details>\n",
      );
    }
  } else {
    process.stdout.write(`${renderHuman(report, top, files.length, baseline)}\n`);
    if (ai) process.stdout.write(`${renderAi(ai)}\n`);
  }

  if (command === "ci" && values.format === "github") {
    const { annotations, markdown } = renderGithub(report, baseline);
    // Under --json, stdout is the machine payload and must stay parseable. GitHub
    // picks workflow commands off stderr just as well, so annotations move there.
    const stream = values.json ? process.stderr : process.stdout;
    for (const line of annotations) stream.write(`${line}\n`);
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    // Best-effort: the job summary is cosmetic, so an unwritable path warns
    // instead of failing the step (exit 2 is for bad input, not decoration).
    if (summaryPath) {
      try {
        appendFileSync(summaryPath, `${markdown}\n`, "utf8");
      } catch (err) {
        process.stderr.write(`warning: could not write $GITHUB_STEP_SUMMARY (${summaryPath}): ${(err as Error).message}\n`);
      }
    }
  }

  if (command === "ci" && failAbove !== null) {
    if (baselinedBreaches.length > 0) {
      process.stderr.write(
        `\nbaselined (known flaky): ${baselinedBreaches.length} test${baselinedBreaches.length === 1 ? "" : "s"}\n` +
          baselinedBreaches.map((t) => `  ${t.test_id} — ${t.lower_bound_score}`).join("\n") +
          "\n",
      );
    }
    if (newBreaches.length > 0) {
      process.stderr.write(
        `\n${newBreaches.length} test(s) above --fail-above ${failAbove} (by lower_bound_score):\n` +
          newBreaches.map((t) => `  ${t.test_id} — ${t.lower_bound_score}`).join("\n") +
          "\n",
      );
      return 1;
    }
  }
  return 0;
}
