import type { ExplainInput } from "./types.js";

const PREAMBLE = `You are analyzing flaky tests. Below is a JSON evidence bundle produced by a
deterministic scorer: per-test flakiness scores, confidence, transition/variance evidence,
failure-message clusters and a keyword-heuristic likely cause.

For each test, explain the likely root causes of the flakiness and what to investigate first.
Be concrete and reference the evidence. At most 5 sentences per test. State your uncertainty
plainly where the evidence is thin. Do not invent evidence that is not in the bundle.

Format your answer as one section per test, starting with a line "## <test_id>".`;

export function buildPrompt(input: ExplainInput): string {
  return `${PREAMBLE}\n\n\`\`\`json\n${JSON.stringify(input.tests, null, 2)}\n\`\`\``;
}

export function testIds(input: ExplainInput): string[] {
  return input.tests
    .map((test) => {
      if (typeof test !== "object" || test === null || !("test_id" in test)) return undefined;
      const id = test.test_id;
      return typeof id === "string" ? id : undefined;
    })
    .filter((id): id is string => typeof id === "string");
}

/** Split the model's prose back into per-test sections by "## <test_id>" headers. */
export function splitByTest(text: string, ids: string[]): { test_id: string; analysis: string }[] {
  const out: { test_id: string; analysis: string }[] = [];
  let current: { test_id: string; analysis: string } | undefined;
  for (const line of text.split("\n")) {
    const header = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    const heading = header?.[1];
    const id = heading
      ? ids.find((i) => heading === i) ??
        ids.filter((i) => heading.includes(i)).sort((a, b) => b.length - a.length)[0]
      : undefined;
    if (id) {
      current = { test_id: id, analysis: "" };
      out.push(current);
    } else if (current) {
      current.analysis += `${line}\n`;
    }
  }
  for (const entry of out) entry.analysis = entry.analysis.trim();
  if (out.length > 0) return out.filter((e) => e.analysis !== "");
  // Model ignored the format: hand the whole answer to the first test rather than lose it.
  return ids.length > 0 ? [{ test_id: ids[0]!, analysis: text.trim() }] : [];
}
