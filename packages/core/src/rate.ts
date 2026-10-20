import type { Currency } from "./currency";
import { readDecimal, writeDecimal } from "./decimal";
import type { Result } from "./result";

/** value = units / 10^scale. Canonical: units has no trailing zero digit unless scale is 0. */
export type Rate = { readonly units: bigint; readonly scale: number };

export const MAX_RATE_SCALE = 10;

const MAX_RATE_VALUE = 1_000_000n;

export type RateError = "format" | "too_precise" | "zero" | "out_of_range";

/**
 * Parses an exchange rate as an exact decimal, never a float.
 * Same grammar as amounts. Errors: "format" outside that grammar, "too_precise"
 * for more than MAX_RATE_SCALE digits after the point (trailing zeros count, as
 * they do for amounts), "zero" for a zero value, "out_of_range" above 1000000.
 * The returned rate is canonical, so "1.50" and "1.5" give the same value.
 */
export function parseRate(input: string): Result<Rate, RateError> {
  const decimal = readDecimal(input);
  if (decimal === null) return { ok: false, error: "format" };
  if (decimal.scale > MAX_RATE_SCALE) return { ok: false, error: "too_precise" };
  let units = BigInt(decimal.digits);
  let scale = decimal.scale;
  if (units === 0n) return { ok: false, error: "zero" };
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  if (units > MAX_RATE_VALUE * 10n ** BigInt(scale)) return { ok: false, error: "out_of_range" };
  return { ok: true, value: { units, scale } };
}

/** Writes a canonical rate as its shortest exact decimal: "0.92", "150.5", "1". */
export function formatRate(rate: Rate): string {
  return writeDecimal(rate.units, rate.scale);
}

/**
 * Converts minor units of `from` into minor units of `to`:
 * amountMinor x rate x 10^(to.digits - from.digits), in exact integer arithmetic,
 * rounded once, half up.
 * Preconditions: amountMinor > 0n and `rate` came from parseRate. The result can
 * be 0n for a tiny amount; the caller decides whether that is allowed.
 */
export function convert(amountMinor: bigint, from: Currency, to: Currency, rate: Rate): bigint {
  const shift = to.digits - from.digits - rate.scale;
  const numerator = amountMinor * rate.units * 10n ** BigInt(Math.max(shift, 0));
  const denominator = 10n ** BigInt(Math.max(-shift, 0));
  return numerator / denominator;
}
