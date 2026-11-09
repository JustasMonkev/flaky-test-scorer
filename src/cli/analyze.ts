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
import {buildReport, isWithinBaseline, renderGithub, renderHuman, renderMarkdown, type BuildOptions, type Report} from "../report.js";
import {groupByTestAndVersion} from "../score.js";
import {numberOption, parseScoreParams, type ReportOptions} from "./options.js";

export function loadReport(
    inputs: string[],
    values: ReportOptions,
    params: BuildOptions,
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

export function runReport(
    command: "analyze" | "ci",
    inputs: string[],
    values: ReportOptions,
): number {
    const params = parseScoreParams(values);
    const top = numberOption(values.top, "top", 10);
    const failAbove = values.failAbove === undefined ? null : numberOption(values.failAbove, "fail-above", 0);
    if (values.format !== undefined && values.format !== "github" && values.format !== "markdown") {
        throw new InputError(`--format must be github or markdown, got "${values.format}"`);
    }
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
    const baseline = values.baseline === undefined ? null : readBaseline(values.baseline);

    const {report, files} = loadReport(inputs, values, params);
    const baselinedBreaches: Report["tests"] = [];
    const newBreaches: Report["tests"] = [];
    if (failAbove !== null) {
        for (const test of report.tests) {
            if (test.gating_score > failAbove) {
                const breaches = baseline && isWithinBaseline(test, baseline) ? baselinedBreaches : newBreaches;
                breaches.push(test);
            }
        }
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
    } else {
        process.stdout.write(`${renderHuman(report, top, files.length, baseline)}\n`);
    }

    if (command === "ci" && values.format === "github") {
        const {annotations, markdown} = renderGithub(report, baseline);
        const stream = values.json ? process.stderr : process.stdout;
        for (const line of annotations) stream.write(`${line}\n`);
        const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
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
