// Ingest entry point. The parsers, the history store and the baseline store live
// in ./ingest/*; this file is the public surface they are re-exported through.

export { InputError, cleanTestId, joinTestId, normalizeResult, warnCorrupt } from "./ingest/common.js";
export { expandInputs } from "./ingest/inputs.js";
export { parseJUnit } from "./ingest/junit.js";
export { parseCsv, runsFromRows } from "./ingest/rows.js";
export { isPlaywrightReport, parsePlaywrightReport } from "./ingest/playwright.js";
export { detectCommit, loadFile, loadRuns } from "./ingest/load.js";
export {
  appendHistory,
  chronological,
  dedupAgainst,
  mergeHistories,
  pruneRuns,
  readHistory,
  writeHistory,
  type HistoryRead,
  type PruneOptions,
} from "./ingest/history.js";
export { readBaseline, writeBaseline, type BaselineEntry } from "./ingest/baseline.js";
