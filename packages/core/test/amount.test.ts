// Not covered: display with symbols, grouping or locale (the web app adds those), or a cap on
// input length, which threat model C6 places at the API boundary.
import fc from "fast-check";
import { expect, it } from "vitest";
import { currency, formatAmount, MAX_AMOUNT_MINOR, parseAmount, type Currency } from "../src/index";

function known(code: string): Currency {
  const found = currency(code);
  if (found === null) throw new Error(`missing currency ${code}`);
  return found;
}

const USD = known("USD");
const JPY = known("JPY");
const KWD = known("KWD");
const CLF = known("CLF");

it.each([
  ["0.01", USD, 1n],
  ["0.1", USD, 10n],
  ["1", USD, 100n],
  ["1.5", USD, 150n],
  ["1.50", USD, 150n],
  ["1234.56", USD, 123456n],
  ["9999999999.99", USD, MAX_AMOUNT_MINOR - 1n],
  ["10000000000", USD, MAX_AMOUNT_MINOR],
  ["10000000000.00", USD, MAX_AMOUNT_MINOR],
  ["1", JPY, 1n],
  ["1000000000000", JPY, MAX_AMOUNT_MINOR],
  ["0.001", KWD, 1n],
  ["1.234", KWD, 1234n],
  ["0.0001", CLF, 1n],
] as const)("parseAmount accepts %j in %o", (input, cur, expected) => {
  expect(parseAmount(input, cur)).toEqual({ ok: true, value: expected });
});

it.each([
  ["-1", "sign"],
  ["+1", "sign"],
  ["-0.01", "sign"],
  ["1e3", "exponent"],
  ["1E3", "exponent"],
  ["1.5e2", "exponent"],
  ["0x10", "hex"],
  ["0b1", "binary"],
  [" 1", "leading space"],
  ["1 ", "trailing space"],
  ["1 000", "inner space"],
  ["\t1", "tab"],
  ["1\n", "trailing newline"],
  ["1 000", "no-break space"],
  ["1,000", "thousands separator"],
  ["1_000", "underscore separator"],
  ["1,5", "comma decimal"],
  ["１２", "full-width digits"],
  ["١٢", "Arabic-Indic digits"],
  ["NaN", "NaN"],
  ["Infinity", "Infinity"],
  ["-Infinity", "negative Infinity"],
  [".5", "leading point"],
  ["5.", "trailing point"],
  ["01", "leading zero"],
  ["00", "double zero"],
  ["00.5", "leading zero before point"],
  ["1.2.3", "two points"],
  ["", "empty"],
  [".", "lone point"],
  ["$1", "symbol"],
])("parseAmount rejects %j (%s) as format, never rounding", (input) => {
  expect(parseAmount(input, USD)).toEqual({ ok: false, error: "format" });
});

it.each([
  ["1.234", USD],
  ["1.230", USD],
  ["0.001", USD],
  ["0.000", USD],
  ["1.0", JPY],
  ["1.5", JPY],
  ["1.2340", KWD],
] as const)("parseAmount rejects %j in %o as too many decimals", (input, cur) => {
  expect(parseAmount(input, cur)).toEqual({ ok: false, error: "too_many_decimals" });
});

it.each([
  ["0", USD],
  ["0.0", USD],
  ["0.00", USD],
  ["0", JPY],
] as const)("parseAmount rejects %j in %o as zero", (input, cur) => {
  expect(parseAmount(input, cur)).toEqual({ ok: false, error: "zero" });
});

it.each([
  ["10000000000.01", USD],
  ["99999999999", USD],
  ["1000000000001", JPY],
  ["1".padEnd(400, "0"), USD],
] as const)("parseAmount rejects %j in %o as too large", (input, cur) => {
  expect(parseAmount(input, cur)).toEqual({ ok: false, error: "too_large" });
});

it.each([
  [0n, USD, "0.00"],
  [5n, USD, "0.05"],
  [50n, USD, "0.50"],
  [123450n, USD, "1234.50"],
  [-5n, USD, "-0.05"],
  [-123450n, USD, "-1234.50"],
  [0n, JPY, "0"],
  [1234n, JPY, "1234"],
  [-1234n, JPY, "-1234"],
  [1n, KWD, "0.001"],
  [12345n, CLF, "1.2345"],
  [MAX_AMOUNT_MINOR, USD, "10000000000.00"],
] as const)("formatAmount writes %s minor units of %o as %j", (minor, cur, expected) => {
  expect(formatAmount(minor, cur)).toBe(expected);
});

it.each([USD, JPY, KWD])("parseAmount reads back every formatted amount from 1 to MAX in %o", (cur) => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: MAX_AMOUNT_MINOR }), (x) => {
      expect(parseAmount(formatAmount(x, cur), cur)).toEqual({ ok: true, value: x });
    }),
  );
});
