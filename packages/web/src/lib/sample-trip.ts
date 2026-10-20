import { randomUUID } from "node:crypto";
import type { Db } from "@/db/client";
import type { GroupRow } from "@/db/schema";
import { addExpenseBody, createGroupBody } from "./api-schemas";
import type { AddExpenseRequest, SplitRequest } from "./api-types";
import { addExpense, createGroup, loadLedger } from "./ledger-store";
import { SAMPLE_EXPENSES, SAMPLE_GROUP, type Person, type SampleSplit } from "./sample-trip-data";

function splitRequest(split: SampleSplit, idOf: (person: Person) => string): SplitRequest {
  switch (split.mode) {
    case "equal":
      return { mode: "equal", members: split.members.map(idOf) };
    case "shares":
      return { mode: "shares", parts: split.parts.map((part) => ({ memberId: idOf(part.person), weight: part.weight })) };
    case "exact":
      return { mode: "exact", parts: split.parts.map((part) => ({ memberId: idOf(part.person), amount: part.amount })) };
  }
}

/**
 * Creates a brand-new "Lisbon trip" group in EUR with Ana, Ben, Cy and Dev and seven expenses, and returns its new
 * link token (shown once, never stored) with the group row. Every request goes through the same schema and the same
 * store functions a person's requests do (createGroupBody then createGroup, addExpenseBody then addExpense), so it
 * gets the same checks and writes the same events. Each call makes a separate group with its own token; no fixed
 * sample group exists (threat model C27). Throws if any step is refused or the database fails; the half-made group
 * is then unreachable, because its token is never returned.
 */
export async function createSampleTrip(db: Db): Promise<{ token: string; group: GroupRow }> {
  const groupBody = createGroupBody.safeParse(SAMPLE_GROUP);
  if (!groupBody.success) throw new Error("sample_trip_group_refused");
  const created = await createGroup(db, groupBody.data);
  if (!created.ok) throw new Error("sample_trip_group_refused");
  const { group } = created.value;

  const { members } = await loadLedger(db, group.id);
  const ids = new Map(members.map((member) => [member.name, member.id]));
  const idOf = (person: Person): string => {
    const id = ids.get(person);
    if (id === undefined) throw new Error("sample_trip_member_missing");
    return id;
  };

  for (const expense of SAMPLE_EXPENSES) {
    const request: AddExpenseRequest = {
      clientId: randomUUID(),
      description: expense.description,
      amount: expense.amount,
      currency: expense.currency,
      rate: expense.rate,
      paidBy: idOf(expense.paidBy),
      split: splitRequest(expense.split, idOf),
    };
    const body = addExpenseBody.safeParse(request);
    if (!body.success) throw new Error("sample_trip_expense_refused");
    const added = await addExpense(db, group, body.data);
    if (!added.ok || added.value.status !== 201) throw new Error("sample_trip_expense_refused");
  }
  return created.value;
}
