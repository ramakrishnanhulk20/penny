import type { Result } from "./result";

export type MemberId = string;

export type Split =
  | { readonly mode: "equal"; readonly members: readonly MemberId[] }
  | { readonly mode: "shares"; readonly parts: readonly { readonly memberId: MemberId; readonly weight: number }[] }
  | { readonly mode: "exact"; readonly parts: readonly { readonly memberId: MemberId; readonly amount: bigint }[] };

export const MAX_PARTS = 50;
export const MAX_WEIGHT = 1000;

export type SplitError =
  | "empty"
  | "duplicate_member"
  | "bad_weight"
  | "too_many_parts"
  | "exact_sum_mismatch"
  | "bad_amount";

type Row = { readonly id: MemberId; readonly position: number; part: bigint; readonly remainder: bigint };

// Largest-remainder method: everyone gets the floor of their exact share, then
// the units left over go one each to the largest remainders, ties to whoever
// was listed first. The floors plus the leftover equal `total` by construction,
// so the parts always add up. Needs total >= 0n, weights >= 0n, a positive sum.
function largestRemainder(total: bigint, weights: readonly (readonly [MemberId, bigint])[]): Map<MemberId, bigint> {
  const weightSum = weights.reduce((sum, [, weight]) => sum + weight, 0n);
  const rows: Row[] = weights.map(([id, weight], position) => {
    const scaled = total * weight;
    return { id, position, part: scaled / weightSum, remainder: scaled % weightSum };
  });
  let leftover = total - rows.reduce((sum, row) => sum + row.part, 0n);
  const ranked = [...rows].sort((a, b) =>
    b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.position - b.position,
  );
  for (const row of ranked) {
    if (leftover === 0n) break;
    row.part += 1n;
    leftover -= 1n;
  }
  return new Map(rows.map((row) => [row.id, row.part]));
}

function memberIds(split: Split): readonly MemberId[] {
  switch (split.mode) {
    case "equal":
      return split.members;
    case "shares":
    case "exact":
      return split.parts.map((part) => part.memberId);
    default:
      throw new Error("unknown_split_mode");
  }
}

/**
 * Splits `total` minor units between members. The parts always sum exactly to
 * `total`, and the same input always gives the same output.
 * Equal: weight 1 each. Shares: integer weights 1..MAX_WEIGHT. Both use the
 * largest-remainder method with ties going to the earlier listed member.
 * Exact: returns the given amounts once they are checked to sum to `total`.
 * Errors: "bad_amount" if total < 1n or an exact amount is not a bigint >= 1n,
 * "empty", "too_many_parts" (over MAX_PARTS), "duplicate_member", "bad_weight",
 * "exact_sum_mismatch". Throws on an unknown split mode.
 */
export function allocate(total: bigint, split: Split): Result<ReadonlyMap<MemberId, bigint>, SplitError> {
  if (total < 1n) return { ok: false, error: "bad_amount" };
  const ids = memberIds(split);
  if (ids.length === 0) return { ok: false, error: "empty" };
  if (ids.length > MAX_PARTS) return { ok: false, error: "too_many_parts" };
  if (new Set(ids).size !== ids.length) return { ok: false, error: "duplicate_member" };
  if (split.mode === "equal") {
    return { ok: true, value: largestRemainder(total, ids.map((id) => [id, 1n] as const)) };
  }
  if (split.mode === "shares") {
    const valid = split.parts.every((p) => Number.isInteger(p.weight) && p.weight >= 1 && p.weight <= MAX_WEIGHT);
    if (!valid) return { ok: false, error: "bad_weight" };
    return { ok: true, value: largestRemainder(total, split.parts.map((p) => [p.memberId, BigInt(p.weight)] as const)) };
  }
  if (!split.parts.every((p) => typeof p.amount === "bigint" && p.amount >= 1n)) {
    return { ok: false, error: "bad_amount" };
  }
  const sum = split.parts.reduce((acc, p) => acc + p.amount, 0n);
  if (sum !== total) return { ok: false, error: "exact_sum_mismatch" };
  return { ok: true, value: new Map(split.parts.map((p) => [p.memberId, p.amount])) };
}

/**
 * Splits `total` in the same proportions as `shape`, using the map's values as
 * weights and its insertion order for ties. The parts sum exactly to `total`,
 * and a member whose weight is 0n gets 0n.
 * Throws if total < 0n, any weight is negative, or no weight is positive.
 */
export function allocateLike(total: bigint, shape: ReadonlyMap<MemberId, bigint>): ReadonlyMap<MemberId, bigint> {
  const weights = [...shape];
  if (total < 0n || weights.some(([, w]) => w < 0n) || !weights.some(([, w]) => w > 0n)) {
    throw new Error("allocate_like_precondition");
  }
  return largestRemainder(total, weights);
}
