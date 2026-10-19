import { ISO4217_CURRENCIES } from "./currencies.generated";

export type Currency = { readonly code: string; readonly digits: number };

const byCode: ReadonlyMap<string, Currency> = new Map(ISO4217_CURRENCIES.map((c) => [c.code, c]));

/**
 * Looks up an ISO 4217 currency that has a defined minor unit.
 * The code must already be exactly three uppercase ASCII letters: it is never
 * case folded, so "usd" is refused rather than quietly read as "USD".
 * Returns null for anything else, including N.A. codes such as XAU and XXX.
 */
export function currency(code: string): Currency | null {
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return byCode.get(code) ?? null;
}

/** Every supported currency, sorted by code. The array and its items are frozen. */
export function listCurrencies(): readonly Currency[] {
  return ISO4217_CURRENCIES;
}
