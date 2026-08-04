import type { RunRecord } from "../score.js";
import { asArray, cleanTestId, numberOrNull, type XmlNode } from "./common.js";

/** `--reporter json` output: an object whose `suites` is an array. Shape, not filename. */
export function isPlaywrightReport(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as Record<string, unknown>)["suites"])
  );
}

/** Playwright result status -> pass / fail / drop (skipped). */
function playwrightResult(status: unknown): boolean | null {
  const value = String(status ?? "").toLowerCase();
  if (value === "passed") return true;
  if (value === "" || value === "skipped") return null;
  return false; // failed, timedOut, interrupted, crashed
}

function playwrightError(result: XmlNode): string | null {
  const single = (result["error"] as { message?: unknown } | undefined)?.message;
  if (typeof single === "string" && single.trim()) return single.slice(0, 2000);
  const many = asArray(result["errors"])
    .map((e) => (typeof e["message"] === "string" ? e["message"] : ""))
    .filter(Boolean);
  return many.length > 0 ? many.join(" | ").slice(0, 2000) : null;
}

function walkPlaywrightSuite(
  suite: XmlNode,
  specFile: string,
  titles: string[],
  file: string,
  version: string | null,
  out: RunRecord[],
): void {
  const here = typeof suite["file"] === "string" && suite["file"] ? suite["file"] : specFile;

  for (const spec of asArray(suite["specs"])) {
    const specTitle = String(spec["title"] ?? "").trim();
    for (const test of asArray(spec["tests"])) {
      const project = String(test["projectName"] ?? "").trim();
      // Same " > " join as the JUnit ids so one history can hold both.
      const testId = cleanTestId([here, project, ...titles, specTitle].filter((p) => p !== "").join(" > "));
      if (!testId) continue;

      const attempts = asArray(test["results"])
        .map((result) => ({ result, outcome: playwrightResult(result["status"]) }))
        .filter((a): a is { result: XmlNode; outcome: boolean } => a.outcome !== null);

      attempts.forEach(({ result, outcome }, i) => {
        const duration = numberOrNull(result["duration"]);
        out.push({
          test_id: testId,
          result: outcome,
          version,
          timestamp: (result["startTime"] as string | undefined) ?? null,
          duration_s: duration === null ? null : duration / 1000,
          failure_message: outcome ? null : playwrightError(result),
          source_file: file,
          ...(attempts.length > 1 ? { attempt: numberOrNull(result["retry"]) ?? i } : {}),
        });
      });
    }
  }

  for (const child of asArray(suite["suites"])) {
    const title = String(child["title"] ?? "").trim();
    walkPlaywrightSuite(child, here, title ? [...titles, title] : titles, file, version, out);
  }
}

export function parsePlaywrightReport(
  data: unknown,
  file: string,
  version: string | null,
): RunRecord[] {
  const out: RunRecord[] = [];
  for (const suite of asArray((data as XmlNode)["suites"])) {
    // Top-level suites are per-file: their title IS the file, so it must not also
    // be pushed onto the describe-title trail.
    const specFile = String(suite["file"] ?? suite["title"] ?? "").trim();
    walkPlaywrightSuite(suite, specFile, [], file, version, out);
  }
  return out;
}
