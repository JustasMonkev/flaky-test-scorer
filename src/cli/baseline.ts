import { writeBaseline } from "../ingest.js";
import { loadReport } from "./analyze.js";
import { DEFAULT_BASELINE, parseScoreParams, type ReportOptions } from "./options.js";

export async function runBaselineUpdate(inputs: string[], values: ReportOptions): Promise<number> {
  const params = parseScoreParams(values);
  const path = values.baseline ?? DEFAULT_BASELINE;
  const { report } = loadReport(inputs, values, params);
  const written = writeBaseline(path, report.tests);
  process.stdout.write(`wrote ${written.length} known-flaky test(s) to ${path}\n`);
  return 0;
}
