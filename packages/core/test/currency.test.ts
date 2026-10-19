// Not covered: whether the saved XML is the newest ISO list, or the generator script itself.
// This file checks only the table the generator produced.
import { expect, it } from "vitest";
import { ISO4217_PUBLISHED } from "../src/currencies.generated";
import { currency, listCurrencies } from "../src/index";

it.each([
  ["USD", 2],
  ["EUR", 2],
  ["JPY", 0],
  ["KWD", 3],
  ["IQD", 3],
  ["CLF", 4],
  ["XAF", 0],
  ["XOF", 0],
  ["XPF", 0],
  ["XCD", 2],
])("currency knows %s with %i minor digits", (code, digits) => {
  expect(currency(code)).toEqual({ code, digits });
});

it.each(["XAU", "XAG", "XDR", "XXX", "XTS"])("currency refuses %s, which has no minor unit in ISO 4217", (code) => {
  expect(currency(code)).toBeNull();
});

it.each(["usd", "Usd", "US", "USDD", "", " USD", "USD ", "USD\n", "ＵＳＤ", "ZZZ"])("currency refuses %j", (code) => {
  expect(currency(code)).toBeNull();
});

it("listCurrencies has every currency once, sorted by code, frozen, and each one looks itself up", () => {
  const all = listCurrencies();
  const codes = all.map((c) => c.code);
  expect(codes).toEqual([...codes].sort());
  expect(new Set(codes).size).toBe(codes.length);
  expect(Object.isFrozen(all)).toBe(true);
  for (const c of all) {
    expect(Object.isFrozen(c)).toBe(true);
    expect(currency(c.code)).toBe(c);
  }
});

it("the generated table records the ISO list publish date", () => {
  expect(ISO4217_PUBLISHED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
