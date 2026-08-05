import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { RunRecord } from "../score.js";
import {
  InputError,
  asArray,
  cleanTestId,
  normalizeResult,
  numberOrNull,
  stripBom,
  type XmlNode,
} from "./common.js";

// Maven Surefire retry children: each one is a separate failed attempt.
const RETRY_TAGS = ["flakyFailure", "flakyError", "rerunFailure", "rerunError"] as const;

const ARRAY_TAGS = new Set(["testsuite", "testcase", "failure", "error", "skipped", ...RETRY_TAGS]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

function collectSuites(node: XmlNode, out: XmlNode[]): void {
  // Any node carrying <testcase> children counts, including <testsuites> (or the
  // document root) with no intermediate <testsuite> wrapper — writers emit that.
  if (node["testcase"] !== undefined) out.push(node);
  for (const suite of asArray(node["testsuite"])) collectSuites(suite, out);
  for (const suites of asArray(node["testsuites"])) collectSuites(suites, out);
}

function nodeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (node && typeof node === "object") {
    const n = node as XmlNode;
    return [n["@_message"], n["@_type"], n["#text"]].filter(Boolean).map(String).join(": ");
  }
  return "";
}

export function parseJUnit(xml: string, file: string, version: string | null): RunRecord[] {
  const text = stripBom(xml);
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw new InputError(
      `malformed XML in ${file}: ${valid.err.msg} (line ${valid.err.line}). ` +
        `Check that the file is a complete JUnit report — truncated uploads are the usual cause.`,
    );
  }

  const root = xmlParser.parse(text) as XmlNode;
  const suites: XmlNode[] = [];
  collectSuites(root, suites);

  const runs: RunRecord[] = [];
  for (const suite of suites) {
    const suiteTimestamp = (suite["@_timestamp"] as string | undefined) ?? null;
    for (const testcase of asArray(suite["testcase"])) {
      if (testcase["skipped"] !== undefined) continue;
      const name = String(testcase["@_name"] ?? "").trim();
      const classname = String(testcase["@_classname"] ?? "").trim();
      const testId = cleanTestId(classname ? (name ? `${classname} > ${name}` : classname) : name);
      if (!testId) continue;

      const failures = [...asArray(testcase["failure"]), ...asArray(testcase["error"])];
      // Some writers only set status="failed"/"error" and emit no <failure> child.
      const failed = failures.length > 0 || normalizeResult(testcase["@_status"]) === false;
      const message = failed
        ? failures.map(nodeText).filter(Boolean).join(" | ").slice(0, 2000) || "failure"
        : null;

      const base = {
        test_id: testId,
        version,
        timestamp: suiteTimestamp,
        source_file: file,
      };
      // Surefire records each retry as its own child element; the <testcase> itself
      // carries the FINAL outcome. Emitting attempts as ordered runs is what lets
      // flipRate / within_version_flips see a same-commit flip at all.
      const retries = RETRY_TAGS.flatMap((tag) => asArray(testcase[tag]));
      retries.forEach((retry, i) => {
        runs.push({
          ...base,
          result: false,
          // @_time on the testcase is the final attempt's duration, so attributing it
          // to a retry would distort duration_variance.
          duration_s: null,
          failure_message: nodeText(retry).slice(0, 2000) || "failure",
          attempt: i,
        });
      });

      runs.push({
        ...base,
        result: !failed,
        duration_s: numberOrNull(testcase["@_time"]),
        failure_message: message,
        ...(retries.length > 0 ? { attempt: retries.length } : {}),
      });
    }
  }
  return runs;
}
