import { allocate, allocateLike, type MemberId, type Split, type SplitError } from "./allocate";
import { MAX_AMOUNT_MINOR } from "./amount";
import type { Currency } from "./currency";
import { convert, type Rate } from "./rate";
import type { Result } from "./result";

export type Entry =
  | {
      readonly kind: "expense";
      readonly id: string;
      readonly paidBy: MemberId;
      readonly currency: Currency;
      readonly amount: bigint;
      readonly rate: Rate | null;
      readonly split: Split;
    }
  | {
      readonly kind: "payment";
      readonly id: string;
      readonly from: MemberId;
      readonly to: MemberId;
      readonly currency: Currency;
      readonly amount: bigint;
      readonly rate: Rate | null;
    };

export type LedgerError =
  | SplitError
  | "unknown_member"
  | "rate_required"
  | "rate_forbidden"
  | "self_payment"
  | "converts_to_zero"
  | "base_too_large";

export type BaseEntry = {
  readonly id: string;
  readonly baseTotal: bigint;
  readonly deltas: ReadonlyMap<MemberId, bigint>;
};

// The one place an entry amount becomes a base amount, for expenses and payments
// alike. A rate on a base-currency entry is refused rather than ignored, so a
// stored rate can never quietly change meaning.
function inBase(amount: bigint, from: Currency, rate: Rate | null, base: Currency): Result<bigint, LedgerError> {
  if (from.code === base.code) {
    if (rate !== null) return { ok: false, error: "rate_forbidden" };
    return { ok: true, value: amount };
  }
  if (rate === null) return { ok: false, error: "rate_required" };
  const converted = convert(amount, from, base, rate);
  if (converted === 0n) return { ok: false, error: "converts_to_zero" };
  // The same cap as a typed amount: past it a large rate into a currency with more decimals overflows Postgres bigint.
  if (converted > MAX_AMOUNT_MINOR) return { ok: false, error: "base_too_large" };
  return { ok: true, value: converted };
}

/**
 * Turns one expense or payment into base-currency changes to each member's
 * balance. A balance is what the group owes that member: an expense credits
 * the payer with the base total and debits each participant their base part;
 * a payment credits the sender and debits the receiver. The base parts are the
 * own-currency parts re-split over the base total, so they always add up to it.
 * Errors: "unknown_member" for a payer, participant or payment party not in
 * `members`; "self_payment"; "bad_amount" for a payment below 1n; any
 * SplitError from allocate; "rate_forbidden" for a rate on a base-currency
 * entry; "rate_required" for a foreign entry without one; "converts_to_zero";
 * "base_too_large" when the converted amount exceeds MAX_AMOUNT_MINOR.
 * Throws on an unknown entry kind.
 */
export function entryInBase(entry: Entry, base: Currency, members: ReadonlySet<MemberId>): Result<BaseEntry, LedgerError> {
  if (entry.kind === "payment") {
    if (!members.has(entry.from) || !members.has(entry.to)) return { ok: false, error: "unknown_member" };
    if (entry.from === entry.to) return { ok: false, error: "self_payment" };
    if (entry.amount < 1n) return { ok: false, error: "bad_amount" };
    const moved = inBase(entry.amount, entry.currency, entry.rate, base);
    if (!moved.ok) return moved;
    const deltas = new Map([
      [entry.from, -moved.value],
      [entry.to, moved.value],
    ]);
    return { ok: true, value: { id: entry.id, baseTotal: moved.value, deltas } };
  }
  if (entry.kind === "expense") {
    if (!members.has(entry.paidBy)) return { ok: false, error: "unknown_member" };
    const own = allocate(entry.amount, entry.split);
    if (!own.ok) return own;
    for (const memberId of own.value.keys()) {
      if (!members.has(memberId)) return { ok: false, error: "unknown_member" };
    }
    const total = inBase(entry.amount, entry.currency, entry.rate, base);
    if (!total.ok) return total;
    const deltas = new Map([[entry.paidBy, total.value]]);
    for (const [memberId, part] of allocateLike(total.value, own.value)) {
      deltas.set(memberId, (deltas.get(memberId) ?? 0n) - part);
    }
    return { ok: true, value: { id: entry.id, baseTotal: total.value, deltas } };
  }
  throw new Error("unknown_entry_kind");
}

/**
 * Replays entries into one balance per member, in base-currency minor units.
 * Every member in `members` appears in the result, in input order, zeros too.
 * Positive means the group owes that member money.
 * Returns the first entry's error if any entry is invalid.
 * Throws Error("ledger_invariant") if the balances do not sum to exactly 0n,
 * which the construction above rules out; it is a guard, not a code path.
 */
export function balances(
  base: Currency,
  members: readonly MemberId[],
  entries: readonly Entry[],
): Result<ReadonlyMap<MemberId, bigint>, LedgerError> {
  const known = new Set(members);
  const totals = new Map(members.map((memberId) => [memberId, 0n]));
  for (const entry of entries) {
    const changes = entryInBase(entry, base, known);
    if (!changes.ok) return changes;
    for (const [memberId, delta] of changes.value.deltas) {
      totals.set(memberId, (totals.get(memberId) ?? 0n) + delta);
    }
  }
  let sum = 0n;
  for (const amount of totals.values()) sum += amount;
  if (sum !== 0n) throw new Error("ledger_invariant");
  return { ok: true, value: totals };
}
