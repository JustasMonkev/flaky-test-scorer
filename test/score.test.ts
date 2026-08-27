import { describe, expect, it } from "vitest";
import {
  aggregateUnweighted,
  aggregateWeighted,
  countIndependentRuns,
  confidence,
  entropy,
  flipRate,
  groupByTestAndVersion,
  groupIndependentRuns,
  round4,
  scoreTests,
  timestampKey,
  verdict,
  type RunRecord,
} from "../src/score.js";

const P = true;
const F = false;

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

describe("entropy (hand-computed)", () => {
  it("is 1.0 for a perfectly balanced pass/fail history", () => {
    expect(entropy([P, F, P, F])).toBe(1.0);
    expect(entropy([P, F])).toBe(1.0);
  });
  it("is 0 for uniform histories and empty input", () => {
    expect(entropy([P, P, P])).toBe(0);
    expect(entropy([F, F])).toBe(0);
    expect(entropy([])).toBe(0);
    expect(entropy([P])).toBe(0);
  });
  it("is 0.8112781244591328 for 3 passes and 1 fail", () => {
    expect(entropy([P, P, P, F])).toBeCloseTo(0.8112781244591328, 15);
  });
});

describe("flipRate (hand-computed)", () => {
  it("is 1.0 when every consecutive pair flips", () => {
    expect(flipRate([P, F, P, F])).toBe(1.0);
    expect(flipRate([F, P])).toBe(1.0);
  });
  it("is 1/3 for [P,P,F,F]", () => {
    expect(flipRate([P, P, F, F])).toBeCloseTo(1 / 3, 15);
  });
  it("is 0 below two runs", () => {
    expect(flipRate([])).toBe(0);
    expect(flipRate([P])).toBe(0);
    expect(flipRate([P, P, P])).toBe(0);
  });
});

describe("aggregation", () => {
  it("aggregateUnweighted is the plain mean", () => {
    expect(aggregateUnweighted([0, 1])).toBe(0.5);
    expect(aggregateUnweighted([0.25, 0.5, 0.75])).toBe(0.5);
    expect(aggregateUnweighted([])).toBe(0);
  });

  it("aggregateWeighted(EWMA, lam=0.1) favours the newest version", () => {
    // weights: index0 age1 -> 0.1*0.9 = 0.09, index1 age0 -> 0.1
    expect(aggregateWeighted([0, 1], 0.1)).toBeCloseTo(0.1 / 0.19, 15);
    expect(aggregateWeighted([0, 1], 0.1)).toBeCloseTo(0.5263157894736842, 15);
    expect(aggregateWeighted([1, 0], 0.1)).toBeCloseTo(0.09 / 0.19, 15);
    expect(aggregateWeighted([1, 0], 0.1)).toBeCloseTo(0.47368421052631576, 15);
  });

  it("aggregateWeighted of a single version is that version's score", () => {
    expect(aggregateWeighted([1.0], 0.1)).toBe(1.0);
    expect(aggregateWeighted([0.25], 0.1)).toBe(0.25);
    expect(aggregateWeighted([], 0.1)).toBe(0);
  });

  it("lam=1 keeps only the newest version", () => {
    expect(aggregateWeighted([1, 0], 1)).toBe(0);
    expect(aggregateWeighted([0, 1], 1)).toBe(1);
  });
});

describe("confidence (data volume x score stability)", () => {
  it("is data_factor alone for a single version", () => {
    expect(confidence(4, [1.0])).toBe(0.5); // 1 - 1/sqrt(4)
    expect(confidence(1, [1.0])).toBe(0); // 1 - 1/sqrt(1)
    expect(confidence(100, [1.0])).toBe(0.9);
  });
  it("treats 0 runs as 1 run", () => {
    expect(confidence(0, [])).toBe(0);
  });
  it("penalises unstable per-version scores", () => {
    expect(confidence(9, [0, 1])).toBe(0.3333); // (1-1/3) * (1-0.5)
    expect(confidence(100, [1, 0, 1, 0])).toBe(0.45); // 0.9 * 0.5
  });
  it("does not penalise identical per-version scores", () => {
    expect(confidence(16, [0.5, 0.5])).toBe(0.75);
  });
  it("clamps the stability factor at 0", () => {
    expect(confidence(100, [0, 4])).toBe(0); // sqrt(variance)=2 -> max(0, -1)
  });
});

describe("verdict bands", () => {
  it("uses <=0 / <0.17 / <0.5 / else", () => {
    expect(verdict(0)).toBe("not_flaky");
    expect(verdict(-1)).toBe("not_flaky");
    expect(verdict(0.0001)).toBe("slightly_flaky");
    expect(verdict(0.169)).toBe("slightly_flaky");
    expect(verdict(0.17)).toBe("flaky");
    expect(verdict(0.499)).toBe("flaky");
    expect(verdict(0.5)).toBe("very_flaky");
    expect(verdict(1)).toBe("very_flaky");
  });
});

describe("round4 matches Python round(x, 4)", () => {
  it("rounds on the exact binary value", () => {
    expect(round4(1 / 3)).toBe(0.3333);
    expect(round4(0.5263157894736842)).toBe(0.5263);
    expect(round4(0.16666666666666666)).toBe(0.1667);
    expect(round4(1)).toBe(1);
  });

  // Values pinned against python3 -c "print(round(x, 4))". Exact .00005 ties go to
  // even in Python but upward with toFixed(); flipRate n/32 reaches them (33 runs).
  it("breaks exact .00005 ties to even, like Python", () => {
    expect(round4(1 / 32)).toBe(0.0312); // not 0.0313
    expect(round4(5 / 32)).toBe(0.1562);
    expect(round4(13 / 32)).toBe(0.4062);
    expect(round4(3 / 32)).toBe(0.0938); // odd digit -> rounds away
    expect(round4(7 / 32)).toBe(0.2188);
    expect(round4(-1 / 32)).toBe(-0.0312);
    // Near-ties are NOT ties: the double for 0.00005 sits just above it.
    expect(round4(0.00005)).toBe(0.0001);
  });
});

describe("timestampKey", () => {
  it("orders numeric before ISO before opaque, and empty last", () => {
    expect(timestampKey("1714557600")[0]).toBe(0);
    expect(timestampKey(1714557600)[0]).toBe(0);
    expect(timestampKey("2024-05-01T10:00:00Z")[0]).toBe(1);
    expect(timestampKey("nonsense")).toEqual([2, 0, "nonsense"]);
    expect(timestampKey(null)).toEqual([2, 0, ""]);
    expect(timestampKey("")).toEqual([2, 0, ""]);
  });
  it("converts ISO timestamps to epoch seconds", () => {
    expect(timestampKey("2024-05-01T10:00:00Z")[1]).toBe(1714557600);
  });

  it("reads offset-less ISO stamps as UTC, regardless of local timezone", () => {
    expect(timestampKey("2024-05-01")[1]).toBe(1714521600);
    expect(timestampKey("2024-05-01T00:00:00")[1]).toBe(1714521600);
    expect(timestampKey("2024-05-01T00:00:00")[1]).toBe(timestampKey("2024-05-01T00:00:00Z")[1]);
    expect(timestampKey("2024-05-01T02:00:00")[1]).toBe(1714528800);
    expect(timestampKey("2024-05-01T00:00:00")[1]).toBeLessThan(timestampKey("2024-05-01T02:00:00")[1]);
  });
});

describe("groupByTestAndVersion", () => {
  it("orders runs chronologically, falling back to input order", () => {
    const grouped = groupByTestAndVersion([
      run({ test_id: "a", result: F, version: "v1", timestamp: "2024-05-01T12:00:00Z" }),
      run({ test_id: "a", result: P, version: "v1", timestamp: "2024-05-01T10:00:00Z" }),
      run({ test_id: "a", result: P, version: "v1", timestamp: null }),
      run({ test_id: "a", result: F, version: "v1", timestamp: null }),
    ]);
    // null timestamps sort last (bucket 2) and keep their input order.
    expect(grouped.get("a")!.get("v1")!.map((r) => r.result)).toEqual([P, F, P, F]);
  });

  it("buckets version-less runs under __all__ and keeps versions separate", () => {
    const grouped = groupByTestAndVersion([
      run({ test_id: "a", result: P, version: "v1" }),
      run({ test_id: "a", result: F, version: "v2" }),
      run({ test_id: "b", result: P }),
    ]);
    expect([...grouped.get("a")!.keys()]).toEqual(["v1", "v2"]);
    expect([...grouped.get("b")!.keys()]).toEqual(["__all__"]);
  });

  it("keeps test and version insertion order chronological", () => {
    const grouped = groupByTestAndVersion([
      run({ test_id: "b", result: P, version: "v1", timestamp: 3 }),
      run({ test_id: "a", result: P, version: "v2", timestamp: 2 }),
      run({ test_id: "a", result: F, version: "v1", timestamp: 1 }),
    ]);
    expect([...grouped.keys()]).toEqual(["a", "b"]);
    expect([...grouped.get("a")!.keys()]).toEqual(["v1", "v2"]);
  });
});

describe("scoreTests parity", () => {
  const alternating = [P, F, P, F].map((result, i) =>
    run({ test_id: "alt", result, version: "v1", timestamp: i }),
  );

  it("pins the [P,F,P,F] single-version case", () => {
    const [row] = scoreTests(groupByTestAndVersion(alternating));
    expect(row).toEqual({
      rank: 1,
      test_id: "alt",
      score: 1.0,
      confidence: 0.5,
      gating_score: 0.5,
      verdict: "very_flaky",
      total_runs: 4,
      independent_runs: 4,
      num_versions: 1,
      low_data: false,
    });
  });

  it("pins the entropy metric on the same history", () => {
    const [row] = scoreTests(groupByTestAndVersion(alternating), { metric: "entropy" });
    expect(row!.score).toBe(1.0);
  });

  it("pins a two-version EWMA case (v1 stable, v2 flipping)", () => {
    const runs = [
      run({ test_id: "t", result: P, version: "v1", timestamp: 1 }),
      run({ test_id: "t", result: P, version: "v1", timestamp: 2 }),
      run({ test_id: "t", result: P, version: "v2", timestamp: 3 }),
      run({ test_id: "t", result: F, version: "v2", timestamp: 4 }),
    ];
    const [row] = scoreTests(groupByTestAndVersion(runs));
    expect(row!.score).toBe(0.5263); // 0.1 / 0.19
    expect(row!.confidence).toBe(0.25); // (1 - 1/2) * (1 - 0.5)
    expect(row!.gating_score).toBe(0.1316); // unrounded score * rounded confidence
    expect(row!.verdict).toBe("very_flaky");
    expect(row!.independent_runs).toBe(4);
    expect(row!.num_versions).toBe(2);
  });

  it("uses the unweighted mean when asked", () => {
    const runs = [
      run({ test_id: "t", result: P, version: "v1", timestamp: 1 }),
      run({ test_id: "t", result: P, version: "v1", timestamp: 2 }),
      run({ test_id: "t", result: P, version: "v2", timestamp: 3 }),
      run({ test_id: "t", result: F, version: "v2", timestamp: 4 }),
    ];
    const [row] = scoreTests(groupByTestAndVersion(runs), { model: "unweighted" });
    expect(row!.score).toBe(0.5);
  });

  it("ranks by (score, confidence, total_runs) descending", () => {
    const runs = [
      ...[P, F, P, F].map((result, i) => run({ test_id: "flaky", result, timestamp: i })),
      ...[P, P, F, F].map((result, i) => run({ test_id: "mild", result, timestamp: i })),
      ...[P, P].map((result, i) => run({ test_id: "clean", result, timestamp: i })),
    ];
    const rows = scoreTests(groupByTestAndVersion(runs));
    expect(rows.map((r) => [r.rank, r.test_id])).toEqual([
      [1, "flaky"],
      [2, "mild"],
      [3, "clean"],
    ]);
    expect(rows[1]!.score).toBe(0.3333);
    expect(rows[1]!.gating_score).toBe(0.1667);
    expect(rows[2]!.verdict).toBe("not_flaky");
  });

  it("flags low-data tests against --min-reruns", () => {
    const runs = [
      run({ test_id: "once", result: F, timestamp: 1 }),
      run({ test_id: "once", result: P, timestamp: 2 }),
    ];
    expect(scoreTests(groupByTestAndVersion(runs))[0]!.low_data).toBe(false);
    expect(scoreTests(groupByTestAndVersion(runs), { minReruns: 3 })[0]!.low_data).toBe(true);
  });
});

describe("independent execution scoring", () => {
  it("counts a gap as two executions", () => {
    const runs = [
      run({ test_id: "gap", result: F, version: "v1", attempt: 0, timestamp: 1 }),
      run({ test_id: "gap", result: P, version: "v1", attempt: 2, timestamp: 2 }),
    ];
    expect(countIndependentRuns(groupByTestAndVersion(runs).get("gap")!.get("v1")!)).toBe(2);
  });

  it("counts one retry chain as one independent execution", () => {
    const runs = [0, 1, 2].map((attempt, timestamp) =>
      run({ test_id: "retried", result: timestamp % 2 === 1, version: "v1", attempt, timestamp }),
    );
    const [row] = scoreTests(groupByTestAndVersion(runs));

    expect(row).toMatchObject({
      score: 1,
      confidence: 0,
      gating_score: 0,
      total_runs: 3,
      independent_runs: 1,
      low_data: true,
    });
  });

  it("keeps interleaved retry chains separate by execution id", () => {
    const runs = [
      run({ test_id: "parallel", result: F, version: "v1", execution_id: "a", attempt: 0, timestamp: 1 }),
      run({ test_id: "parallel", result: F, version: "v1", execution_id: "b", attempt: 0, timestamp: 2 }),
      run({ test_id: "parallel", result: P, version: "v1", execution_id: "a", attempt: 1, timestamp: 3 }),
      run({ test_id: "parallel", result: P, version: "v1", execution_id: "b", attempt: 1, timestamp: 4 }),
    ];
    const [row] = scoreTests(groupByTestAndVersion(runs));

    expect(groupIndependentRuns(runs).map((group) => group.map((run) => run.execution_id))).toEqual([
      ["a", "a"],
      ["b", "b"],
    ]);
    expect(row).toMatchObject({ independent_runs: 2, low_data: false });
  });

  it("scores the same retry chains identically when workers interleave them", () => {
    const attempt = (execution_id: string, attempt: number, result: boolean, timestamp: number) =>
      run({ test_id: "parallel", result, version: "v1", execution_id, attempt, timestamp });
    const sequential = [
      attempt("a", 0, F, 1),
      attempt("a", 1, P, 3),
      attempt("b", 0, F, 2),
      attempt("b", 1, P, 4),
    ];
    const interleaved = [
      attempt("a", 0, F, 1),
      attempt("b", 0, F, 2),
      attempt("a", 1, P, 3),
      attempt("b", 1, P, 4),
    ];

    expect(scoreTests(groupByTestAndVersion(interleaved))).toEqual(
      scoreTests(groupByTestAndVersion(sequential)),
    );
    expect(scoreTests(groupByTestAndVersion(interleaved))[0]!.score).toBe(1);
  });

  it.each([
    [[0, 1, 0, 1], 2],
    [[0, 2], 2],
    [[0, 0, 1], 2],
    [[0, -1, 1], 3],
  ])("starts a new generation when one execution id has attempts %j", (attempts, expected) => {
    const runs = attempts.map((attempt, timestamp) =>
      run({ test_id: "reused", result: timestamp % 2 === 0, execution_id: "same", attempt, timestamp }),
    );
    expect(groupIndependentRuns(runs)).toHaveLength(expected);
  });

  it("never joins an old identity-less chain across an identified execution", () => {
    const runs = [
      run({ test_id: "mixed", result: F, attempt: 0, timestamp: 1 }),
      run({ test_id: "mixed", result: F, execution_id: "known", attempt: 0, timestamp: 2 }),
      run({ test_id: "mixed", result: P, attempt: 1, timestamp: 3 }),
    ];
    expect(groupIndependentRuns(runs)).toHaveLength(3);
  });

  it("keeps every identified chain intact under round-robin interleaving", () => {
    for (let chainCount = 1; chainCount <= 5; chainCount++) {
      for (let attempts = 1; attempts <= 4; attempts++) {
        const runs: RunRecord[] = [];
        for (let attempt = 0; attempt < attempts; attempt++) {
          for (let chain = 0; chain < chainCount; chain++) {
            runs.push(run({
              test_id: "property",
              result: (chain + attempt) % 2 === 0,
              execution_id: `chain-${chain}`,
              attempt,
              timestamp: runs.length,
            }));
          }
        }
        const groups = groupIndependentRuns(runs);
        expect(groups).toHaveLength(chainCount);
        expect(groups.every((group) => group.length === attempts)).toBe(true);
        expect(groups.every((group) => new Set(group.map((run) => run.execution_id)).size === 1)).toBe(true);
      }
    }
  });

  it("starts a new execution for malformed, repeated, or non-consecutive attempts", () => {
    const attempts: (number | null | undefined)[] = [
      0,
      1,
      1,
      2,
      1,
      4,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      null,
      0,
      1,
    ];
    const runs = attempts.map((attempt, timestamp) => {
      const base = { test_id: "malformed", result: timestamp % 2 === 0, version: "v1", timestamp };
      return attempt === undefined ? run(base) : run({ ...base, attempt });
    });
    const [row] = scoreTests(groupByTestAndVersion(runs));

    expect(row!.total_runs).toBe(attempts.length);
    expect(row!.independent_runs).toBe(11);
  });

  it("does not score or trust histories made only of singleton versions", () => {
    const runs = [
      run({ test_id: "singletons", result: F, version: "v1", timestamp: 1 }),
      run({ test_id: "singletons", result: P, version: "v2", timestamp: 2 }),
      run({ test_id: "singletons", result: F, version: "v3", timestamp: 3 }),
    ];
    const [row] = scoreTests(groupByTestAndVersion(runs), { minReruns: 1 });

    expect(row).toMatchObject({
      score: 0,
      confidence: 0,
      gating_score: 0,
      total_runs: 3,
      independent_runs: 3,
      low_data: true,
    });
  });

  it("uses independent run counts to weight version scores and variance", () => {
    const runs = [
      ...[P, F].map((result, timestamp) =>
        run({ test_id: "weighted", result, version: "v1", timestamp }),
      ),
      ...Array.from({ length: 8 }, (_, timestamp) =>
        run({ test_id: "weighted", result: P, version: "v2", timestamp: timestamp + 2 }),
      ),
    ];
    const [row] = scoreTests(groupByTestAndVersion(runs), { metric: "flipRate", model: "unweighted" });

    expect(row!.score).toBe(0.2);
    expect(row!.confidence).toBe(0.4103);
    expect(row!.gating_score).toBe(0.0821);
  });

  it("does not let retry attempts outweigh ordinary executions", () => {
    const runs = [
      ...[0, 1].map((attempt, timestamp) =>
        run({ test_id: "retry-heavy", result: timestamp === 1, version: "v1", attempt, timestamp }),
      ),
      ...Array.from({ length: 6 }, (_, timestamp) =>
        run({ test_id: "retry-heavy", result: P, version: "v2", timestamp: timestamp + 2 }),
      ),
    ];
    const [row] = scoreTests(groupByTestAndVersion(runs), { model: "unweighted" });

    expect(row!.total_runs).toBe(8);
    expect(row!.independent_runs).toBe(7);
    expect(row!.score).toBe(0.1429);
  });

  it("does not pool independent runs across singleton versions", () => {
    const runs = [
      run({ test_id: "pooled", result: F, version: "v1", timestamp: 1 }),
      run({ test_id: "pooled", result: P, version: "v2", timestamp: 2 }),
    ];
    const [row] = scoreTests(groupByTestAndVersion(runs), { minReruns: 2 });

    expect(row).toMatchObject({ score: 0, confidence: 0, gating_score: 0, low_data: true });
  });

  it("ignores singleton versions when scoring a comparable history", () => {
    const comparable = [
      run({ test_id: "extra", result: F, version: "v1", timestamp: 1 }),
      run({ test_id: "extra", result: P, version: "v1", timestamp: 2 }),
    ];
    const withSingleton = [
      ...comparable,
      run({ test_id: "extra", result: P, version: "v2", timestamp: 3 }),
    ];
    const base = scoreTests(groupByTestAndVersion(comparable))[0];
    const extra = scoreTests(groupByTestAndVersion(withSingleton))[0];

    expect(extra).toMatchObject({ score: base!.score, confidence: base!.confidence, gating_score: base!.gating_score });
  });

  it.each([
    [2, true],
    [3, false],
    [4, false],
  ])("uses independent runs for minReruns boundary (%i)", (count, lowData) => {
    const runs = Array.from({ length: count }, (_, timestamp) =>
      run({ test_id: "boundary", result: timestamp % 2 === 0, version: "v1", timestamp }),
    );
    const [row] = scoreTests(groupByTestAndVersion(runs), { minReruns: 3 });

    expect(row!.independent_runs).toBe(count);
    expect(row!.low_data).toBe(lowData);
    if (lowData) expect(row!.gating_score).toBe(0);
    else expect(row!.gating_score).toEqual(expect.any(Number));
  });

  it("keeps score, confidence, and gating values bounded for every bit sequence through length 8", () => {
    for (let length = 0; length <= 8; length++) {
      for (let mask = 0; mask < 2 ** length; mask++) {
        const runs = Array.from({ length }, (_, timestamp) =>
          run({ test_id: "property", result: (mask & (1 << timestamp)) !== 0, version: "v1", timestamp }),
        );
        const grouped = groupByTestAndVersion(runs);
        const first = scoreTests(grouped)[0];
        const second = scoreTests(grouped)[0];

        if (!first) continue;
        expect(first).toEqual(second);
        expect(first.score).toBeGreaterThanOrEqual(0);
        expect(first.score).toBeLessThanOrEqual(1);
        expect(first.confidence).toBeGreaterThanOrEqual(0);
        expect(first.confidence).toBeLessThanOrEqual(1);
        expect(first.gating_score).toBeGreaterThanOrEqual(0);
        expect(first.gating_score).toBeLessThanOrEqual(first.score);
        if (first.low_data) expect(first.gating_score).toBe(0);
      }
    }
  });
});
