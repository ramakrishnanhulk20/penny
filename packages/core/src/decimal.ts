// The one decimal grammar that amounts and rates share (threat model C7 and C9),
// so the two can never drift apart. Internal: not re-exported from the package.

// [0-9] is ASCII only in a JavaScript regex without the u or v flag, and $ without
// the m flag matches only at the true end, so a trailing newline is refused too.
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Reads a plain ASCII decimal such as "12.50" into its digits with the point
 * removed ("1250") and the count of digits after the point (2).
 * Returns null for anything outside /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.
 */
export function readDecimal(input: string): { readonly digits: string; readonly scale: number } | null {
  const match = DECIMAL.exec(input);
  if (match === null) return null;
  const fraction = match[1] ?? "";
  return { digits: input.replace(".", ""), scale: fraction.length };
}

/**
 * Writes a non-negative integer count of 10^-scale steps as a decimal with
 * exactly `scale` digits after the point: (1250n, 2) is "12.50", (5n, 0) is "5".
 */
export function writeDecimal(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
