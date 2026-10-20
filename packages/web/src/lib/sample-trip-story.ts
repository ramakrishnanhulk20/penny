import {
  allocate,
  allocateLike,
  balances,
  currency,
  entryInBase,
  formatAmount,
  formatRate,
  parseAmount,
  parseRate,
  settle,
  type Currency,
  type Entry,
  type Rate,
  type Split,
} from "@penny/core";
import { SAMPLE_EXPENSES, SAMPLE_GROUP, SAMPLE_PEOPLE, type Person, type SampleExpense, type SampleSplit } from "./sample-trip-data";
import { balanceLine, proofLine } from "./settle-words";

export type StoryExpense = {
  readonly id: string;
  readonly description: string;
  readonly paidBy: Person;
  readonly amount: string;
  readonly currency: string;
  readonly rate: string | null;
  readonly base: string;
  readonly parts: readonly { readonly person: Person; readonly base: string }[];
};
export type StoryBalance = { readonly person: Person; readonly amount: string; readonly sentence: string };
export type StoryPayment = { readonly from: Person; readonly to: Person; readonly amount: string };
export type SampleTripStory = {
  readonly groupName: string;
  readonly baseCurrency: string;
  readonly people: readonly Person[];
  readonly expenses: readonly StoryExpense[];
  readonly balances: readonly StoryBalance[];
  readonly payments: readonly StoryPayment[];
  readonly proof: string;
};

type ExpenseEntry = Extract<Entry, { kind: "expense" }>;

function personOf(id: string): Person {
  const person = SAMPLE_PEOPLE.find((candidate) => candidate === id);
  if (person === undefined) throw new Error("sample_trip_story_unknown_person");
  return person;
}

function currencyOf(code: string): Currency {
  const found = currency(code);
  if (found === null) throw new Error("sample_trip_story_currency");
  return found;
}

function amountIn(text: string, cur: Currency): bigint {
  const parsed = parseAmount(text, cur);
  if (!parsed.ok) throw new Error(`sample_trip_story_amount_${parsed.error}`);
  return parsed.value;
}

function rateOf(text: string | null): Rate | null {
  if (text === null) return null;
  const parsed = parseRate(text);
  if (!parsed.ok) throw new Error(`sample_trip_story_rate_${parsed.error}`);
  return parsed.value;
}

// Leftover cents go to whoever is listed first, and the store lists every split in member position order before it
// allocates, so the story lists them the same way to land on the same cents.
function coreSplit(split: SampleSplit, cur: Currency, people: readonly Person[]): Split {
  const rank = (person: Person): number => {
    const position = people.indexOf(person);
    if (position < 0) throw new Error("sample_trip_story_unknown_person");
    return position;
  };
  switch (split.mode) {
    case "equal":
      return { mode: "equal", members: [...split.members].sort((a, b) => rank(a) - rank(b)) };
    case "shares":
      return {
        mode: "shares",
        parts: [...split.parts]
          .sort((a, b) => rank(a.person) - rank(b.person))
          .map((part) => ({ memberId: part.person, weight: part.weight })),
      };
    case "exact":
      return {
        mode: "exact",
        parts: [...split.parts]
          .sort((a, b) => rank(a.person) - rank(b.person))
          .map((part) => ({ memberId: part.person, amount: amountIn(part.amount, cur) })),
      };
  }
}

function storyExpense(
  expense: SampleExpense,
  id: string,
  base: Currency,
  people: readonly Person[],
): { readonly entry: ExpenseEntry; readonly told: StoryExpense } {
  const cur = currencyOf(expense.currency);
  const entry: ExpenseEntry = {
    kind: "expense",
    id,
    paidBy: expense.paidBy,
    currency: cur,
    amount: amountIn(expense.amount, cur),
    rate: rateOf(expense.rate),
    split: coreSplit(expense.split, cur, people),
  };
  const own = allocate(entry.amount, entry.split);
  if (!own.ok) throw new Error(`sample_trip_story_split_${own.error}`);
  const inBase = entryInBase(entry, base, new Set(people));
  if (!inBase.ok) throw new Error(`sample_trip_story_expense_${inBase.error}`);
  // The same re-split the balances use, so each part is exactly what moved that person's balance.
  const baseParts = allocateLike(inBase.value.baseTotal, own.value);
  const parts = people
    .filter((person) => own.value.has(person))
    .map((person) => {
      const part = baseParts.get(person);
      if (part === undefined) throw new Error("sample_trip_story_part_missing");
      return { person, base: formatAmount(part, base) };
    });
  return {
    entry,
    told: {
      id,
      description: expense.description,
      paidBy: expense.paidBy,
      amount: formatAmount(entry.amount, cur),
      currency: cur.code,
      rate: entry.rate === null ? null : formatRate(entry.rate),
      base: formatAmount(inBase.value.baseTotal, base),
      parts,
    },
  };
}

/**
 * The sample trip as the landing page tells it, worked out by @penny/core from the same definition "Try a sample
 * trip" sends to the server, so the page never shows a number the engine did not produce. Every value is a plain
 * string or array, safe to pass from a server component to the browser.
 * Expenses are e1 to e7 in the order they are added. Balances and their sentences match the group page. The payments
 * are core's settle plan in core's order, which sorts by payer then payee; here the names stand in for member ids, so
 * the order is by name, while a real group orders the same lines by its random member ids.
 * Throws if core refuses any part of the data. The data is fixed, so a throw is a bug, and the sample trip test fails.
 */
export function sampleTripStory(): SampleTripStory {
  const base = currencyOf(SAMPLE_GROUP.baseCurrency);
  const people = SAMPLE_GROUP.members.map(personOf);
  const built = SAMPLE_EXPENSES.map((expense, index) => storyExpense(expense, `e${index + 1}`, base, people));

  const totals = balances(base, people, built.map((item) => item.entry));
  if (!totals.ok) throw new Error(`sample_trip_story_ledger_${totals.error}`);
  const expenses = built.map((item) => item.told);
  const payments = settle(totals.value).map((transfer) => ({
    from: personOf(transfer.from),
    to: personOf(transfer.to),
    amount: formatAmount(transfer.amount, base),
  }));

  return {
    groupName: SAMPLE_GROUP.name,
    baseCurrency: base.code,
    people,
    expenses,
    balances: people.map((person) => {
      const minor = totals.value.get(person);
      if (minor === undefined) throw new Error("sample_trip_story_balance_missing");
      const amount = formatAmount(minor, base);
      return { person, amount, sentence: balanceLine(person, amount, base.code) };
    }),
    payments,
    proof: proofLine(payments.length, expenses.length),
  };
}
