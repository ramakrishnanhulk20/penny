// Not covered: storage, event order, retries or concurrent edits (threat model C14 to C18),
// which live in the web app.
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import {
  balances,
  currency,
  entryInBase,
  MAX_AMOUNT_MINOR,
  MAX_WEIGHT,
  parseRate,
  type Currency,
  type Entry,
  type Rate,
  type Split,
} from "../src/index";

const fault = vi.hoisted(() => ({ skewBaseParts: false }));

// Lets one test break the "base parts add up" rule on purpose, to prove the
// ledger's own sum check catches it. Every other test runs the real function.
vi.mock("../src/allocate", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/allocate")>();
  return {
    ...real,
    allocateLike: (total: bigint, shape: ReadonlyMap<string, bigint>) => {
      const parts = real.allocateLike(total, shape);
      if (!fault.skewBaseParts) return parts;
      return new Map([...parts].map(([id, part], i) => [id, i === 0 ? part + 1n : part]));
    },
  };
});

afterEach(() => {
  fault.skewBaseParts = false;
});

function known(code: string): Currency {
  const found = currency(code);
  if (found === null) throw new Error(`missing currency ${code}`);
  return found;
}

function rate(input: string): Rate {
  const parsed = parseRate(input);
  if (!parsed.ok) throw new Error(`bad test rate ${input}`);
  return parsed.value;
}

const USD = known("USD");
const EUR = known("EUR");
const JPY = known("JPY");
const KWD = known("KWD");
const CLF = known("CLF");
const MEMBERS = ["ann", "ben", "cat"];
const GROUP = new Set(MEMBERS);

const equalSplit: Split = { mode: "equal", members: MEMBERS };

function expense(fields: Partial<Extract<Entry, { kind: "expense" }>>): Entry {
  return { kind: "expense", id: "e1", paidBy: "ann", currency: USD, amount: 3000n, rate: null, split: equalSplit, ...fields };
}

function payment(fields: Partial<Extract<Entry, { kind: "payment" }>>): Entry {
  return { kind: "payment", id: "p1", from: "ben", to: "ann", currency: USD, amount: 1000n, rate: null, ...fields };
}

function sum(values: Iterable<bigint>): bigint {
  let acc = 0n;
  for (const v of values) acc += v;
  return acc;
}

it("entryInBase credits the payer and debits each participant for a base-currency expense", () => {
  const result = entryInBase(expense({}), USD, GROUP);
  expect(result).toEqual({
    ok: true,
    value: {
      id: "e1",
      baseTotal: 3000n,
      deltas: new Map([
        ["ann", 2000n],
        ["ben", -1000n],
        ["cat", -1000n],
      ]),
    },
  });
});

it("entryInBase re-splits a foreign exact split so the base parts sum to the base total", () => {
  const split: Split = {
    mode: "exact",
    parts: [
      { memberId: "ann", amount: 3333n },
      { memberId: "ben", amount: 3333n },
      { memberId: "cat", amount: 3334n },
    ],
  };
  const result = entryInBase(expense({ paidBy: "ben", currency: EUR, amount: 10000n, rate: rate("1.0837"), split }), USD, GROUP);
  // 100.00 EUR at 1.0837 is 108.37 USD. Base parts 36.12, 36.12, 36.13 add up to it exactly.
  expect(result).toEqual({
    ok: true,
    value: {
      id: "e1",
      baseTotal: 10837n,
      deltas: new Map([
        ["ben", 10837n - 3612n],
        ["ann", -3612n],
        ["cat", -3613n],
      ]),
    },
  });
});

it("entryInBase credits the sender and debits the receiver of a foreign payment", () => {
  const result = entryInBase(payment({ currency: EUR, amount: 1000n, rate: rate("1.1") }), USD, GROUP);
  expect(result).toEqual({
    ok: true,
    value: {
      id: "p1",
      baseTotal: 1100n,
      deltas: new Map([
        ["ben", 1100n],
        ["ann", -1100n],
      ]),
    },
  });
});

it.each([
  ["a foreign expense without a rate", expense({ currency: EUR }), "rate_required"],
  ["a foreign payment without a rate", payment({ currency: EUR }), "rate_required"],
  ["a base-currency expense with a rate", expense({ rate: rate("1") }), "rate_forbidden"],
  ["a base-currency payment with a rate", payment({ rate: rate("1.2") }), "rate_forbidden"],
  ["an expense paid by a stranger", expense({ paidBy: "zed" }), "unknown_member"],
  ["an expense split with a stranger", expense({ split: { mode: "equal", members: ["ann", "zed"] } }), "unknown_member"],
  ["a payment from a stranger", payment({ from: "zed" }), "unknown_member"],
  ["a payment to a stranger", payment({ to: "zed" }), "unknown_member"],
  ["a payment to yourself", payment({ to: "ben" }), "self_payment"],
  ["a payment of 0n", payment({ amount: 0n }), "bad_amount"],
  ["a payment below zero", payment({ amount: -500n }), "bad_amount"],
  ["an expense of 0n", expense({ amount: 0n }), "bad_amount"],
  ["an expense with a bad split", expense({ split: { mode: "equal", members: ["ann", "ann"] } }), "duplicate_member"],
  ["1 JPY at 0.001 into USD", expense({ currency: JPY, amount: 1n, rate: rate("0.001") }), "converts_to_zero"],
  ["a 1 JPY payment at 0.001 into USD", payment({ currency: JPY, amount: 1n, rate: rate("0.001") }), "converts_to_zero"],
  ["the largest JPY expense at 1000000 into USD", expense({ currency: JPY, amount: MAX_AMOUNT_MINOR, rate: rate("1000000") }), "base_too_large"],
  ["a JPY payment one unit past the cap once converted", payment({ currency: JPY, amount: MAX_AMOUNT_MINOR / 100n + 1n, rate: rate("1") }), "base_too_large"],
] as const)("entryInBase refuses %s with %s", (_name, entry, error) => {
  expect(entryInBase(entry, USD, GROUP)).toEqual({ ok: false, error });
});

it("entryInBase accepts a converted amount exactly at the cap", () => {
  const atCap = payment({ currency: JPY, amount: MAX_AMOUNT_MINOR / 100n, rate: rate("1") });
  const result = entryInBase(atCap, USD, GROUP);
  expect(result.ok && result.value.baseTotal).toBe(MAX_AMOUNT_MINOR);
});

it("entryInBase throws on an entry kind it does not know", () => {
  const odd = { ...expense({}), kind: "refund" } as unknown as Entry;
  expect(() => entryInBase(odd, USD, GROUP)).toThrow("unknown_entry_kind");
});

it("balances returns every member in input order, zeros included, summed across entries", () => {
  const members = ["dan", "ann", "ben", "cat"];
  const result = balances(USD, members, [expense({}), payment({}), expense({ id: "e2", paidBy: "cat", amount: 900n })]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect([...result.value]).toEqual([
    ["dan", 0n],
    ["ann", 2000n - 1000n - 300n],
    ["ben", -1000n + 1000n - 300n],
    ["cat", -1000n + 600n],
  ]);
});

it("balances returns the error of the first invalid entry", () => {
  expect(balances(USD, MEMBERS, [expense({}), payment({ to: "ben" }), expense({ paidBy: "zed" })])).toEqual({
    ok: false,
    error: "self_payment",
  });
});

it("balances throws ledger_invariant if base parts ever stop adding up", () => {
  fault.skewBaseParts = true;
  expect(() => balances(USD, MEMBERS, [expense({})])).toThrow("ledger_invariant");
});

it("balances always sums to exactly 0n for random valid entries in any currencies", () => {
  const currencies = [USD, EUR, JPY, KWD, CLF];
  const scenario = fc
    .record({
      base: fc.constantFrom(...currencies),
      members: fc.uniqueArray(fc.stringMatching(/^[a-z]{1,3}$/), { minLength: 2, maxLength: 8 }),
    })
    .chain(({ base, members }) => {
      const member = fc.constantFrom(...members);
      const someMembers = fc.shuffledSubarray(members, { minLength: 1 });
      // Rates 0.01..1000.00 on amounts of at least 10^6 minor units can never convert to zero.
      const amount = fc.bigInt({ min: 10n ** 6n, max: MAX_AMOUNT_MINOR });
      const priced = fc.constantFrom(...currencies).chain((cur) =>
        (cur.code === base.code
          ? fc.constant(null)
          : fc.bigInt({ min: 1n, max: 100000n }).map((u) => rate(`${u / 100n}.${(u % 100n).toString().padStart(2, "0")}`))
        ).map((r) => ({ currency: cur, rate: r })),
      );
      const split = fc.oneof(
        fc.tuple(amount, someMembers).map(([a, ms]) => ({ amount: a, split: { mode: "equal", members: ms } as Split })),
        fc
          .tuple(
            amount,
            someMembers.chain((ms) =>
              fc
                .array(fc.integer({ min: 1, max: MAX_WEIGHT }), { minLength: ms.length, maxLength: ms.length })
                .map((ws): Split => ({ mode: "shares", parts: ms.map((memberId, i) => ({ memberId, weight: ws[i] ?? 1 })) })),
            ),
          )
          .map(([a, s]) => ({ amount: a, split: s })),
        someMembers.chain((ms) =>
          fc
            .array(fc.bigInt({ min: 10n ** 6n, max: 10n ** 10n }), { minLength: ms.length, maxLength: ms.length })
            .map((amounts) => ({
              amount: sum(amounts),
              split: { mode: "exact", parts: ms.map((memberId, i) => ({ memberId, amount: amounts[i] ?? 0n })) } as Split,
            })),
        ),
      );
      const anExpense = fc
        .tuple(fc.uuid(), member, priced, split)
        .map(([id, paidBy, p, s]): Entry => ({ kind: "expense", id, paidBy, ...p, ...s }));
      const aPayment = fc
        .tuple(fc.uuid(), fc.shuffledSubarray(members, { minLength: 2, maxLength: 2 }), priced, amount)
        .map(([id, pair, p, a]): Entry => ({ kind: "payment", id, from: pair[0] ?? "", to: pair[1] ?? "", ...p, amount: a }));
      return fc.record({
        base: fc.constant(base),
        members: fc.constant(members),
        entries: fc.array(fc.oneof(anExpense, aPayment), { maxLength: 20 }),
      });
    });

  fc.assert(
    fc.property(scenario, ({ base, members, entries }) => {
      // An entry that converts past the cap is refused by design (proven in the table above), so it is not a valid entry here.
      fc.pre(entries.every((entry) => {
        const one = entryInBase(entry, base, new Set(members));
        return one.ok || one.error !== "base_too_large";
      }));
      const result = balances(base, members, entries);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect([...result.value.keys()]).toEqual(members);
      expect(sum(result.value.values())).toBe(0n);
      for (const entry of entries) {
        const one = entryInBase(entry, base, new Set(members));
        expect(one.ok && sum(one.value.deltas.values()) === 0n && one.value.baseTotal > 0n).toBe(true);
      }
    }),
  );
});
