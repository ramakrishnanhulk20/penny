// Not covered: whether split members belong to the group. The ledger checks that (ledger.test.ts).
import fc from "fast-check";
import { expect, it } from "vitest";
import {
  allocate,
  allocateLike,
  MAX_AMOUNT_MINOR,
  MAX_PARTS,
  MAX_WEIGHT,
  type MemberId,
  type Split,
} from "../src/index";

function parts(total: bigint, split: Split): [MemberId, bigint][] {
  const result = allocate(total, split);
  if (!result.ok) throw new Error(`unexpected ${result.error}`);
  return [...result.value];
}

function sum(values: Iterable<bigint>): bigint {
  let acc = 0n;
  for (const v of values) acc += v;
  return acc;
}

const memberIds = (max: number) => fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/), { minLength: 1, maxLength: max });
const total = fc.bigInt({ min: 1n, max: MAX_AMOUNT_MINOR });
const weighted = memberIds(MAX_PARTS).chain((ids) =>
  fc
    .array(fc.integer({ min: 1, max: MAX_WEIGHT }), { minLength: ids.length, maxLength: ids.length })
    .map((weights) => ids.map((memberId, i) => ({ memberId, weight: weights[i] ?? 1 }))),
);

const exactOf = (amounts: unknown[]): Split =>
  ({ mode: "exact", parts: amounts.map((amount, i) => ({ memberId: `m${i}`, amount })) }) as unknown as Split;
const sharesOf = (weights: unknown[]): Split =>
  ({ mode: "shares", parts: weights.map((weight, i) => ({ memberId: `m${i}`, weight })) }) as unknown as Split;

it("allocate splits 100.00 three ways as 33.34, 33.33, 33.33 with the extra cent to the first listed", () => {
  expect(parts(10000n, { mode: "equal", members: ["ann", "ben", "cat"] })).toEqual([
    ["ann", 3334n],
    ["ben", 3333n],
    ["cat", 3333n],
  ]);
});

it("allocate lets input order, not the id, decide a tie", () => {
  expect(parts(10000n, { mode: "equal", members: ["cat", "ben", "ann"] })).toEqual([
    ["cat", 3334n],
    ["ben", 3333n],
    ["ann", 3333n],
  ]);
  const tied = (first: string, second: string): Split => ({
    mode: "shares",
    parts: [
      { memberId: first, weight: 1 },
      { memberId: second, weight: 1 },
    ],
  });
  expect(parts(1n, tied("ann", "ben"))).toEqual([
    ["ann", 1n],
    ["ben", 0n],
  ]);
  expect(parts(1n, tied("ben", "ann"))).toEqual([
    ["ben", 1n],
    ["ann", 0n],
  ]);
});

it("allocate gives leftover units to the largest remainders before input order", () => {
  const split: Split = {
    mode: "shares",
    parts: [
      { memberId: "ann", weight: 1 },
      { memberId: "ben", weight: 2 },
      { memberId: "cat", weight: 4 },
    ],
  };
  // Exact shares 1.43, 2.86, 5.71: floors 1, 2, 5 and the two spare units go
  // to ben (.86) and cat (.71), never to ann (.43).
  expect(parts(10n, split)).toEqual([
    ["ann", 1n],
    ["ben", 3n],
    ["cat", 6n],
  ]);
  expect(
    parts(1n, {
      mode: "shares",
      parts: [
        { memberId: "ann", weight: 1 },
        { memberId: "ben", weight: 2 },
      ],
    }),
  ).toEqual([
    ["ann", 0n],
    ["ben", 1n],
  ]);
});

it("allocate accepts weights at both ends of 1..MAX_WEIGHT and exactly MAX_PARTS parts", () => {
  expect(
    parts(1001n, {
      mode: "shares",
      parts: [
        { memberId: "ann", weight: 1 },
        { memberId: "ben", weight: MAX_WEIGHT },
      ],
    }),
  ).toEqual([
    ["ann", 1n],
    ["ben", 1000n],
  ]);
  const fifty = Array.from({ length: MAX_PARTS }, (_, i) => `m${i}`);
  expect(parts(MAX_AMOUNT_MINOR, { mode: "equal", members: fifty })).toHaveLength(MAX_PARTS);
});

it("allocate returns exact amounts in order once they sum to the total", () => {
  expect(
    parts(1000n, {
      mode: "exact",
      parts: [
        { memberId: "ben", amount: 1n },
        { memberId: "ann", amount: 999n },
      ],
    }),
  ).toEqual([
    ["ben", 1n],
    ["ann", 999n],
  ]);
});

it.each(
  (
    [
      ["equal with no members", 100n, { mode: "equal", members: [] }, "empty"],
      ["shares with no parts", 100n, { mode: "shares", parts: [] }, "empty"],
      ["exact with no parts", 100n, { mode: "exact", parts: [] }, "empty"],
      ["equal listing a member twice", 100n, { mode: "equal", members: ["ann", "ben", "ann"] }, "duplicate_member"],
      [
        "shares listing a member twice",
        100n,
        { mode: "shares", parts: [{ memberId: "ann", weight: 1 }, { memberId: "ann", weight: 2 }] },
        "duplicate_member",
      ],
      [
        "exact listing a member twice",
        100n,
        { mode: "exact", parts: [{ memberId: "ann", amount: 50n }, { memberId: "ann", amount: 50n }] },
        "duplicate_member",
      ],
      ["51 members", 100n, { mode: "equal", members: Array.from({ length: MAX_PARTS + 1 }, (_, i) => `m${i}`) }, "too_many_parts"],
      ["weight 0", 100n, sharesOf([1, 0]), "bad_weight"],
      ["weight -1", 100n, sharesOf([1, -1]), "bad_weight"],
      ["weight 1.5", 100n, sharesOf([1.5, 1]), "bad_weight"],
      ["weight 1001", 100n, sharesOf([1, MAX_WEIGHT + 1]), "bad_weight"],
      ["weight NaN", 100n, sharesOf([NaN]), "bad_weight"],
      ["weight Infinity", 100n, sharesOf([Infinity]), "bad_weight"],
      ["weight as a string", 100n, sharesOf(["2"]), "bad_weight"],
      ["exact parts short of the total", 100n, exactOf([40n, 59n]), "exact_sum_mismatch"],
      ["exact parts over the total", 100n, exactOf([40n, 61n]), "exact_sum_mismatch"],
      ["exact part of 0n", 100n, exactOf([100n, 0n]), "bad_amount"],
      ["exact part of -1n", 100n, exactOf([101n, -1n]), "bad_amount"],
      ["exact part as a number", 100n, exactOf([95n, 5]), "bad_amount"],
      ["a total of 0n", 0n, { mode: "equal", members: ["ann"] }, "bad_amount"],
      ["a negative total", -100n, { mode: "equal", members: ["ann"] }, "bad_amount"],
    ] as const
  ).map(([name, amount, split, error]) => [name, error, amount, split] as const),
)("allocate refuses %s as %s", (_name, error, amount, split) => {
  expect(allocate(amount, split as Split)).toEqual({ ok: false, error });
});

it("allocate throws on a split mode it does not know", () => {
  expect(() => allocate(100n, { mode: "percent", members: ["ann"] } as unknown as Split)).toThrow("unknown_split_mode");
});

it("allocate parts always sum to the total, sit within one unit of the exact share, and repeat identically", () => {
  const split = fc.oneof(
    memberIds(MAX_PARTS).map((members) => ({ split: { mode: "equal", members } as Split, weights: members.map(() => 1n) })),
    weighted.map((p) => ({ split: { mode: "shares", parts: p } as Split, weights: p.map((part) => BigInt(part.weight)) })),
  );
  fc.assert(
    fc.property(total, split, (t, { split: s, weights }) => {
      const result = parts(t, s);
      const weightSum = sum(weights);
      expect(sum(result.map(([, part]) => part))).toBe(t);
      result.forEach(([, part], i) => {
        const gap = part * weightSum - t * (weights[i] ?? 0n);
        expect(gap < weightSum && -gap < weightSum).toBe(true);
      });
      expect(parts(t, s)).toEqual(result);
    }),
  );
});

it("allocate returns exact parts that sum to the total unchanged", () => {
  const exactSplit = memberIds(MAX_PARTS).chain((ids) =>
    fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: ids.length, maxLength: ids.length }).map((amounts) => ({
      ids,
      amounts,
    })),
  );
  fc.assert(
    fc.property(exactSplit, ({ ids, amounts }) => {
      const split: Split = { mode: "exact", parts: ids.map((memberId, i) => ({ memberId, amount: amounts[i] ?? 1n })) };
      expect(parts(sum(amounts), split)).toEqual(ids.map((id, i) => [id, amounts[i]]));
    }),
  );
});

it("allocateLike uses the map values as weights", () => {
  const shape = new Map([
    ["ann", 1n],
    ["ben", 2n],
    ["cat", 4n],
  ]);
  expect([...allocateLike(10n, shape)]).toEqual([
    ["ann", 1n],
    ["ben", 3n],
    ["cat", 6n],
  ]);
});

it("allocateLike breaks ties by the map's insertion order", () => {
  expect([...allocateLike(1n, new Map([["ben", 1n], ["ann", 1n]]))]).toEqual([
    ["ben", 1n],
    ["ann", 0n],
  ]);
});

it("allocateLike gives a zero weight nothing and a zero total all zeros", () => {
  const shape = new Map([
    ["ann", 0n],
    ["ben", 1n],
    ["cat", 1n],
  ]);
  expect([...allocateLike(5n, shape)]).toEqual([
    ["ann", 0n],
    ["ben", 3n],
    ["cat", 2n],
  ]);
  expect([...allocateLike(0n, shape)]).toEqual([
    ["ann", 0n],
    ["ben", 0n],
    ["cat", 0n],
  ]);
});

it.each([
  ["a negative total", -1n, new Map([["ann", 1n]])],
  ["a negative weight", 5n, new Map([["ann", 2n], ["ben", -1n]])],
  ["only zero weights", 5n, new Map([["ann", 0n], ["ben", 0n]])],
  ["an empty shape", 5n, new Map<string, bigint>()],
])("allocateLike throws on %s", (_name, t, shape) => {
  expect(() => allocateLike(t, shape)).toThrow("allocate_like_precondition");
});

it("allocateLike parts always sum to the total, sit within one unit of the exact share, and repeat identically", () => {
  const shape = memberIds(MAX_PARTS).chain((ids) =>
    fc
      .array(fc.bigInt({ min: 0n, max: MAX_AMOUNT_MINOR }), { minLength: ids.length, maxLength: ids.length })
      .filter((ws) => ws.some((w) => w > 0n))
      .map((ws) => new Map(ids.map((id, i) => [id, ws[i] ?? 0n]))),
  );
  fc.assert(
    fc.property(total, shape, (t, s) => {
      const result = allocateLike(t, s);
      const weightSum = sum(s.values());
      expect(sum(result.values())).toBe(t);
      for (const [id, part] of result) {
        const gap = part * weightSum - t * (s.get(id) ?? 0n);
        expect(gap < weightSum && -gap < weightSum).toBe(true);
      }
      expect([...result]).toEqual([...allocateLike(t, s)]);
    }),
  );
});
