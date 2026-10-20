// Not covered: whether this list matches the newest ISO 4217 list (that is the saved XML the generator reads), or the
// generator itself. This file only notices when a regenerated table drops a code, adds one, or changes its digits, so
// the change is made on purpose: update this list in the same commit and say why.
import { expect, it } from "vitest";
import { ISO4217_CURRENCIES, ISO4217_PUBLISHED } from "../src/currencies.generated";
import { currency } from "../src/index";

// Every code in the table generated from the ISO list published on 2026-09-17, with its minor-unit digits, written out
// as values rather than read from the table, so a regeneration cannot change both sides at once.
const PINNED: readonly (readonly [string, number])[] = [
  ["AED", 2], ["AFN", 2], ["ALL", 2], ["AMD", 2], ["AOA", 2], ["ARS", 2], ["AUD", 2], ["AWG", 2],
  ["AZN", 2], ["BAM", 2], ["BBD", 2], ["BDT", 2], ["BHD", 3], ["BIF", 0], ["BMD", 2], ["BND", 2],
  ["BOB", 2], ["BOV", 2], ["BRL", 2], ["BSD", 2], ["BTN", 2], ["BWP", 2], ["BYN", 2], ["BZD", 2],
  ["CAD", 2], ["CDF", 2], ["CHE", 2], ["CHF", 2], ["CHW", 2], ["CLF", 4], ["CLP", 0], ["CNY", 2],
  ["COP", 2], ["COU", 2], ["CRC", 2], ["CUP", 2], ["CVE", 2], ["CZK", 2], ["DJF", 0], ["DKK", 2],
  ["DOP", 2], ["DZD", 2], ["EGP", 2], ["ERN", 2], ["ETB", 2], ["EUR", 2], ["FJD", 2], ["FKP", 2],
  ["GBP", 2], ["GEL", 2], ["GHS", 2], ["GIP", 2], ["GMD", 2], ["GNF", 0], ["GTQ", 2], ["GYD", 2],
  ["HKD", 2], ["HNL", 2], ["HTG", 2], ["HUF", 2], ["IDR", 2], ["ILS", 2], ["INR", 2], ["IQD", 3],
  ["IRR", 2], ["ISK", 0], ["JMD", 2], ["JOD", 3], ["JPY", 0], ["KES", 2], ["KGS", 2], ["KHR", 2],
  ["KMF", 0], ["KPW", 2], ["KRW", 0], ["KWD", 3], ["KYD", 2], ["KZT", 2], ["LAK", 2], ["LBP", 2],
  ["LKR", 2], ["LRD", 2], ["LSL", 2], ["LYD", 3], ["MAD", 2], ["MDL", 2], ["MGA", 2], ["MKD", 2],
  ["MMK", 2], ["MNT", 2], ["MOP", 2], ["MRU", 2], ["MUR", 2], ["MVR", 2], ["MWK", 2], ["MXN", 2],
  ["MXV", 2], ["MYR", 2], ["MZN", 2], ["NAD", 2], ["NGN", 2], ["NIO", 2], ["NOK", 2], ["NPR", 2],
  ["NZD", 2], ["OMR", 3], ["PAB", 2], ["PEN", 2], ["PGK", 2], ["PHP", 2], ["PKR", 2], ["PLN", 2],
  ["PYG", 0], ["QAR", 2], ["RON", 2], ["RSD", 2], ["RUB", 2], ["RWF", 0], ["SAR", 2], ["SBD", 2],
  ["SCR", 2], ["SDG", 2], ["SEK", 2], ["SGD", 2], ["SHP", 2], ["SLE", 2], ["SOS", 2], ["SRD", 2],
  ["SSP", 2], ["STN", 2], ["SVC", 2], ["SYP", 2], ["SZL", 2], ["THB", 2], ["TJS", 2], ["TMT", 2],
  ["TND", 3], ["TOP", 2], ["TRY", 2], ["TTD", 2], ["TWD", 2], ["TZS", 2], ["UAH", 2], ["UGX", 0],
  ["USD", 2], ["USN", 2], ["UYI", 0], ["UYU", 2], ["UYW", 4], ["UZS", 2], ["VED", 2], ["VES", 2],
  ["VND", 0], ["VUV", 0], ["WST", 2], ["XAD", 2], ["XAF", 0], ["XCD", 2], ["XCG", 2], ["XOF", 0],
  ["XPF", 0], ["YER", 2], ["ZAR", 2], ["ZMW", 2], ["ZWG", 2],
];

it("pins the table as published on 2026-09-17, 165 codes", () => {
  expect([ISO4217_PUBLISHED, PINNED.length]).toEqual(["2026-09-17", 165]);
});

it("finds every pinned code in the generated table with the pinned digits", () => {
  const table = new Map(ISO4217_CURRENCIES.map((entry) => [entry.code, entry.digits]));
  for (const [code, digits] of PINNED) expect([code, table.get(code)]).toEqual([code, digits]);
});

it("finds no code in the generated table that is missing from the pinned list", () => {
  const pinned = new Set(PINNED.map(([code]) => code));
  expect(ISO4217_CURRENCIES.filter((entry) => !pinned.has(entry.code)).map((entry) => entry.code)).toEqual([]);
});

it("pins each code once", () => {
  expect(new Set(PINNED.map(([code]) => code)).size).toBe(PINNED.length);
});

it("answers every pinned code through currency() with the pinned digits", () => {
  for (const [code, digits] of PINNED) expect(currency(code)).toEqual({ code, digits });
});
