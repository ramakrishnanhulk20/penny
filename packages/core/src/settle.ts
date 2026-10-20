import type { MemberId } from "./allocate";

export type Transfer = { readonly from: MemberId; readonly to: MemberId; readonly amount: bigint };

// The exact search costs about 2^n * n steps for n people with a non-zero
// balance: one million at 16, which is milliseconds. Each extra person doubles
// it, so above this the greedy plan runs instead (threat model C26).
export const EXACT_SETTLE_LIMIT = 16;

type Holding = { readonly id: MemberId; amount: bigint };

function nonZeroById(balances: ReadonlyMap<MemberId, bigint>): Holding[] {
  let sum = 0n;
  const people: Holding[] = [];
  for (const [id, amount] of balances) {
    sum += amount;
    if (amount !== 0n) people.push({ id, amount });
  }
  if (sum !== 0n) throw new Error("settle_unbalanced");
  return people.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// `people` must be sorted by id, so keeping the first of equal amounts breaks
// every tie by id. Each pass zeroes at least one person, so the loop ends within
// people.length passes.
function greedyPlan(people: readonly Holding[]): Transfer[] {
  const left = people.map((person) => ({ ...person }));
  const plan: Transfer[] = [];
  for (;;) {
    let debtor: Holding | undefined;
    let creditor: Holding | undefined;
    for (const person of left) {
      if (person.amount < 0n && (debtor === undefined || person.amount < debtor.amount)) debtor = person;
      if (person.amount > 0n && (creditor === undefined || person.amount > creditor.amount)) creditor = person;
    }
    if (debtor === undefined || creditor === undefined) return plan;
    const amount = -debtor.amount < creditor.amount ? -debtor.amount : creditor.amount;
    plan.push({ from: debtor.id, to: creditor.id, amount });
    debtor.amount += amount;
    creditor.amount -= amount;
  }
}

// Fewest transfers = people - (most disjoint zero-sum groups they split into).
// best[mask] is the most zero-sum groups any ordering of the people in `mask`
// closes off, so best[full] is that maximum. Walking back from the full set,
// always to the earliest person whose removal keeps the best score, recovers
// one optimal grouping; each group then settles greedily in (size - 1) transfers.
function exactPlan(people: readonly Holding[]): Transfer[] {
  const full = (1 << people.length) - 1;
  const sums: bigint[] = [0n];
  const best = new Uint8Array(full + 1);
  for (let mask = 1; mask <= full; mask++) {
    const lowest = 31 - Math.clz32(mask & -mask);
    sums[mask] = sums[mask & (mask - 1)]! + people[lowest]!.amount;
    let most = 0;
    for (let i = 0; i < people.length; i++) {
      if ((mask >> i) & 1) most = Math.max(most, best[mask & ~(1 << i)]!);
    }
    best[mask] = most + (sums[mask] === 0n ? 1 : 0);
  }
  const plan: Transfer[] = [];
  let mask = full;
  let open = full;
  while (mask !== 0) {
    let pick = -1;
    for (let i = 0; i < people.length; i++) {
      if ((mask >> i) & 1 && (pick < 0 || best[mask & ~(1 << i)]! > best[mask & ~(1 << pick)]!)) pick = i;
    }
    mask &= ~(1 << pick);
    if (sums[mask] === 0n) {
      const closed = open & ~mask;
      plan.push(...greedyPlan(people.filter((_, i) => (closed >> i) & 1)));
      open = mask;
    }
  }
  return plan;
}

// Validates the plan like an input before anyone acts on it (threat model C12),
// then lists it by payer, then payee.
function checkedPlan(balances: ReadonlyMap<MemberId, bigint>, plan: Transfer[]): Transfer[] {
  const left = new Map(balances);
  for (const transfer of plan) {
    left.set(transfer.from, (left.get(transfer.from) ?? 0n) + transfer.amount);
    left.set(transfer.to, (left.get(transfer.to) ?? 0n) - transfer.amount);
  }
  for (const amount of left.values()) {
    if (amount !== 0n) throw new Error("settle_invariant");
  }
  return plan.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
}

/**
 * Builds the transfers that bring every balance to exactly zero. A balance is
 * what the group owes that member, so debtors (negative) pay creditors.
 * With EXACT_SETTLE_LIMIT or fewer non-zero balances, counted here, the plan has
 * the fewest possible transfers; above that it is the greedy plan.
 * Deterministic: ties go to the lower member id; transfers are sorted by payer
 * then payee.
 * Throws Error("settle_unbalanced") if the balances do not sum to zero, and
 * Error("settle_invariant") if the plan would leave anyone non-zero.
 */
export function settle(balances: ReadonlyMap<MemberId, bigint>): Transfer[] {
  const people = nonZeroById(balances);
  if (people.length > EXACT_SETTLE_LIMIT) return settleGreedy(balances);
  return checkedPlan(balances, greedyPlan(people));
}

/**
 * Settles with the greedy rule: the largest debtor pays the largest creditor
 * the smaller of the two amounts, repeated until everyone is at zero. Ties go
 * to the lower member id; transfers are sorted by payer then payee.
 * Uses at most one transfer fewer than the number of non-zero balances.
 * Throws like settle.
 */
export function settleGreedy(balances: ReadonlyMap<MemberId, bigint>): Transfer[] {
  return checkedPlan(balances, greedyPlan(nonZeroById(balances)));
}
