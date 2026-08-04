import type { RunRecord } from "../score.js";
import { cleanTestId, firstValue, normalizeResult, numberOrNull, stripBom } from "./common.js";

/** Minimal RFC4180-ish CSV reader (quotes, embedded commas/newlines, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = stripBom(text);

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((key, i) => [key.trim(), r[i] ?? ""])));
}

/** Normalize alias-bearing row objects (from JSON or CSV) into runs. */
export function runsFromRows(
  rows: unknown[],
  file: string,
  fallbackVersion: string | null,
): RunRecord[] {
  const runs: RunRecord[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;

    const testId = firstValue(row, ["test_id", "test", "name", "testId", "id"]);
    const resultRaw = firstValue(row, ["result", "status", "outcome"]);
    if (testId === null || resultRaw === null) continue;
    const result = normalizeResult(resultRaw);
    if (result === null) continue;
    const cleanId = cleanTestId(String(testId));
    if (cleanId === "") continue;

    const version = firstValue(row, ["version"]);
    const timestamp = firstValue(row, ["timestamp", "time", "date"]);
    const failureMessage = firstValue(row, ["failure_message", "message", "error"]);
    const sourceFile = row["source_file"];
    const attempt = numberOrNull(row["attempt"]);
    runs.push({
      test_id: cleanId,
      result,
      version: version === null ? fallbackVersion : String(version),
      timestamp: typeof timestamp === "string" || typeof timestamp === "number" ? timestamp : null,
      duration_s: numberOrNull(firstValue(row, ["duration_s", "duration", "elapsed"])),
      failure_message: typeof failureMessage === "string" ? failureMessage : null,
      source_file: typeof sourceFile === "string" ? sourceFile : file,
      // Kept only when present, so v1 history lines round-trip byte-identically.
      ...(attempt === null ? {} : { attempt }),
    });
  }
  return runs;
}
