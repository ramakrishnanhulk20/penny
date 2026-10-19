import { formatRate, parseRate } from "@penny/core";

/** A reference rate the form may prefill, or none. */
export type RateLookup = { readonly ok: true; readonly rate: string; readonly date: string } | { readonly ok: false };

const NO_RATE: RateLookup = { ok: false };
const DATE_FORMAT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * GET /api/fx for one pair of currency codes. Gives the rate only when the server answered 200 with a rate that
 * core's parseRate accepts and a YYYY-MM-DD date, so the field is only ever prefilled with a value the form itself
 * would send. Any other answer, a network failure or an abort through `signal` gives no rate.
 */
export async function lookUpRate(from: string, to: string, signal?: AbortSignal): Promise<RateLookup> {
  const query = new URLSearchParams({ from, to });
  let response: Response;
  try {
    response = await fetch(`/api/fx?${query}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal,
    });
  } catch {
    return NO_RATE;
  }
  if (response.status !== 200) return NO_RATE;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return NO_RATE;
  }
  if (typeof body !== "object" || body === null) return NO_RATE;
  const { rate, date } = body as Record<string, unknown>;
  if (typeof rate !== "string" || typeof date !== "string" || !DATE_FORMAT.test(date)) return NO_RATE;
  const parsed = parseRate(rate);
  return parsed.ok ? { ok: true, rate: formatRate(parsed.value), date } : NO_RATE;
}
