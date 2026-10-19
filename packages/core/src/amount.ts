import type { Currency } from "./currency";
import { readDecimal, writeDecimal } from "./decimal";
import type { Result } from "./result";

export const MAX_AMOUNT_MINOR: bigint = 10n ** 12n;

export type AmountError = "format" | "too_many_decimals" | "zero" | "too_large";

/**
 * Parses a typed amount into an exact count of the currency's minor units.
 * Accepts only plain ASCII decimals: no sign, exponent, separators, spaces or
 * leading zeros. Never rounds.
 * Errors: "format" for anything outside that grammar, "too_many_decimals" when
 * there are more digits after the point than the currency has (trailing zeros
 * count), "zero" for a value of zero, "too_large" above MAX_AMOUNT_MINOR.
 */
export function parseAmount(input: string, cur: Currency): Result<bigint, AmountError> {
  const decimal = readDecimal(input);
  if (decimal === null) return { ok: false, error: "format" };
  if (decimal.scale > cur.digits) return { ok: false, error: "too_many_decimals" };
  const minor = BigInt(decimal.digits + "0".repeat(cur.digits - decimal.scale));
  if (minor === 0n) return { ok: false, error: "zero" };
  if (minor > MAX_AMOUNT_MINOR) return { ok: false, error: "too_large" };
  return { ok: true, value: minor };
}

/**
 * Writes minor units as a plain decimal with exactly cur.digits decimals, such
 * as "1234.50" or "-0.05". No grouping, no symbol, no locale: display code adds
 * those, passing the digit count from the ISO table rather than trusting the
 * browser's own currency data.
 */
export function formatAmount(minor: bigint, cur: Currency): string {
  if (minor < 0n) return `-${writeDecimal(-minor, cur.digits)}`;
  return writeDecimal(minor, cur.digits);
}
