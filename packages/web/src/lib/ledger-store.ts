import { createHash, randomUUID } from "node:crypto";
import {
  currency,
  entryInBase,
  parseAmount,
  parseRate,
  type AmountError,
  type Currency,
  type Entry,
  type LedgerError,
  type Rate,
  type Split,
} from "@penny/core";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  events,
  expenseParts,
  expenses,
  groups,
  members,
  payments,
  type ExpenseRow,
  type GroupRow,
  type PaymentRow,
} from "../db/schema";
import type { AddExpenseBody, AddPaymentBody, CreateGroupBody } from "./api-schemas";
import { mintGroupToken } from "./group-token";
import { nameKey } from "./text";

/** Live expenses one group may hold (threat model C26). Adding the 501st is refused. */
export const MAX_LIVE_EXPENSES = 500;
/** Live payments one group may hold (threat model C26). Adding the 501st is refused; an undone one frees its place. */
export const MAX_LIVE_PAYMENTS = 500;

export type Refusal = { ok: false; status: 400 | 404 | 409; code: string };
export type StoreResult<T> = { ok: true; value: T } | Refusal;

export type ExpenseEntry = Extract<Entry, { kind: "expense" }>;
export type PaymentEntry = Extract<Entry, { kind: "payment" }>;
export type LedgerMember = { id: string; name: string; position: number; current: boolean };
export type LedgerExpense = { entry: ExpenseEntry; description: string; version: number; createdAt: Date };
export type LedgerPayment = { entry: PaymentEntry; createdAt: Date };
/** Members in position order, removed ones included and marked; live expenses and live payments, each newest first. */
export type Ledger = { members: LedgerMember[]; expenses: LedgerExpense[]; payments: LedgerPayment[] };

/** Everything needed to rebuild an expense row and its parts from the event log alone. */
export type ExpenseAddedPayload = {
  expenseId: string;
  clientId: string;
  requestHash: string;
  description: string;
  currency: string;
  amountMinor: string;
  rateUnits: string | null;
  rateScale: string | null;
  paidBy: string;
  splitMode: Split["mode"];
  parts: { memberId: string; weight: string }[];
};

/** Everything needed to rebuild a payment row from the event log alone. */
export type PaymentAddedPayload = {
  paymentId: string;
  clientId: string;
  requestHash: string;
  from: string;
  to: string;
  currency: string;
  amountMinor: string;
  rateUnits: string | null;
  rateScale: string | null;
};

/** The row keeps all its data; its deleted_at is the created_at of this event, both set in one transaction. */
export type PaymentDeletedPayload = { paymentId: string };

function refuse(status: Refusal["status"], code: string): Refusal {
  return { ok: false, status, code };
}

// The same answer an unknown token gets, so a foreign id cannot be told apart from a missing group (C1).
const NOT_FOUND = refuse(404, "not_found");

const AMOUNT_CODES: Record<AmountError, string> = {
  format: "amount_format",
  too_many_decimals: "amount_too_many_decimals",
  zero: "amount_zero",
  too_large: "amount_too_large",
};

// A Record over the whole union, so a new core error fails the typecheck here instead of escaping as a 500.
const LEDGER_REFUSALS: Record<LedgerError, Refusal> = {
  empty: refuse(400, "split_empty"),
  duplicate_member: refuse(400, "split_duplicate_member"),
  bad_weight: refuse(400, "split_bad_weight"),
  too_many_parts: refuse(400, "split_too_many_parts"),
  exact_sum_mismatch: refuse(400, "split_exact_sum_mismatch"),
  bad_amount: refuse(400, "split_bad_amount"),
  unknown_member: NOT_FOUND,
  rate_required: refuse(400, "rate_required"),
  rate_forbidden: refuse(400, "rate_forbidden"),
  self_payment: refuse(400, "self_payment"),
  converts_to_zero: refuse(400, "converts_to_zero"),
  base_too_large: refuse(400, "base_too_large"),
};

function storedCurrency(code: string): Currency {
  const found = currency(code);
  if (found === null) throw new Error("stored_currency_invalid");
  return found;
}

function storedRate(units: bigint | null, scale: number | null): Rate | null {
  if (units === null || scale === null) return null;
  return { units, scale };
}

// Parts are stored as weights: 1 for an equal split, the share for shares, the minor units for exact.
function storedSplit(mode: string, parts: readonly { memberId: string; weight: bigint }[]): Split {
  switch (mode) {
    case "equal":
      return { mode, members: parts.map((part) => part.memberId) };
    case "shares":
      return { mode, parts: parts.map((part) => ({ memberId: part.memberId, weight: Number(part.weight) })) };
    case "exact":
      return { mode, parts: parts.map((part) => ({ memberId: part.memberId, amount: part.weight })) };
    default:
      throw new Error("stored_split_mode_invalid");
  }
}

function splitMembers(split: Split): string[] {
  return split.mode === "equal" ? [...split.members] : split.parts.map((part) => part.memberId);
}

function splitWeights(split: Split): { memberId: string; weight: bigint }[] {
  switch (split.mode) {
    case "equal":
      return split.members.map((memberId) => ({ memberId, weight: BigInt(1) }));
    case "shares":
      return split.parts.map((part) => ({ memberId: part.memberId, weight: BigInt(part.weight) }));
    case "exact":
      return split.parts.map((part) => ({ memberId: part.memberId, weight: part.amount }));
  }
}

// Leftover cents go to whoever is listed first, and the parts table keeps no order, so every split is put in member
// position order before it is allocated, stored or replayed. The same split then always gives the same cents.
function inPositionOrder(split: Split, positions: ReadonlyMap<string, number>): Split {
  const rank = (memberId: string): number => {
    const position = positions.get(memberId);
    if (position === undefined) throw new Error("ledger_member_missing");
    return position;
  };
  if (split.mode === "equal") return { mode: "equal", members: [...split.members].sort((a, b) => rank(a) - rank(b)) };
  if (split.mode === "shares") {
    return { mode: "shares", parts: [...split.parts].sort((a, b) => rank(a.memberId) - rank(b.memberId)) };
  }
  return { mode: "exact", parts: [...split.parts].sort((a, b) => rank(a.memberId) - rank(b.memberId)) };
}

function requestSplit(split: AddExpenseBody["split"], cur: Currency): StoreResult<Split> {
  if (split.mode !== "exact") return { ok: true, value: split };
  const parts: { memberId: string; amount: bigint }[] = [];
  for (const part of split.parts) {
    const amount = parseAmount(part.amount, cur);
    if (!amount.ok) return refuse(400, "split_bad_amount");
    parts.push({ memberId: part.memberId, amount: amount.value });
  }
  return { ok: true, value: { mode: "exact", parts } };
}

// Keys sorted at every depth, arrays in their given order, so the same request always gives the same text.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(input: AddExpenseBody | AddPaymentBody): string {
  const withoutClientId = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "clientId"));
  return createHash("sha256").update(canonicalJson(withoutClientId), "utf8").digest("hex");
}

function answerRetry(earlier: ExpenseRow, hash: string): StoreResult<{ status: 200 | 201; expenseId: string }> {
  if (earlier.requestHash !== hash) return refuse(409, "client_id_conflict");
  return { ok: true, value: { status: 200, expenseId: earlier.id } };
}

async function findByClientId(db: Db, groupId: string, clientId: string): Promise<ExpenseRow | null> {
  const rows = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.groupId, groupId), eq(expenses.clientId, clientId)))
    .limit(1);
  return rows[0] ?? null;
}

function answerPaymentRetry(earlier: PaymentRow, hash: string): StoreResult<{ status: 200 | 201; paymentId: string }> {
  if (earlier.requestHash !== hash) return refuse(409, "client_id_conflict");
  return { ok: true, value: { status: 200, paymentId: earlier.id } };
}

async function findPaymentByClientId(db: Db, groupId: string, clientId: string): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.groupId, groupId), eq(payments.clientId, clientId)))
    .limit(1);
  return rows[0] ?? null;
}

// Drizzle wraps the driver error, and the Postgres code and constraint name sit on its cause.
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return [error, cause].some((candidate) => {
    const detail = candidate as { code?: unknown; constraint?: unknown } | null;
    return detail?.code === "23505" && detail.constraint === constraint;
  });
}

/**
 * Reads one group's members, live expenses with their parts, and live payments, as @penny/core values.
 * Expenses and payments come newest first. Throws if a stored row cannot be read back (an unknown currency or split
 * mode).
 */
export async function loadLedger(db: Db, groupId: string): Promise<Ledger> {
  const memberRows = await db.select().from(members).where(eq(members.groupId, groupId)).orderBy(asc(members.position));
  const expenseRows = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.groupId, groupId), isNull(expenses.deletedAt)))
    .orderBy(desc(expenses.createdAt), desc(expenses.id));
  // Filtering by expense id uses the parts primary key; the group condition keeps the read inside this group.
  const partRows =
    expenseRows.length === 0
      ? []
      : await db
          .select()
          .from(expenseParts)
          .where(
            and(
              eq(expenseParts.groupId, groupId),
              inArray(
                expenseParts.expenseId,
                expenseRows.map((row) => row.id),
              ),
            ),
          );
  const paymentRows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.groupId, groupId), isNull(payments.deletedAt)))
    .orderBy(desc(payments.createdAt), desc(payments.id));

  const positions = new Map(memberRows.map((row) => [row.id, row.position]));
  const partsByExpense = new Map<string, { memberId: string; weight: bigint }[]>();
  for (const part of partRows) {
    const list = partsByExpense.get(part.expenseId) ?? [];
    list.push({ memberId: part.memberId, weight: part.weight });
    partsByExpense.set(part.expenseId, list);
  }

  return {
    members: memberRows.map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      current: row.removedAt === null,
    })),
    expenses: expenseRows.map((row) => ({
      entry: {
        kind: "expense",
        id: row.id,
        paidBy: row.paidBy,
        currency: storedCurrency(row.currency),
        amount: row.amountMinor,
        rate: storedRate(row.rateUnits, row.rateScale),
        split: inPositionOrder(storedSplit(row.splitMode, partsByExpense.get(row.id) ?? []), positions),
      },
      description: row.description,
      version: row.version,
      createdAt: row.createdAt,
    })),
    payments: paymentRows.map((row) => ({
      entry: {
        kind: "payment",
        id: row.id,
        from: row.fromMember,
        to: row.toMember,
        currency: storedCurrency(row.currency),
        amount: row.amountMinor,
        rate: storedRate(row.rateUnits, row.rateScale),
      },
      createdAt: row.createdAt,
    })),
  };
}

/**
 * Creates a group with its members in the order given, and returns the new link token (shown once, never stored)
 * with the group row. Writes the group, the members, one group_created event and one member_added event per member
 * in one transaction.
 * Refuses: 400 "bad_currency" for a code @penny/core does not know; 400 "duplicate_member_name" when two names share
 * a name key.
 */
export async function createGroup(db: Db, input: CreateGroupBody): Promise<StoreResult<{ token: string; group: GroupRow }>> {
  const base = currency(input.baseCurrency);
  if (base === null) return refuse(400, "bad_currency");
  const keys = input.members.map(nameKey);
  if (new Set(keys).size !== keys.length) return refuse(400, "duplicate_member_name");

  const { token, hash } = mintGroupToken();
  const group = await db.transaction(async (tx) => {
    const [row] = await tx.insert(groups).values({ tokenHash: hash, name: input.name, baseCurrency: base.code }).returning();
    const people = await tx
      .insert(members)
      .values(input.members.map((name, position) => ({ groupId: row.id, name, nameKey: keys[position], position })))
      .returning();
    await tx.insert(events).values({
      groupId: row.id,
      kind: "group_created",
      entityId: row.id,
      payload: { name: row.name, baseCurrency: row.baseCurrency },
    });
    await tx.insert(events).values(
      [...people]
        .sort((a, b) => a.position - b.position)
        .map((person) => ({
          groupId: row.id,
          kind: "member_added",
          entityId: person.id,
          payload: { memberId: person.id, name: person.name, nameKey: person.nameKey, position: person.position },
        })),
    );
    return row;
  });
  return { ok: true, value: { token, group } };
}

/**
 * Adds one expense to `group`, exactly once per clientId.
 * A repeat of an earlier clientId with the same body (compared by request_hash) answers 200 with the original
 * expense id and writes nothing; with a different body it is 409 "client_id_conflict".
 * Otherwise the amount, currency, rate and split are checked by @penny/core, the payer and every split member must
 * be current members of this group, and the expense row, its parts and an expense_added event are written in one
 * transaction (201).
 * Refuses: 400 with the codes in the API contract; 404 "not_found" for any member id that is not a current member;
 * 409 "limit_reached" once the group holds MAX_LIVE_EXPENSES live expenses.
 */
export async function addExpense(
  db: Db,
  group: GroupRow,
  input: AddExpenseBody,
): Promise<StoreResult<{ status: 200 | 201; expenseId: string }>> {
  const base = storedCurrency(group.baseCurrency);
  const hash = requestHash(input);
  try {
    return await db.transaction(async (tx) => {
      // Holding the group row serialises writes to one group, so the cap and the clientId check cannot race.
      await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, group.id)).for("update");

      const earlier = await findByClientId(tx, group.id, input.clientId);
      if (earlier !== null) return answerRetry(earlier, hash);

      const [{ live }] = await tx
        .select({ live: count() })
        .from(expenses)
        .where(and(eq(expenses.groupId, group.id), isNull(expenses.deletedAt)));
      if (live >= MAX_LIVE_EXPENSES) return refuse(409, "limit_reached");

      const current = await tx
        .select({ id: members.id, position: members.position })
        .from(members)
        .where(and(eq(members.groupId, group.id), isNull(members.removedAt)));
      const positions = new Map(current.map((member) => [member.id, member.position]));

      const cur = currency(input.currency);
      if (cur === null) return refuse(400, "bad_currency");
      const amount = parseAmount(input.amount, cur);
      if (!amount.ok) return refuse(400, AMOUNT_CODES[amount.error]);
      let rate: Rate | null = null;
      if (input.rate !== null) {
        const parsed = parseRate(input.rate);
        if (!parsed.ok) return refuse(400, `rate_${parsed.error}`);
        rate = parsed.value;
      }
      const asked = requestSplit(input.split, cur);
      if (!asked.ok) return asked;
      if (![input.paidBy, ...splitMembers(asked.value)].every((memberId) => positions.has(memberId))) return NOT_FOUND;

      const entry: ExpenseEntry = {
        kind: "expense",
        id: randomUUID(),
        paidBy: input.paidBy,
        currency: cur,
        amount: amount.value,
        rate,
        split: inPositionOrder(asked.value, positions),
      };
      const checked = entryInBase(entry, base, new Set(positions.keys()));
      if (!checked.ok) return LEDGER_REFUSALS[checked.error];

      const weights = splitWeights(entry.split);
      await tx.insert(expenses).values({
        id: entry.id,
        groupId: group.id,
        clientId: input.clientId,
        requestHash: hash,
        description: input.description,
        currency: cur.code,
        amountMinor: entry.amount,
        rateUnits: rate?.units ?? null,
        rateScale: rate?.scale ?? null,
        paidBy: entry.paidBy,
        splitMode: entry.split.mode,
      });
      await tx.insert(expenseParts).values(weights.map((part) => ({ expenseId: entry.id, groupId: group.id, ...part })));
      const payload: ExpenseAddedPayload = {
        expenseId: entry.id,
        clientId: input.clientId,
        requestHash: hash,
        description: input.description,
        currency: cur.code,
        amountMinor: entry.amount.toString(),
        rateUnits: rate === null ? null : rate.units.toString(),
        rateScale: rate === null ? null : String(rate.scale),
        paidBy: entry.paidBy,
        splitMode: entry.split.mode,
        parts: weights.map((part) => ({ memberId: part.memberId, weight: part.weight.toString() })),
      };
      await tx.insert(events).values({ groupId: group.id, kind: "expense_added", entityId: entry.id, payload });
      return { ok: true, value: { status: 201, expenseId: entry.id } };
    });
  } catch (error) {
    // The unique constraint is the last word on "one row per clientId", even if the lock above were ever removed.
    if (!isUniqueViolation(error, "expenses_group_id_client_id_unique")) throw error;
    const winner = await findByClientId(db, group.id, input.clientId);
    if (winner === null) throw error;
    return answerRetry(winner, hash);
  }
}

/**
 * Records that one current member of `group` paid another, exactly once per clientId.
 * A repeat of an earlier clientId with the same body (compared by request_hash) answers 200 with the original
 * payment id and writes nothing; with a different body it is 409 "client_id_conflict".
 * Otherwise the currency, amount and rate are parsed, @penny/core's entryInBase decides whether the payment is valid
 * for this group's current members, and the payment row and a payment_added event are written in one transaction
 * that also moves the group's version on by one (201).
 * Refuses: 400 with the codes in the API contract; 404 "not_found" when `from` or `to` is not a current member of
 * this group; 409 "limit_reached" once the group holds MAX_LIVE_PAYMENTS live payments.
 */
export async function addPayment(
  db: Db,
  group: GroupRow,
  input: AddPaymentBody,
): Promise<StoreResult<{ status: 200 | 201; paymentId: string }>> {
  const base = storedCurrency(group.baseCurrency);
  const hash = requestHash(input);
  try {
    return await db.transaction(async (tx) => {
      // The same group row lock as addExpense, so the cap and the clientId check cannot race.
      await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, group.id)).for("update");

      const earlier = await findPaymentByClientId(tx, group.id, input.clientId);
      if (earlier !== null) return answerPaymentRetry(earlier, hash);

      const [{ live }] = await tx
        .select({ live: count() })
        .from(payments)
        .where(and(eq(payments.groupId, group.id), isNull(payments.deletedAt)));
      if (live >= MAX_LIVE_PAYMENTS) return refuse(409, "limit_reached");

      const current = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.groupId, group.id), isNull(members.removedAt)));

      const cur = currency(input.currency);
      if (cur === null) return refuse(400, "bad_currency");
      const amount = parseAmount(input.amount, cur);
      if (!amount.ok) return refuse(400, AMOUNT_CODES[amount.error]);
      let rate: Rate | null = null;
      if (input.rate !== null) {
        const parsed = parseRate(input.rate);
        if (!parsed.ok) return refuse(400, `rate_${parsed.error}`);
        rate = parsed.value;
      }

      const entry: PaymentEntry = {
        kind: "payment",
        id: randomUUID(),
        from: input.from,
        to: input.to,
        currency: cur,
        amount: amount.value,
        rate,
      };
      // Only this group's current members are known here, so a member of another group, or a removed one, comes back
      // as unknown_member and gets the same 404 as an unknown token.
      const checked = entryInBase(entry, base, new Set(current.map((member) => member.id)));
      if (!checked.ok) return LEDGER_REFUSALS[checked.error];

      await tx.insert(payments).values({
        id: entry.id,
        groupId: group.id,
        clientId: input.clientId,
        requestHash: hash,
        fromMember: entry.from,
        toMember: entry.to,
        currency: cur.code,
        amountMinor: entry.amount,
        rateUnits: rate?.units ?? null,
        rateScale: rate?.scale ?? null,
      });
      const payload: PaymentAddedPayload = {
        paymentId: entry.id,
        clientId: input.clientId,
        requestHash: hash,
        from: entry.from,
        to: entry.to,
        currency: cur.code,
        amountMinor: entry.amount.toString(),
        rateUnits: rate === null ? null : rate.units.toString(),
        rateScale: rate === null ? null : String(rate.scale),
      };
      await tx.insert(events).values({ groupId: group.id, kind: "payment_added", entityId: entry.id, payload });
      // The page keys each settle-up line's clientId on the version it shows. Moving it here retires every key built
      // from the old version, so a line shown again later (after an undo, or new expenses) records a fresh payment
      // instead of replaying this one.
      await tx
        .update(groups)
        .set({ version: sql`${groups.version} + 1` })
        .where(eq(groups.id, group.id));
      return { ok: true, value: { status: 201, paymentId: entry.id } };
    });
  } catch (error) {
    // The unique constraint is the last word on "one row per clientId", even if the lock above were ever removed.
    if (!isUniqueViolation(error, "payments_group_id_client_id_unique")) throw error;
    const winner = await findPaymentByClientId(db, group.id, input.clientId);
    if (winner === null) throw error;
    return answerPaymentRetry(winner, hash);
  }
}

/**
 * Undoes one payment of `group`: the row keeps its data and gains deleted_at, and a payment_deleted event is written,
 * in one transaction. A payment that is already undone succeeds again with `undone: false` and nothing is written.
 * Precondition: `paymentId` is a uuid; the route checks it, since Postgres throws on anything else.
 * Refuses: 404 "not_found" when no payment with this id belongs to this group.
 */
export async function undoPayment(db: Db, group: GroupRow, paymentId: string): Promise<StoreResult<{ undone: boolean }>> {
  return db.transaction(async (tx) => {
    // Under the group row lock two undos of one payment run one after the other, so only the first one writes.
    await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, group.id)).for("update");

    const [row] = await tx
      .select({ id: payments.id, deletedAt: payments.deletedAt })
      .from(payments)
      .where(and(eq(payments.groupId, group.id), eq(payments.id, paymentId)))
      .limit(1);
    if (row === undefined) return NOT_FOUND;
    if (row.deletedAt !== null) return { ok: true, value: { undone: false } };

    // From here on the id is the one Postgres stored, so the event never carries the caller's spelling of it.
    // now() is the transaction's start time, the same instant the event's created_at gets.
    await tx
      .update(payments)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(payments.groupId, group.id), eq(payments.id, row.id)));
    const payload: PaymentDeletedPayload = { paymentId: row.id };
    await tx.insert(events).values({ groupId: group.id, kind: "payment_deleted", entityId: row.id, payload });
    return { ok: true, value: { undone: true } };
  });
}
