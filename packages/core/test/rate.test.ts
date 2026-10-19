// Not covered: whether a rate is accurate or current, or rates fetched from the FX service.
// convert trusts the rate it is given.
import fc from "fast-check";
import { expect, it } from "vitest";
import {
  convert,
  currency,
  formatRate,
  MAX_AMOUNT_MINOR,
  MAX_RATE_SCALE,
  parseRate,
  type Currency,
  type Rate,
} from "../src/index";

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

const canonicalRate = fc.integer({ min: 0, max: MAX_RATE_SCALE }).chain((scale) =>
  fc
    .bigInt({ min: 1n, max: 1_000_000n * 10n ** BigInt(scale) })
    .filter((units) => scale === 0 || units % 10n !== 0n)
    .map((units): Rate => ({ units, scale })),
);

// Written differently from convert on purpose: quotient and remainder, then a
// half-up decision, all in bigint.
function reference(amount: bigint, from: Currency, to: Currency, r: Rate): bigint {
  const numerator = amount * r.units * 10n ** BigInt(to.digits);
  const denominator = 10n ** BigInt(r.scale + from.digits);
  const quotient = numerator / denominator;
  return 2n * (numerator % denominator) >= denominator ? quotient + 1n : quotient;
}

it.each([
  ["0.92", 92n, 2, "0.92"],
  ["150.5", 1505n, 1, "150.5"],
  ["150.50", 1505n, 1, "150.5"],
  ["1", 1n, 0, "1"],
  ["1.0", 1n, 0, "1"],
  ["1.000", 1n, 0, "1"],
  ["100", 100n, 0, "100"],
  ["100.00", 100n, 0, "100"],
  ["0.05", 5n, 2, "0.05"],
  ["0.0000000001", 1n, 10, "0.0000000001"],
  ["1000000", 1000000n, 0, "1000000"],
  ["1000000.0000000000", 1000000n, 0, "1000000"],
])("parseRate reads %j as %s / 10^%i and formatRate prints it as %j", (input, units, scale, printed) => {
  expect(parseRate(input)).toEqual({ ok: true, value: { units, scale } });
  expect(formatRate({ units, scale })).toBe(printed);
});

it("parseRate reads back every canonical rate formatRate prints", () => {
  fc.assert(
    fc.property(canonicalRate, (r) => {
      expect(parseRate(formatRate(r))).toEqual({ ok: true, value: r });
    }),
  );
});

it.each(["-1", "+1", "1e3", " 1", "1 ", "1,5", "", ".5", "5.", "01", "NaN", "Infinity", "１", "0x1"])(
  "parseRate rejects %j as format",
  (input) => {
    expect(parseRate(input)).toEqual({ ok: false, error: "format" });
  },
);

it.each(["0.00000000001", "1.00000000000", "0.00000000000"])("parseRate rejects %j for more than 10 decimals", (input) => {
  expect(parseRate(input)).toEqual({ ok: false, error: "too_precise" });
});

it.each(["0", "0.0", "0.0000000000"])("parseRate rejects %j as zero", (input) => {
  expect(parseRate(input)).toEqual({ ok: false, error: "zero" });
});

it.each(["1000000.0000000001", "1000000.1", "1000001", "99999999999999999999"])(
  "parseRate rejects %j as out of range",
  (input) => {
    expect(parseRate(input)).toEqual({ ok: false, error: "out_of_range" });
  },
);

it.each([
  ["100.00 USD at 0.92 is 92.00 EUR", 10000n, USD, EUR, "0.92", 9200n],
  ["1 USD at 150.5 is 151 JPY, half up from 150.5", 100n, USD, JPY, "150.5", 151n],
  ["1.000 KWD at 3.25 is 3.25 USD", 1000n, KWD, USD, "3.25", 325n],
  ["0.01 at exactly one half rounds up to 0.01", 1n, USD, EUR, "0.5", 1n],
  ["0.05 at one half is 2.5 cents, half up gives 3 not 2", 5n, USD, EUR, "0.5", 3n],
  ["0.03 at one half is 1.5 cents, rounds to 2", 3n, USD, EUR, "0.5", 2n],
  ["0.01 just under one half rounds down to 0", 1n, USD, EUR, "0.4999999999", 0n],
  ["0.01 just over one half rounds up", 1n, USD, EUR, "0.5000000001", 1n],
  ["1 JPY at 2 is 2.00 USD, no rounding needed", 1n, JPY, USD, "2", 200n],
  ["7 JPY at 1 is 7.0000 CLF", 7n, JPY, CLF, "1", 70000n],
  ["1 JPY at 0.001 is 0.001 USD, which rounds to zero", 1n, JPY, USD, "0.001", 0n],
  ["1.2345 CLF at 1 is 1 JPY", 12345n, CLF, JPY, "1", 1n],
] as const)("convert: %s", (_name, amount, from, to, r, expected) => {
  expect(convert(amount, from, to, rate(r))).toBe(expected);
});

it("convert matches a bigint reference exactly for every amount, rate and currency pair", () => {
  const anyCurrency = fc.constantFrom(USD, EUR, JPY, KWD, CLF);
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: MAX_AMOUNT_MINOR }), anyCurrency, anyCurrency, canonicalRate, (amount, from, to, r) => {
      const result = convert(amount, from, to, r);
      expect(typeof result).toBe("bigint");
      expect(result).toBe(reference(amount, from, to, r));
    }),
  );
});
