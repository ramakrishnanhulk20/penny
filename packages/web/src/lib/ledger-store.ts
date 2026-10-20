import { createHash, randomUUID } from "node:crypto";
import {
  balances,
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
import { and, asc, count, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
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
import {
  MAX_MEMBERS,
  MIN_MEMBERS,
  type AddExpenseBody,
  type AddMemberBody,
  type AddPaymentBody,
  type ChangeBaseCurrencyBody,
  type CreateGroupBody,
  type EditExpenseBody,
} from "./api-schemas";
import { hashGroupToken, mintGroupToken } from "./group-token";
import { nameKey } from "./text";

/** Live expenses one group may hold (threat model C26). Adding the 501st is refused. */
export const MAX_LIVE_EXPENSES = 500;
/** Live payments one group may hold (threat model C26). Adding the 501st is refused; an undone one frees its place. */
export const MAX_LIVE_PAYMENTS = 500;
/**
 * Events one group's log may hold (threat model C26). Once it has this many, every write but a link reset is refused.
 */
export const MAX_EVENTS = 10_000;
/** Expense rows one group may hold, deleted ones included (threat model C26). A delete frees no place. */
export const MAX_EXPENSE_ROWS = 2_000;
/** Payment rows one group may hold, undone ones included (threat model C26). An undo frees no place. */
export const MAX_PAYMENT_ROWS = 2_000;

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

/**
 * The whole expense after an edit, in the shape of expense_added, plus the version the edit moved it to. clientId is
 * the one the expense was added with. requestHash is the edit's own, so a retried edit can be recognised; the row
 * keeps the hash of its add, so a retried add still finds its expense after an edit.
 */
export type ExpenseEditedPayload = ExpenseAddedPayload & { version: number };

/** The row keeps all its data; its deleted_at is the created_at of this event, both set in one transaction. */
export type ExpenseDeletedPayload = { expenseId: string };

/** The row keeps all its data; its deleted_at is the created_at of this event, both set in one transaction. */
export type PaymentDeletedPayload = { paymentId: string };

/** Written by createGroup for each first member and by addMember for each later one. */
export type MemberAddedPayload = { memberId: string; name: string; nameKey: string; position: number };

/** The row keeps all its data; its removed_at is the created_at of this event, both set in one transaction. */
export type MemberRemovedPayload = { memberId: string };

/** Only ever written while the group has no expense or payment, so no stored amount was entered against `from`. */
export type BaseCurrencyChangedPayload = { from: string; to: string };

/** Deliberately empty: the log never holds a link token or its hash, old or new. */
export type LinkResetPayload = Record<string, never>;

/** What a group's whole history says, deleted expenses and undone payments included. */
export type LedgerHistory = {
  /** True once the group has had any expense or payment. Its base currency is then fixed (C14). */
  hasEntries: boolean;
  /** Every member named in an expense, as payer or in its split as it stands now, or in a payment. */
  involved: ReadonlySet<string>;
};

function refuse(status: Refusal["status"], code: string): Refusal {
  return { ok: false, status, code };
}

// The same answer an unknown token gets, so a foreign id cannot be told apart from a missing group (C1).
const NOT_FOUND = refuse(404, "not_found");
const STALE_VERSION = refuse(409, "stale_version");
const MEMBER_IN_USE = refuse(409, "member_in_use");
const TOO_FEW_MEMBERS = refuse(409, "too_few_members");
const TOO_MANY_MEMBERS = refuse(409, "too_many_members");
const LIMIT_REACHED = refuse(409, "limit_reached");
// members.position is a smallint, and a removed member keeps their position, so positions only ever grow.
const MAX_POSITION = 32_767;

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

// `marks` names what marks the request rather than the expense or payment (the clientId of an add, the version of an
// edit, the plan version a payment was pressed on), so the hash covers only what gets stored.
function requestHash(input: AddExpenseBody | AddPaymentBody | EditExpenseBody, marks: readonly string[]): string {
  const stored = Object.fromEntries(Object.entries(input).filter(([name]) => !marks.includes(name)));
  return createHash("sha256").update(canonicalJson(stored), "utf8").digest("hex");
}

type ExpenseFields = Pick<AddExpenseBody, "description" | "amount" | "currency" | "rate" | "paidBy" | "split">;

// The one set of checks for an add and an edit, so an edit can never store what an add would refuse. `positions`
// holds this group's current members only, so a member of another group, or a removed one, gets the 404 an unknown
// token gets.
function checkedExpense(
  id: string,
  input: ExpenseFields,
  base: Currency,
  positions: ReadonlyMap<string, number>,
): StoreResult<ExpenseEntry> {
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
    id,
    paidBy: input.paidBy,
    currency: cur,
    amount: amount.value,
    rate,
    split: inPositionOrder(asked.value, positions),
  };
  const checked = entryInBase(entry, base, new Set(positions.keys()));
  if (!checked.ok) return LEDGER_REFUSALS[checked.error];
  return { ok: true, value: entry };
}

async function currentPositions(db: Db, groupId: string): Promise<Map<string, number>> {
  const current = await db
    .select({ id: members.id, position: members.position })
    .from(members)
    .where(and(eq(members.groupId, groupId), isNull(members.removedAt)));
  return new Map(current.map((member) => [member.id, member.position]));
}

function expensePayload(entry: ExpenseEntry, clientId: string, hash: string, description: string): ExpenseAddedPayload {
  return {
    expenseId: entry.id,
    clientId,
    requestHash: hash,
    description,
    currency: entry.currency.code,
    amountMinor: entry.amount.toString(),
    rateUnits: entry.rate === null ? null : entry.rate.units.toString(),
    rateScale: entry.rate === null ? null : String(entry.rate.scale),
    paidBy: entry.paidBy,
    splitMode: entry.split.mode,
    parts: splitWeights(entry.split).map((part) => ({ memberId: part.memberId, weight: part.weight.toString() })),
  };
}

// The request hash of the edit that moved the expense to `version`, or null when no edit did. The payload was written
// by editExpense, but it is still read as untrusted: anything unexpected gives null, which refuses the retry.
async function editHashAt(db: Db, groupId: string, expenseId: string, version: number): Promise<string | null> {
  const [last] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.groupId, groupId), eq(events.entityId, expenseId), eq(events.kind, "expense_edited")))
    .orderBy(desc(events.seq))
    .limit(1);
  if (last === undefined || typeof last.payload !== "object" || last.payload === null) return null;
  const payload = last.payload as Partial<ExpenseEditedPayload>;
  if (payload.version !== version || typeof payload.requestHash !== "string") return null;
  return payload.requestHash;
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

// Holding the group row serialises writes to one group. The row is read again under the lock, so a write that
// resolved its link just before a reset committed is refused like an unknown link (C3), and the base currency used is
// the one stored now, never one a base change has since replaced (C14). Null means answer 404.
async function lockGroup(tx: Db, group: GroupRow): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.id, group.id)).for("update");
  if (row === undefined || row.tokenHash !== group.tokenHash) return null;
  return row;
}

// Deleted expenses, undone payments and the log keep their rows for good, so the live caps alone would let a group grow
// without end. Run under the group row lock and before anything is written. `adding` names the row the write adds.
async function historyFull(tx: Db, groupId: string, adding?: "expense" | "payment"): Promise<boolean> {
  const [{ logged }] = await tx.select({ logged: count() }).from(events).where(eq(events.groupId, groupId));
  if (logged >= MAX_EVENTS) return true;
  if (adding === "expense") {
    const [{ rows }] = await tx.select({ rows: count() }).from(expenses).where(eq(expenses.groupId, groupId));
    return rows >= MAX_EXPENSE_ROWS;
  }
  if (adding === "payment") {
    const [{ rows }] = await tx.select({ rows: count() }).from(payments).where(eq(payments.groupId, groupId));
    return rows >= MAX_PAYMENT_ROWS;
  }
  return false;
}

async function bumpVersion(tx: Db, groupId: string): Promise<void> {
  await tx
    .update(groups)
    .set({ version: sql`${groups.version} + 1` })
    .where(eq(groups.id, groupId));
}

/**
 * Reads which members the group's expenses and payments name, deleted and undone ones included, and whether it has
 * any at all. Parts are reached through this group's expenses, so the lookup walks the parts primary key instead of
 * every group's parts.
 */
export async function loadHistory(db: Db, groupId: string): Promise<LedgerHistory> {
  const payers = await db.selectDistinct({ id: expenses.paidBy }).from(expenses).where(eq(expenses.groupId, groupId));
  const inSplits = await db
    .selectDistinct({ id: expenseParts.memberId })
    .from(expenseParts)
    .where(
      and(
        eq(expenseParts.groupId, groupId),
        inArray(expenseParts.expenseId, db.select({ id: expenses.id }).from(expenses).where(eq(expenses.groupId, groupId))),
      ),
    );
  const sides = await db
    .selectDistinct({ from: payments.fromMember, to: payments.toMember })
    .from(payments)
    .where(eq(payments.groupId, groupId));
  const involved = new Set<string>([
    ...payers.map((row) => row.id),
    ...inSplits.map((row) => row.id),
    ...sides.flatMap((row) => [row.from, row.to]),
  ]);
  // Every expense has a payer and every payment two sides, so these two lists are empty exactly when nothing exists.
  return { hasEntries: payers.length > 0 || sides.length > 0, involved };
}

/**
 * Why one current member cannot be removed, or null when they can. "member_in_use" when they are named in any
 * expense or payment, deleted ones included, or their balance is not exactly zero; "too_few_members" when the group
 * would be left with fewer than MIN_MEMBERS. The one rule behind removeMember and the `removable` flag the page shows.
 */
export function removalBlock(
  memberId: string,
  history: LedgerHistory,
  totals: ReadonlyMap<string, bigint>,
  liveMembers: number,
): "member_in_use" | "too_few_members" | null {
  if (history.involved.has(memberId) || (totals.get(memberId) ?? BigInt(0)) !== BigInt(0)) return "member_in_use";
  if (liveMembers <= MIN_MEMBERS) return "too_few_members";
  return null;
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
 * transaction that also moves the group's version on by one (201).
 * Refuses: 400 with the codes in the API contract; 404 "not_found" for any member id that is not a current member,
 * or when the link was reset after `group` was read; 409 "limit_reached" once the group holds MAX_LIVE_EXPENSES live
 * expenses, MAX_EXPENSE_ROWS expense rows (deleted ones included) or MAX_EVENTS events.
 */
export async function addExpense(
  db: Db,
  group: GroupRow,
  input: AddExpenseBody,
): Promise<StoreResult<{ status: 200 | 201; expenseId: string }>> {
  const hash = requestHash(input, ["clientId"]);
  try {
    return await db.transaction(async (tx) => {
      // Holding the group row serialises writes to one group, so the cap and the clientId check cannot race.
      const locked = await lockGroup(tx, group);
      if (locked === null) return NOT_FOUND;
      const base = storedCurrency(locked.baseCurrency);

      const earlier = await findByClientId(tx, group.id, input.clientId);
      if (earlier !== null) return answerRetry(earlier, hash);

      const [{ live }] = await tx
        .select({ live: count() })
        .from(expenses)
        .where(and(eq(expenses.groupId, group.id), isNull(expenses.deletedAt)));
      if (live >= MAX_LIVE_EXPENSES) return LIMIT_REACHED;
      if (await historyFull(tx, group.id, "expense")) return LIMIT_REACHED;

      const checked = checkedExpense(randomUUID(), input, base, await currentPositions(tx, group.id));
      if (!checked.ok) return checked;
      const entry = checked.value;

      await tx.insert(expenses).values({
        id: entry.id,
        groupId: group.id,
        clientId: input.clientId,
        requestHash: hash,
        description: input.description,
        currency: entry.currency.code,
        amountMinor: entry.amount,
        rateUnits: entry.rate?.units ?? null,
        rateScale: entry.rate?.scale ?? null,
        paidBy: entry.paidBy,
        splitMode: entry.split.mode,
      });
      await tx
        .insert(expenseParts)
        .values(splitWeights(entry.split).map((part) => ({ expenseId: entry.id, groupId: group.id, ...part })));
      const payload = expensePayload(entry, input.clientId, hash, input.description);
      await tx.insert(events).values({ groupId: group.id, kind: "expense_added", entityId: entry.id, payload });
      await bumpVersion(tx, group.id);
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
 * Replaces one live expense of `group` with `input`, but only from the version the editor saw.
 * The new values are checked exactly as addExpense checks them. Then, in one transaction: the row takes the new
 * values and moves its version on by one, its parts are replaced, an expense_edited event is written and the group's
 * version moves on by one (`edited: true`).
 * A retry of the edit that brought the expense to its current version (the expense is at input.version + 1 and that
 * edit had the same request hash) succeeds again with `edited: false` and writes nothing.
 * Precondition: `expenseId` is a uuid; the route checks it, since Postgres throws on anything else.
 * Refuses: 404 "not_found" when no live expense with this id belongs to this group, for any member id that is not
 * a current member, or when the link was reset after `group` was read; 400 with the codes addExpense uses; 409
 * "stale_version" for any other version; 409 "limit_reached" once the group holds MAX_EVENTS events.
 */
export async function editExpense(
  db: Db,
  group: GroupRow,
  expenseId: string,
  input: EditExpenseBody,
): Promise<StoreResult<{ expenseId: string; edited: boolean }>> {
  const hash = requestHash(input, ["version"]);
  return db.transaction(async (tx) => {
    // Under the group row lock the version read here is still the version when the update lands, and a retried edit
    // cannot slip in between the version check and the write.
    const locked = await lockGroup(tx, group);
    if (locked === null) return NOT_FOUND;
    const base = storedCurrency(locked.baseCurrency);

    const [row] = await tx
      .select({ id: expenses.id, clientId: expenses.clientId, version: expenses.version, deletedAt: expenses.deletedAt })
      .from(expenses)
      .where(and(eq(expenses.groupId, group.id), eq(expenses.id, expenseId)))
      .limit(1);
    if (row === undefined || row.deletedAt !== null) return NOT_FOUND;

    // From here on the id is the one Postgres stored, so nothing written carries the caller's spelling of it.
    const checked = checkedExpense(row.id, input, base, await currentPositions(tx, group.id));
    if (!checked.ok) return checked;

    if (row.version !== input.version) {
      const retried =
        row.version === input.version + 1 && (await editHashAt(tx, group.id, row.id, row.version)) === hash;
      return retried ? { ok: true, value: { expenseId: row.id, edited: false } } : STALE_VERSION;
    }
    if (await historyFull(tx, group.id)) return LIMIT_REACHED;

    const entry = checked.value;
    const version = row.version + 1;
    // The version and deleted_at conditions repeat the checks above, so a lost update stays impossible even if the lock
    // were ever removed.
    const updated = await tx
      .update(expenses)
      .set({
        description: input.description,
        currency: entry.currency.code,
        amountMinor: entry.amount,
        rateUnits: entry.rate?.units ?? null,
        rateScale: entry.rate?.scale ?? null,
        paidBy: entry.paidBy,
        splitMode: entry.split.mode,
        version,
      })
      .where(
        and(
          eq(expenses.groupId, group.id),
          eq(expenses.id, row.id),
          eq(expenses.version, row.version),
          isNull(expenses.deletedAt),
        ),
      )
      .returning({ id: expenses.id });
    if (updated.length !== 1) return STALE_VERSION;

    await tx.delete(expenseParts).where(and(eq(expenseParts.groupId, group.id), eq(expenseParts.expenseId, row.id)));
    await tx
      .insert(expenseParts)
      .values(splitWeights(entry.split).map((part) => ({ expenseId: row.id, groupId: group.id, ...part })));
    const payload: ExpenseEditedPayload = { ...expensePayload(entry, row.clientId, hash, input.description), version };
    await tx.insert(events).values({ groupId: group.id, kind: "expense_edited", entityId: row.id, payload });
    await tx
      .update(groups)
      .set({ version: sql`${groups.version} + 1` })
      .where(eq(groups.id, group.id));
    return { ok: true, value: { expenseId: row.id, edited: true } };
  });
}

/**
 * Deletes one expense of `group`, but only from the version the deleter saw: the row keeps its data and gains
 * deleted_at, an expense_deleted event is written and the group's version moves on by one, in one transaction
 * (`deleted: true`). An expense that is already deleted succeeds again with `deleted: false`, whatever the version,
 * and nothing is written.
 * Precondition: `expenseId` is a uuid; the route checks it, since Postgres throws on anything else.
 * Refuses: 404 "not_found" when no expense with this id belongs to this group, or the link was reset after `group`
 * was read; 409 "stale_version" when `version` is not the live expense's current version; 409 "limit_reached" once the
 * group holds MAX_EVENTS events.
 */
export async function deleteExpense(
  db: Db,
  group: GroupRow,
  expenseId: string,
  version: number,
): Promise<StoreResult<{ deleted: boolean }>> {
  return db.transaction(async (tx) => {
    // Under the group row lock two deletes of one expense run one after the other, so only the first one writes.
    if ((await lockGroup(tx, group)) === null) return NOT_FOUND;

    const [row] = await tx
      .select({ id: expenses.id, version: expenses.version, deletedAt: expenses.deletedAt })
      .from(expenses)
      .where(and(eq(expenses.groupId, group.id), eq(expenses.id, expenseId)))
      .limit(1);
    if (row === undefined) return NOT_FOUND;
    if (row.deletedAt !== null) return { ok: true, value: { deleted: false } };
    if (row.version !== version) return STALE_VERSION;
    if (await historyFull(tx, group.id)) return LIMIT_REACHED;

    // now() is the transaction's start time, the same instant the event's created_at gets.
    await tx
      .update(expenses)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(expenses.groupId, group.id), eq(expenses.id, row.id)));
    const payload: ExpenseDeletedPayload = { expenseId: row.id };
    await tx.insert(events).values({ groupId: group.id, kind: "expense_deleted", entityId: row.id, payload });
    await tx
      .update(groups)
      .set({ version: sql`${groups.version} + 1` })
      .where(eq(groups.id, group.id));
    return { ok: true, value: { deleted: true } };
  });
}

/**
 * Records that one current member of `group` paid another, exactly once per clientId, and only on the plan the payer
 * saw.
 * A repeat of an earlier clientId with the same body (compared by request_hash, which leaves out clientId and
 * planVersion) answers 200 with the original payment id and writes nothing, whatever the group's version is now; with
 * a different body it is 409 "client_id_conflict".
 * Otherwise `input.planVersion` must be the group's current version, then the currency, amount and rate are parsed,
 * @penny/core's entryInBase decides whether the payment is valid for this group's current members, and the payment
 * row and a payment_added event are written in one transaction that also moves the group's version on by one (201).
 * Refuses: 400 with the codes in the API contract; 404 "not_found" when `from` or `to` is not a current member of
 * this group, or when the link was reset after `group` was read; 409 "stale_version" when planVersion is not the
 * group's version; 409 "limit_reached" once the group holds MAX_LIVE_PAYMENTS live payments, MAX_PAYMENT_ROWS payment
 * rows (undone ones included) or MAX_EVENTS events.
 */
export async function addPayment(
  db: Db,
  group: GroupRow,
  input: AddPaymentBody,
): Promise<StoreResult<{ status: 200 | 201; paymentId: string }>> {
  const hash = requestHash(input, ["clientId", "planVersion"]);
  try {
    return await db.transaction(async (tx) => {
      // The same group row lock as addExpense, so the cap, the clientId check and the version check cannot race.
      const locked = await lockGroup(tx, group);
      if (locked === null) return NOT_FOUND;
      const base = storedCurrency(locked.baseCurrency);

      const earlier = await findPaymentByClientId(tx, group.id, input.clientId);
      if (earlier !== null) return answerPaymentRetry(earlier, hash);
      // A settle-up line is only right for the plan it was shown on. Every write that can change the plan moves the
      // version, so a press from a phone that has not seen the latest payment, expense or member is refused instead of
      // paying a line that may already be paid.
      if (input.planVersion !== locked.version) return STALE_VERSION;

      const [{ live }] = await tx
        .select({ live: count() })
        .from(payments)
        .where(and(eq(payments.groupId, group.id), isNull(payments.deletedAt)));
      if (live >= MAX_LIVE_PAYMENTS) return LIMIT_REACHED;
      if (await historyFull(tx, group.id, "payment")) return LIMIT_REACHED;

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
 * Undoes one payment of `group`: the row keeps its data and gains deleted_at, a payment_deleted event is written and
 * the group's version moves on by one, in one transaction. A payment that is already undone succeeds again with
 * `undone: false` and nothing is written.
 * Precondition: `paymentId` is a uuid; the route checks it, since Postgres throws on anything else.
 * Refuses: 404 "not_found" when no payment with this id belongs to this group, or the link was reset after `group`
 * was read; 409 "limit_reached" once the group holds MAX_EVENTS events.
 */
export async function undoPayment(db: Db, group: GroupRow, paymentId: string): Promise<StoreResult<{ undone: boolean }>> {
  return db.transaction(async (tx) => {
    // Under the group row lock two undos of one payment run one after the other, so only the first one writes.
    if ((await lockGroup(tx, group)) === null) return NOT_FOUND;

    const [row] = await tx
      .select({ id: payments.id, deletedAt: payments.deletedAt })
      .from(payments)
      .where(and(eq(payments.groupId, group.id), eq(payments.id, paymentId)))
      .limit(1);
    if (row === undefined) return NOT_FOUND;
    if (row.deletedAt !== null) return { ok: true, value: { undone: false } };
    if (await historyFull(tx, group.id)) return LIMIT_REACHED;

    // From here on the id is the one Postgres stored, so the event never carries the caller's spelling of it.
    // now() is the transaction's start time, the same instant the event's created_at gets.
    await tx
      .update(payments)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(payments.groupId, group.id), eq(payments.id, row.id)));
    const payload: PaymentDeletedPayload = { paymentId: row.id };
    await tx.insert(events).values({ groupId: group.id, kind: "payment_deleted", entityId: row.id, payload });
    await bumpVersion(tx, group.id);
    return { ok: true, value: { undone: true } };
  });
}

/**
 * Adds one member to the end of `group`'s list, under the same name rules as group creation. Writes the member row,
 * a member_added event (the one createGroup writes per member) and moves the group's version on by one, in one
 * transaction.
 * Refuses: 404 "not_found" when the link was reset after `group` was read; 409 "too_many_members" once the group
 * holds MAX_MEMBERS live members; 409 "limit_reached" once it holds MAX_EVENTS events; 400 "duplicate_member_name"
 * when a live member already has this name key. The database's partial unique index decides that, so two adds of one
 * name at once cannot both land.
 */
export async function addMember(db: Db, group: GroupRow, input: AddMemberBody): Promise<StoreResult<{ memberId: string }>> {
  const key = nameKey(input.name);
  try {
    return await db.transaction(async (tx) => {
      if ((await lockGroup(tx, group)) === null) return NOT_FOUND;

      const [{ live }] = await tx
        .select({ live: count() })
        .from(members)
        .where(and(eq(members.groupId, group.id), isNull(members.removedAt)));
      if (live >= MAX_MEMBERS) return TOO_MANY_MEMBERS;
      const [{ last }] = await tx
        .select({ last: max(members.position) })
        .from(members)
        .where(eq(members.groupId, group.id));
      const position = (last ?? -1) + 1;
      if (position > MAX_POSITION) return TOO_MANY_MEMBERS;
      if (await historyFull(tx, group.id)) return LIMIT_REACHED;

      const [person] = await tx
        .insert(members)
        .values({ groupId: group.id, name: input.name, nameKey: key, position })
        .returning();
      const payload: MemberAddedPayload = {
        memberId: person.id,
        name: person.name,
        nameKey: person.nameKey,
        position: person.position,
      };
      await tx.insert(events).values({ groupId: group.id, kind: "member_added", entityId: person.id, payload });
      await bumpVersion(tx, group.id);
      return { ok: true, value: { memberId: person.id } };
    });
  } catch (error) {
    if (isUniqueViolation(error, "members_live_name_key_unique")) return refuse(400, "duplicate_member_name");
    throw error;
  }
}

/**
 * Removes one current member of `group` who is named in no expense (as payer or in its split) and no payment,
 * deleted and undone ones included, and whose balance is exactly zero, so no one else's balance can move. The row
 * keeps its data and gains removed_at, a member_removed event is written and the group's version moves on by one, in
 * one transaction (`removed: true`). A member already removed succeeds again with `removed: false` and nothing is
 * written.
 * Precondition: `memberId` is a uuid; the route checks it, since Postgres throws on anything else.
 * Refuses: 404 "not_found" when no member with this id belongs to this group, or the link was reset after `group` was
 * read; 409 "member_in_use" for a member who is named anywhere or has a non-zero balance; 409 "too_few_members" when
 * the group would be left with fewer than MIN_MEMBERS; 409 "limit_reached" once the group holds MAX_EVENTS events.
 */
export async function removeMember(db: Db, group: GroupRow, memberId: string): Promise<StoreResult<{ removed: boolean }>> {
  return db.transaction(async (tx) => {
    // Under the group row lock no expense or payment can name this member between the checks and the removal.
    const locked = await lockGroup(tx, group);
    if (locked === null) return NOT_FOUND;

    const [row] = await tx
      .select({ id: members.id, removedAt: members.removedAt })
      .from(members)
      .where(and(eq(members.groupId, group.id), eq(members.id, memberId)))
      .limit(1);
    if (row === undefined) return NOT_FOUND;
    if (row.removedAt !== null) return { ok: true, value: { removed: false } };

    const history = await loadHistory(tx, group.id);
    const ledger = await loadLedger(tx, group.id);
    const entries = [...ledger.expenses.map((item) => item.entry), ...ledger.payments.map((item) => item.entry)];
    const totals = balances(
      storedCurrency(locked.baseCurrency),
      ledger.members.map((member) => member.id),
      entries,
    );
    if (!totals.ok) throw new Error(`stored_ledger_invalid_${totals.error}`);
    const live = ledger.members.filter((member) => member.current).length;
    const blocked = removalBlock(row.id, history, totals.value, live);
    if (blocked === "member_in_use") return MEMBER_IN_USE;
    if (blocked === "too_few_members") return TOO_FEW_MEMBERS;
    if (await historyFull(tx, group.id)) return LIMIT_REACHED;

    // From here on the id is the one Postgres stored, so the event never carries the caller's spelling of it.
    // now() is the transaction's start time, the same instant the event's created_at gets.
    await tx
      .update(members)
      .set({ removedAt: sql`now()` })
      .where(and(eq(members.groupId, group.id), eq(members.id, row.id)));
    const payload: MemberRemovedPayload = { memberId: row.id };
    await tx.insert(events).values({ groupId: group.id, kind: "member_removed", entityId: row.id, payload });
    await bumpVersion(tx, group.id);
    return { ok: true, value: { removed: true } };
  });
}

/**
 * Changes `group`'s base currency, only while the group has never had an expense or payment, deleted and undone ones
 * included, so no stored rate is ever read against a base it was not entered for (C14). Writes the new code, a
 * base_currency_changed event and moves the group's version on by one, in one transaction (`changed: true`). Asking
 * for the base the group already has succeeds with `changed: false` and writes nothing, whether or not the group has
 * had money.
 * Refuses: 400 "bad_currency" for a code @penny/core does not know; 404 "not_found" when the link was reset after
 * `group` was read; 409 "base_locked" for any other base once the group has had any expense or payment; 409
 * "limit_reached" once it holds MAX_EVENTS events.
 */
export async function changeBaseCurrency(
  db: Db,
  group: GroupRow,
  input: ChangeBaseCurrencyBody,
): Promise<StoreResult<{ changed: boolean }>> {
  const next = currency(input.baseCurrency);
  if (next === null) return refuse(400, "bad_currency");
  return db.transaction(async (tx) => {
    // Under the group row lock no expense or payment can land between the history check and the change.
    const locked = await lockGroup(tx, group);
    if (locked === null) return NOT_FOUND;
    // Nothing would change, so the lock has nothing to protect: a resend of a base already in place is not refused.
    if (locked.baseCurrency === next.code) return { ok: true, value: { changed: false } };
    if ((await loadHistory(tx, group.id)).hasEntries) return refuse(409, "base_locked");
    if (await historyFull(tx, group.id)) return LIMIT_REACHED;

    await tx.update(groups).set({ baseCurrency: next.code }).where(eq(groups.id, group.id));
    const payload: BaseCurrencyChangedPayload = { from: locked.baseCurrency, to: next.code };
    await tx.insert(events).values({ groupId: group.id, kind: "base_currency_changed", entityId: group.id, payload });
    await bumpVersion(tx, group.id);
    return { ok: true, value: { changed: true } };
  });
}

/**
 * Moves `group` to the link token the browser made: that token's hash replaces the old one and a link_reset event that
 * names no token or hash is written, in one transaction (`rotated: true`). The group's version stays as it was: a new
 * link changes no money and no member, so a settle-up plan on screen is still the current one. The token itself is
 * never stored. When the stored hash is already `newToken`'s, because this same reset landed
 * after `group` was read, it succeeds again with `rotated: false` and writes nothing.
 * Precondition: `newToken` passed parseGroupToken; the route's schema checks it.
 * Not held to the history caps: a full group must still be able to cut off a leaked link (C26, C3). The per-group write
 * rate limit in the route still bounds how fast resets can add to the log.
 * Refuses: 400 "invalid_body" when `newToken` is the token `group` was read with, or another group's link; 404
 * "not_found" when a different reset replaced the link after `group` was read, so two resets at once leave one working
 * link, held by whoever made it.
 */
export async function resetLink(db: Db, group: GroupRow, newToken: string): Promise<StoreResult<{ rotated: boolean }>> {
  const nextHash = hashGroupToken(newToken);
  try {
    return await db.transaction(async (tx) => {
      // lockGroup alone would turn this reset's own earlier landing into a 404, so the row is locked and compared here.
      const [row] = await tx.select().from(groups).where(eq(groups.id, group.id)).for("update");
      if (row === undefined) return NOT_FOUND;
      if (row.tokenHash === nextHash) {
        return row.tokenHash === group.tokenHash ? refuse(400, "invalid_body") : { ok: true, value: { rotated: false } };
      }
      if (row.tokenHash !== group.tokenHash) return NOT_FOUND;

      await tx.update(groups).set({ tokenHash: nextHash }).where(eq(groups.tokenHash, nextHash));
      const payload: LinkResetPayload = {};
      await tx.insert(events).values({ groupId: group.id, kind: "link_reset", entityId: group.id, payload });
      return { ok: true, value: { rotated: true } };
    });
  } catch (error) {
    // Only someone already holding the other group's link could send it, so the refusal tells them nothing new.
    if (isUniqueViolation(error, "groups_token_hash_unique")) return refuse(400, "invalid_body");
    throw error;
  }
}
