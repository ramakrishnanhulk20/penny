// Not covered: how far the greedy plan above the limit is from the minimum, or the minimum for
// 10 to 16 people beyond the one hand-built case at the limit.
import fc from "fast-check";
import { expect, it } from "vitest";
import { EXACT_SETTLE_LIMIT, settle, settleGreedy, type Transfer } from "../src/index";

type Balances = ReadonlyMap<string, bigint>;

function applied(balances: Balances, plan: readonly Transfer[]): Map<string, bigint> {
  const left = new Map(balances);
  for (const t of plan) {
    expect(left.has(t.from) && left.has(t.to) && t.from !== t.to && t.amount > 0n).toBe(true);
    left.set(t.from, (left.get(t.from) ?? 0n) + t.amount);
    left.set(t.to, (left.get(t.to) ?? 0n) - t.amount);
  }
  return left;
}

function expectSettled(balances: Balances, plan: readonly Transfer[]): void {
  for (const amount of applied(balances, plan).values()) expect(amount).toBe(0n);
}

// Independent of settle's bitmask search: recursive enumeration of every way to
// split the non-zero balances into zero-sum groups, keeping the most groups.
function oracleMinTransfers(balances: Balances): number {
  const memo = new Map<string, number>();
  const mostGroups = (values: readonly bigint[]): number => {
    if (values.length === 0) return 0;
    const key = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",");
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const [first = 0n, ...rest] = values;
    let best = 0;
    for (let mask = 0; mask < 1 << rest.length; mask++) {
      let groupSum = first;
      const remaining: bigint[] = [];
      rest.forEach((v, i) => {
        if ((mask >> i) & 1) groupSum += v;
        else remaining.push(v);
      });
      if (groupSum === 0n) best = Math.max(best, 1 + mostGroups(remaining));
    }
    memo.set(key, best);
    return best;
  };
  const nonZero = [...balances.values()].filter((v) => v !== 0n);
  return nonZero.length - mostGroups(nonZero);
}

const ids = (min: number, max: number) => fc.uniqueArray(fc.stringMatching(/^[a-z]{1,3}$/), { minLength: min, maxLength: max });

function zeroSum(memberIds: readonly string[], values: readonly bigint[]): Map<string, bigint> {
  const last = -values.reduce((a, b) => a + b, 0n);
  return new Map(memberIds.map((id, i) => [id, values[i] ?? last]));
}

const small = ids(2, 9).chain((memberIds) =>
  fc
    .array(fc.bigInt({ min: -12n, max: 12n }), { minLength: memberIds.length - 1, maxLength: memberIds.length - 1 })
    .map((values) => zeroSum(memberIds, values)),
);

// Two scaled copies of a five-person case where greedy needs 4 transfers and the
// best plan needs 3, plus three +1/-1 pairs: 16 non-zero balances, 2 zeros.
// Best plan: 3 + 3 + 3 = 9. Greedy: 4 + 4 + 3 = 11.
const SIXTEEN = new Map<string, bigint>([
  ["a1", 5_000_000n],
  ["b1", 4_000_000n],
  ["c1", 3_000_000n],
  ["d1", -7_000_000n],
  ["e1", -5_000_000n],
  ["a2", 5_000n],
  ["b2", 4_000n],
  ["c2", 3_000n],
  ["d2", -7_000n],
  ["e2", -5_000n],
  ["p1", 1n],
  ["q1", -1n],
  ["p2", 1n],
  ["q2", -1n],
  ["p3", 1n],
  ["q3", -1n],
  ["z1", 0n],
  ["z2", 0n],
]);

it("settle needs no transfers when everyone is already at zero", () => {
  expect(settle(new Map([["ann", 0n], ["ben", 0n]]))).toEqual([]);
  expect(settle(new Map())).toEqual([]);
  expect(settleGreedy(new Map([["ann", 0n]]))).toEqual([]);
});

it("settle has one debtor pay two creditors", () => {
  const owed = new Map([
    ["ann", 3000n],
    ["ben", 2000n],
    ["cat", -5000n],
  ]);
  const expected = [
    { from: "cat", to: "ann", amount: 3000n },
    { from: "cat", to: "ben", amount: 2000n },
  ];
  expect(settle(owed)).toEqual(expected);
  expect(settleGreedy(owed)).toEqual(expected);
});

it("settle beats greedy where greedy uses an extra transfer", () => {
  const owed = new Map([
    ["a", 5n],
    ["b", 4n],
    ["c", 3n],
    ["d", -7n],
    ["e", -5n],
  ]);
  expect(settle(owed)).toEqual([
    { from: "d", to: "b", amount: 4n },
    { from: "d", to: "c", amount: 3n },
    { from: "e", to: "a", amount: 5n },
  ]);
  expect(settleGreedy(owed)).toEqual([
    { from: "d", to: "a", amount: 5n },
    { from: "d", to: "c", amount: 2n },
    { from: "e", to: "b", amount: 4n },
    { from: "e", to: "c", amount: 1n },
  ]);
});

it("settleGreedy breaks ties by member id", () => {
  const owed = new Map([
    ["d", -5n],
    ["b", 5n],
    ["c", -5n],
    ["a", 5n],
  ]);
  expect(settleGreedy(owed)).toEqual([
    { from: "c", to: "a", amount: 5n },
    { from: "d", to: "b", amount: 5n },
  ]);
});

it("settle and settleGreedy refuse balances that do not sum to zero", () => {
  const off = new Map([
    ["ann", 1n],
    ["ben", -2n],
  ]);
  expect(() => settle(off)).toThrow("settle_unbalanced");
  expect(() => settleGreedy(off)).toThrow("settle_unbalanced");
});

it(`settle finds the true minimum at exactly ${EXACT_SETTLE_LIMIT} non-zero balances, ignoring zeros in the count`, () => {
  const plan = settle(SIXTEEN);
  expectSettled(SIXTEEN, plan);
  expect(plan).toHaveLength(9);
  expect(settleGreedy(SIXTEEN)).toHaveLength(11);
});

it("settle switches to the greedy plan one pair above the limit", () => {
  const eighteen = new Map([...SIXTEEN, ["r1", 1_000_000_000n], ["s1", -1_000_000_000n]]);
  const plan = settle(eighteen);
  expectSettled(eighteen, plan);
  expect(plan).toEqual(settleGreedy(eighteen));
  expect(plan).toHaveLength(12);
});

it("settle uses the greedy plan above the limit and still zeroes everyone", () => {
  const many = ids(EXACT_SETTLE_LIMIT + 1, EXACT_SETTLE_LIMIT + 4).chain((memberIds) =>
    fc
      .array(fc.bigInt({ min: 1n, max: 1000n }).chain((v) => fc.constantFrom(v, -v)), {
        minLength: memberIds.length - 1,
        maxLength: memberIds.length - 1,
      })
      .map((values) => zeroSum(memberIds, values))
      .filter((b) => [...b.values()].every((v) => v !== 0n)),
  );
  fc.assert(
    fc.property(many, (b) => {
      const plan = settle(b);
      expectSettled(b, plan);
      expect(plan).toEqual(settleGreedy(b));
    }),
    { numRuns: 30 },
  );
});

it("settle zeroes everyone with the fewest possible transfers, never more than greedy", () => {
  fc.assert(
    fc.property(small, (b) => {
      const plan = settle(b);
      const greedy = settleGreedy(b);
      expectSettled(b, plan);
      expectSettled(b, greedy);
      expect(plan.length).toBe(oracleMinTransfers(b));
      expect(plan.length).toBeLessThanOrEqual(greedy.length);
    }),
  );
});

it("settle gives the same plan for the same balances, whatever order they arrive in", () => {
  fc.assert(
    fc.property(small, fc.boolean(), (b, flip) => {
      const reordered = new Map(flip ? [...b].reverse() : [...b].sort(([x], [y]) => (x < y ? 1 : -1)));
      expect(settle(b)).toEqual(settle(b));
      expect(settle(reordered)).toEqual(settle(b));
      expect(settleGreedy(reordered)).toEqual(settleGreedy(b));
    }),
  );
});
