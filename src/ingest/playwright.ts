import { createHash } from "node:crypto";
import type { RunRecord } from "../score.js";
import { asArray, joinTestId, numberOrNull, type XmlNode } from "./common.js";

function isXmlNode(value: unknown): value is XmlNode {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `--reporter json` output: an object whose `suites` is an array. Shape, not filename. */
export function isPlaywrightReport(data: unknown): boolean {
  return isXmlNode(data) && Array.isArray(data["suites"]);
}

/** Playwright result status -> pass / fail / drop (skipped or interrupted). */
function playwrightResult(status: unknown): boolean | null {
  const value = String(status ?? "").toLowerCase();
  if (value === "passed") return true;
  if (value === "" || value === "skipped" || value === "interrupted") return null;
  return false; // failed, timedOut, crashed
}

function playwrightError(result: XmlNode): string | null {
  const rawSingle = result["error"];
  const single = isXmlNode(rawSingle) ? rawSingle["message"] : undefined;
  if (typeof single === "string" && single.trim()) return single.slice(0, 2000);
  const many = asArray(result["errors"])
    .map((e) => (typeof e["message"] === "string" ? e["message"] : ""))
    .filter(Boolean);
  return many.length > 0 ? many.join(" | ").slice(0, 2000) : null;
}

const executionId = (value: unknown): string =>
  `pw:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;

function walkPlaywrightSuite(
  suite: XmlNode,
  specFile: string,
  titles: string[],
  file: string,
  version: string | null,
  out: RunRecord[],
  executionCount: { value: number },
): void {
  const here = typeof suite["file"] === "string" && suite["file"] ? suite["file"] : specFile;

  for (const spec of asArray(suite["specs"])) {
    const specTitle = String(spec["title"] ?? "").trim();
    for (const test of asArray(spec["tests"])) {
      const ordinal = executionCount.value++;
      const project = String(test["projectName"] ?? "").trim();
      // Same " > " join as the JUnit ids so one history can hold both.
      const testId = joinTestId([here, project, ...titles, specTitle]);
      if (!testId) continue;

      const attempts = asArray(test["results"])
        .map((result) => ({ result, outcome: playwrightResult(result["status"]) }))
        .filter((a): a is { result: XmlNode; outcome: boolean } => a.outcome !== null);
      const signature = attempts.map(({ result, outcome }) => [
        result["retry"],
        result["startTime"],
        result["workerIndex"],
        result["parallelIndex"],
        outcome,
      ]);
      const id = executionId([file, spec["id"] ?? "", ordinal, signature]);

      attempts.forEach(({ result, outcome }, i) => {
        const duration = numberOrNull(result["duration"]);
        out.push({
          test_id: testId,
          result: outcome,
          version,
          timestamp: typeof result["startTime"] === "string" ? result["startTime"] : null,
          duration_s: duration === null ? null : duration / 1000,
          failure_message: outcome ? null : playwrightError(result),
          source_file: file,
          attempt: numberOrNull(result["retry"]) ?? i,
          execution_id: id,
        });
      });
    }
  }

  for (const child of asArray(suite["suites"])) {
    const title = String(child["title"] ?? "").trim();
    walkPlaywrightSuite(child, here, title ? [...titles, title] : titles, file, version, out, executionCount);
  }
}

export function parsePlaywrightReport(
  data: unknown,
  file: string,
  version: string | null,
): RunRecord[] {
  const out: RunRecord[] = [];
  const executionCount = { value: 0 };
  const root = isXmlNode(data) ? data : {};
  for (const suite of asArray(root["suites"])) {
    // Top-level suites are per-file: their title IS the file, so it must not also
    // be pushed onto the describe-title trail.
    const specFile = String(suite["file"] ?? suite["title"] ?? "").trim();
    walkPlaywrightSuite(suite, specFile, [], file, version, out, executionCount);
  }
  return out;
}
