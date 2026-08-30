import {appendFileSync} from "node:fs";
import {
    appendHistory,
    detectCommit,
    expandInputs,
    InputError,
    loadRuns,
    readBaseline,
    readHistory,
    warnCorrupt,
} from "../ingest.js";
import {buildReport, isWithinBaseline, renderGithub, renderHuman, renderMarkdown, type Report,} from "../report.js";
import {groupByTestAndVersion} from "../score.js";
import {numberOption, parseScoreParams, type ReportOptions, type ScoreParams} from "./options.js";

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
        const {runs: existing, corruptLines} = readHistory(values.history);
        warnCorrupt(corruptLines, values.history);
        runs = appendHistory(values.history, existing, runs);
    }

    return {report: buildReport(groupByTestAndVersion(runs), params), files};
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

    if (command === "ci" && failAbove === null) {
        process.stderr.write(
            "warning: ci without --fail-above never fails the build; add --fail-above <n> to gate on it\n",
        );
    }
    if (command === "analyze") {
        const ciOnly = (flag: string) =>
            new InputError(`--${flag} is only supported by the "ci" command; use "ci" instead of "analyze"`);
        if (values.failAbove !== undefined) throw ciOnly("fail-above");
        if (values.format !== undefined && values.format !== "markdown") throw ciOnly("format");
        if (values.baseline !== undefined) throw ciOnly("baseline");
    }
    // A missing baseline file is an empty baseline (first run in a fresh repo); a
    // corrupt one is an input error, because silently gating on nothing is worse.
    const baseline = values.baseline === undefined ? null : readBaseline(values.baseline);

    const {report, files} = loadReport(inputs, values, params);
    const overThreshold = failAbove === null ? [] : report.tests.filter((t) => t.gating_score > failAbove);
    const baselinedBreaches = overThreshold.filter((t) => baseline !== null && isWithinBaseline(t, baseline));
    const newBreaches = overThreshold.filter((t) => baseline === null || !isWithinBaseline(t, baseline));


    if (!values.json && values.format !== 'markdown') {
        process.stdout.write(`${renderHuman(report, top, files.length, baseline)}\n`);
    }

    if (values.json) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    ...report,
                    ...(baseline
                        ? {
                            baselined_breaches: baselinedBreaches.map((t) => ({
                                test_id: t.test_id,
                                gating_score: t.gating_score,
                            })),
                        }
                        : {}),
                },
                null,
                2,
            )}\n`,
        );
    } else if (values.format === "markdown") {
        process.stdout.write(renderMarkdown(report, top, baseline));
    }

    if (command === "ci" && values.format === "github") {
        const {annotations, markdown} = renderGithub(report, baseline);
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
                baselinedBreaches.map((t) => `  ${t.test_id} — ${t.gating_score}`).join("\n") +
                "\n",
            );
        }
        if (newBreaches.length > 0) {
            process.stderr.write(
                `\n${newBreaches.length} test(s) above --fail-above ${failAbove} (by gating_score):\n` +
                newBreaches.map((t) => `  ${t.test_id} — ${t.gating_score}`).join("\n") +
                "\n",
            );
            return 1;
        }
    }
    return 0;
}
