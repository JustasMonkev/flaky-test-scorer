import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEvidence, classify, durationStats, normalizeMessage, recommendationFor } from "../src/evidence.js";
import { expandInputs, loadRuns } from "../src/ingest.js";
import { groupByTestAndVersion, type RunRecord } from "../src/score.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

function run(partial: Partial<RunRecord> & { test_id: string; result: boolean }): RunRecord {
  return {
    version: null,
    timestamp: null,
    duration_s: null,
    failure_message: null,
    source_file: null,
    ...partial,
  };
}

describe("message normalization", () => {
  it("strips numbers, durations, hex and paths so messages cluster", () => {
    expect(normalizeMessage("Timeout 30000ms exceeded at /app/tests/checkout.spec.ts:41")).toBe(
      "Timeout <dur> exceeded at <path>:<n>",
    );
    expect(normalizeMessage("expected 3 to equal 4")).toBe("expected <n> to equal <n>");
    expect(normalizeMessage("id 0xDEADBEEF vs a1b2c3d4e5")).toBe("id <hex> vs <hex>");
  });

  it("collapses whitespace so multi-line stacks group together", () => {
    expect(normalizeMessage("a\n   b\tc ")).toBe("a b c");
  });
});

describe("likely-cause classification", () => {
  it("reaches high confidence when one category dominates with >=3 samples", () => {
    expect(
      classify([
        "Timeout 30000ms exceeded",
        "Test timed out after 5s",
        "ETIMEDOUT waiting for response",
      ]),
    ).toEqual({ category: "timeout", confidence: "high", matched_messages: 3, heuristic: true });
  });

  it("drops to medium with only two samples", () => {
    const cause = classify(["connect ECONNREFUSED 127.0.0.1:5432", "socket hang up"]);
    expect(cause.category).toBe("network");
    expect(cause.confidence).toBe("medium");
  });

  it("drops to low when the failures are split across categories", () => {
    const cause = classify([
      "Timeout 30000ms exceeded",
      "expected 3 to equal 4",
      "out of memory",
      "stale element reference",
    ]);
    expect(cause.confidence).toBe("low");
  });

  it("classifies the remaining categories", () => {
    expect(classify(["element not visible"]).category).toBe("element");
    expect(classify(["unhandled rejection in worker"]).category).toBe("race");
    expect(classify(["ENOSPC: no space left on device"]).category).toBe("resource");
    expect(classify(["AssertionError: expected 1 to equal 2"]).category).toBe("assertion");
  });

  it("falls back to unknown/low with no usable signal", () => {
    expect(classify([])).toEqual({ category: "unknown", confidence: "low", matched_messages: 0, heuristic: true });
    expect(classify(["boom"]).category).toBe("unknown");
  });

  it("has a deterministic recommendation per category", () => {
    expect(recommendationFor("timeout")).toMatch(/stub/i);
    expect(recommendationFor("unknown")).toMatch(/isolation/i);
    expect(recommendationFor("assertion")).not.toBe(recommendationFor("network"));
  });
});

describe("evidence from a real fixture suite", () => {
  const grouped = groupByTestAndVersion(loadRuns(expandInputs([join(fixtures, "suite")]), "v1"));
  const durations = durationStats(grouped);

  it("counts transitions and total runs", () => {
    const { evidence } = buildEvidence(
      "checkout > applies promo code",
      grouped.get("checkout > applies promo code")!,
      durations,
    );
    expect(evidence.transitions).toEqual({ flips: 3, total_runs: 4 });
  });

  it("counts versions that both pass and fail (fails on unchanged commit)", () => {
    const { evidence } = buildEvidence(
      "checkout > applies promo code",
      grouped.get("checkout > applies promo code")!,
      durations,
    );
    expect(evidence.within_version_flips).toBe(1);

    const stable = buildEvidence("checkout > renders cart", grouped.get("checkout > renders cart")!, durations);
    expect(stable.evidence.within_version_flips).toBe(0);
  });

  it("reports duration variance as a ratio to the suite median CV", () => {
    const { evidence } = buildEvidence(
      "checkout > applies promo code",
      grouped.get("checkout > applies promo code")!,
      durations,
    );
    expect(evidence.duration_variance!.cv).toBeCloseTo(0.9399, 3);
    expect(evidence.duration_variance!.ratio).toBeGreaterThan(2);
  });

  it("clusters failure messages by normalized text", () => {
    const { evidence, likely_cause } = buildEvidence(
      "checkout > applies promo code",
      grouped.get("checkout > applies promo code")!,
      durations,
    );
    expect(evidence.failure_clusters).toHaveLength(1);
    expect(evidence.failure_clusters[0]!.count).toBe(2);
    expect(evidence.failure_clusters[0]!.pattern).toContain("<dur>");
    expect(likely_cause.category).toBe("timeout");
  });
});

describe("duration variance edge cases", () => {
  it("is null when durations are missing or a single sample", () => {
    const grouped = groupByTestAndVersion([
      run({ test_id: "a", result: true, duration_s: 1 }),
      run({ test_id: "b", result: true }),
    ]);
    const durations = durationStats(grouped);
    expect(durations.suiteMedian).toBe(null);
    expect(buildEvidence("a", grouped.get("a")!, durations).evidence.duration_variance).toBe(null);
  });
});
