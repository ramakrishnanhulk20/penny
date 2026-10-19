import {
  allocate,
  allocateLike,
  balances,
  currency,
  entryInBase,
  formatAmount,
  formatRate,
  settle,
  type Currency,
} from "@penny/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { groups, type GroupRow } from "../db/schema";
import type { ExpenseView, GroupView, PaymentView } from "./api-types";
import { loadLedger, type LedgerExpense, type LedgerPayment } from "./ledger-store";

function expenseView(item: LedgerExpense, base: Currency, known: ReadonlySet<string>): ExpenseView {
  const { entry } = item;
  const own = allocate(entry.amount, entry.split);
  const inBase = entryInBase(entry, base, known);
  if (!own.ok || !inBase.ok) throw new Error("stored_expense_invalid");
  // The same re-split the balances use, so each part's base amount is exactly what moved that member's balance.
  const baseParts = allocateLike(inBase.value.baseTotal, own.value);
  const shares =
    entry.split.mode === "shares" ? new Map(entry.split.parts.map((part) => [part.memberId, part.weight])) : null;
  return {
    id: entry.id,
    description: item.description,
    currency: entry.currency.code,
    amount: formatAmount(entry.amount, entry.currency),
    rate: entry.rate === null ? null : formatRate(entry.rate),
    baseAmount: formatAmount(inBase.value.baseTotal, base),
    paidBy: entry.paidBy,
    splitMode: entry.split.mode,
    parts: [...own.value].map(([memberId, amount]) => ({
      memberId,
      amount: formatAmount(amount, entry.currency),
      baseAmount: formatAmount(baseParts.get(memberId) ?? BigInt(0), base),
      ...(shares === null ? {} : { weight: shares.get(memberId) }),
    })),
    version: item.version,
    createdAt: item.createdAt.toISOString(),
  };
}

function paymentView(item: LedgerPayment, base: Currency, known: ReadonlySet<string>): PaymentView {
  const { entry } = item;
  const inBase = entryInBase(entry, base, known);
  if (!inBase.ok) throw new Error("stored_payment_invalid");
  return {
    id: entry.id,
    from: entry.from,
    to: entry.to,
    currency: entry.currency.code,
    amount: formatAmount(entry.amount, entry.currency),
    rate: entry.rate === null ? null : formatRate(entry.rate),
    baseAmount: formatAmount(inBase.value.baseTotal, base),
    createdAt: item.createdAt.toISOString(),
  };
}

/**
 * The whole group as the page shows it: current members in position order, one balance each, the settle-up plan,
 * and the live expenses and live payments newest first, every amount formatted by @penny/core.
 * All reads run in one read-only, repeatable-read transaction, so the view is one consistent moment and this path
 * cannot write. Throws if the balances or the plan fail their own sum checks; such a view is never returned.
 */
export async function buildGroupView(db: Db, group: GroupRow): Promise<GroupView> {
  const base = currency(group.baseCurrency);
  if (base === null) throw new Error("stored_currency_invalid");
  const { version, ledger } = await db.transaction(
    async (tx) => {
      // Read in the same snapshot as the entries rather than taken from `group`: the settle-up buttons key their
      // clientIds on this version, so it must belong to exactly the payments shown.
      const [row] = await tx.select({ version: groups.version }).from(groups).where(eq(groups.id, group.id));
      if (row === undefined) throw new Error("group_missing");
      return { version: row.version, ledger: await loadLedger(tx, group.id) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  // Removed members stay in the sums so their history still adds up; they are only left out of what is shown.
  const everyone = ledger.members.map((member) => member.id);
  const entries = [...ledger.expenses.map((item) => item.entry), ...ledger.payments.map((item) => item.entry)];
  const totals = balances(base, everyone, entries);
  if (!totals.ok) throw new Error(`stored_ledger_invalid_${totals.error}`);
  const transfers = settle(totals.value);

  const current = ledger.members.filter((member) => member.current);
  const shown = current.map((member) => ({ memberId: member.id, amount: totals.value.get(member.id) ?? BigInt(0) }));
  const total = shown.reduce((sum, row) => sum + row.amount, BigInt(0));
  if (total !== BigInt(0)) throw new Error("shown_balances_unbalanced");

  const known = new Set(everyone);
  return {
    id: group.id,
    name: group.name,
    baseCurrency: base.code,
    baseDigits: base.digits,
    version,
    members: current.map((member) => ({ id: member.id, name: member.name })),
    balances: shown.map((row) => ({ memberId: row.memberId, amount: formatAmount(row.amount, base) })),
    total: formatAmount(total, base),
    settlement: {
      transfers: transfers.map((transfer) => ({
        from: transfer.from,
        to: transfer.to,
        amount: formatAmount(transfer.amount, base),
      })),
      expenseCount: ledger.expenses.length,
    },
    expenses: ledger.expenses.map((item) => expenseView(item, base, known)),
    payments: ledger.payments.map((item) => paymentView(item, base, known)),
  };
}
