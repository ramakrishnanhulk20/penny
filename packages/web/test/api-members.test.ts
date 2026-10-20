// Not covered: the page's Members and Base currency controls (they need a browser), two writers truly overlapping
// (PGlite runs one transaction at a time), rate limits, or the Neon driver.
import { asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events, groups, members } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { AddMemberResponse, CreateGroupResponse, GroupView, RemoveMemberResponse } from "@/lib/api-types";
import { mintGroupToken } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { changeBaseCurrency, removalBlock } from "@/lib/ledger-store";
import {
  deleteExpense,
  deleteMember,
  deletePayment,
  errorCode,
  expenseBody,
  patchGroup,
  paymentBody,
  postExpense,
  postMember,
  postPayment,
  readGroup,
  startGroup,
} from "./fixtures";

vi.mock("next/server", () => ({ connection: async () => undefined }));

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(() => {
  setDbForTests(null);
});

const NOT_FOUND_BODY = '{"error":{"code":"not_found"}}';

// Everything a refused request must leave alone: the view, the member rows and the event log of one group.
async function stateOf(token: string) {
  const view = await readGroup(token);
  const rows = await db.select().from(members).where(eq(members.groupId, view.id)).orderBy(asc(members.position));
  const [logged] = await db.select({ n: count() }).from(events).where(eq(events.groupId, view.id));
  return { view, rows, events: logged.n };
}

async function added(token: string, name: string): Promise<AddMemberResponse> {
  const response = await postMember(token, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as AddMemberResponse;
}

async function removed(token: string, memberId: string): Promise<RemoveMemberResponse> {
  const response = await deleteMember(token, memberId);
  expect(response.status).toBe(200);
  return (await response.json()) as RemoveMemberResponse;
}

async function refusal(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

function idOf(group: GroupView, name: string): string {
  const member = group.members.find((item) => item.name === name);
  if (member === undefined) throw new Error(`no member called ${name}`);
  return member.id;
}

describe("adding a member", () => {
  it("answers 201 with the member, puts them last, writes member_added and moves the version on", async () => {
    const { token, group } = await startGroup();

    const { member, group: after } = await added(token, "  Dev  ");

    expect(member).toEqual({ id: expect.any(String), name: "Dev", removable: true });
    expect(after.members.map((item) => item.name)).toEqual(["Ana", "Ben", "Chen", "Dev"]);
    expect(after.balances).toContainEqual({ memberId: member.id, amount: "0.00" });
    expect(after.version).toBe(group.version + 1);
    expect(await readGroup(token)).toEqual(after);
    const log = await db.select().from(events).where(eq(events.entityId, member.id));
    expect(log.map((row) => [row.kind, row.payload])).toEqual([
      ["member_added", { memberId: member.id, name: "Dev", nameKey: "dev", position: 3 }],
    ]);
  });

  it.each([
    ["the same name in another letter case", "ana"],
    ["the same name with its accent decomposed", "José"],
  ])("refuses %s with 400 duplicate_member_name and changes nothing", async (_label, name) => {
    const { token } = await startGroup({ members: ["Ana", "José"] });
    const before = await stateOf(token);

    const response = await postMember(token, { name });

    expect(await refusal(response)).toEqual({ status: 400, body: '{"error":{"code":"duplicate_member_name"}}' });
    expect(await stateOf(token)).toEqual(before);
  });

  it("lets the unique index refuse the second of two identical adds sent at once, so one row is written", async () => {
    const { token, group } = await startGroup();

    const answers = await Promise.all([postMember(token, { name: "Dev" }), postMember(token, { name: "Dev" })]);

    expect(answers.map((response) => response.status).sort()).toEqual([201, 400]);
    const rows = await db.select().from(members).where(eq(members.groupId, group.id));
    expect(rows.filter((row) => row.nameKey === "dev")).toHaveLength(1);
  });

  it.each([
    ["bad_member_name", "a 41 character name", { name: "m".repeat(41) }],
    ["bad_member_name", "an empty name", { name: "   " }],
    ["bad_member_name", "a lone surrogate, which JSON carries as an escape", { name: "Dev\ud800" }],
    ["bad_member_name", "two zero-width joiners in a row", { name: "B\u200D\u200Den" }],
    ["invalid_body", "an unknown field", { name: "Dev", position: 0 }],
    ["invalid_body", "a missing name", {}],
    ["invalid_body", "a number for the name", { name: 7 }],
    ["invalid_body", "a body over 16 KB", { name: "x".repeat(17 * 1024) }],
  ])("answers 400 %s for %s and changes nothing", async (code, _label, body) => {
    const { token } = await startGroup();
    const before = await stateOf(token);

    const response = await postMember(token, body);

    expect(await refusal(response)).toEqual({ status: 400, body: JSON.stringify({ error: { code } }) });
    expect(await stateOf(token)).toEqual(before);
  });

  it("accepts a 40 character name, counting an emoji as one character", async () => {
    const { token } = await startGroup();

    const { member } = await added(token, "\u{1F600}".repeat(40));

    expect([...member.name]).toHaveLength(40);
  });

  it("refuses a 21st member with 409 too_many_members, and takes one again once a place is free", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `Member ${i + 1}`);
    const { token, group } = await startGroup({ members: names });
    const before = await stateOf(token);

    const over = await postMember(token, { name: "Member 21" });

    expect(await refusal(over)).toEqual({ status: 409, body: '{"error":{"code":"too_many_members"}}' });
    expect(await stateOf(token)).toEqual(before);
    await removed(token, group.members[19].id);
    const { member } = await added(token, "Member 21");
    const [row] = await db.select().from(members).where(eq(members.id, member.id));
    // The removed member keeps position 19, so the next free one is 20.
    expect(row.position).toBe(20);
  });

  it("answers an unknown token with the plain 404", async () => {
    const response = await postMember(mintGroupToken().token, { name: "Dev" });

    expect(await refusal(response)).toEqual({ status: 404, body: NOT_FOUND_BODY });
  });
});

describe("removing a member", () => {
  it("removes a member who was never part of any money, keeps the row, writes member_removed and moves the version on", async () => {
    const { token } = await startGroup();
    const { member, group: before } = await added(token, "Dev");

    const { group: after } = await removed(token, member.id);

    expect(after.members.map((item) => item.name)).toEqual(["Ana", "Ben", "Chen"]);
    expect(after.balances.map((row) => row.memberId)).not.toContain(member.id);
    expect(after.total).toBe("0.00");
    expect(after.version).toBe(before.version + 1);
    expect(await readGroup(token)).toEqual(after);
    const [row] = await db.select().from(members).where(eq(members.id, member.id));
    expect(row.removedAt).toBeInstanceOf(Date);
    expect(row.name).toBe("Dev");
    const log = await db.select().from(events).where(eq(events.entityId, member.id)).orderBy(asc(events.seq));
    expect(log.map((item) => [item.kind, item.payload])).toEqual([
      ["member_added", expect.any(Object)],
      ["member_removed", { memberId: member.id }],
    ]);
  });

  it("answers a second removal with 200 and writes nothing more", async () => {
    const { token } = await startGroup();
    const { member } = await added(token, "Dev");
    const first = await removed(token, member.id);
    const before = await stateOf(token);

    const second = await removed(token, member.id);

    expect(second.group).toEqual(first.group);
    expect(await stateOf(token)).toEqual(before);
  });

  it("treats a removed member as unknown in a new expense, and frees their name", async () => {
    const { token } = await startGroup();
    const { member } = await added(token, "Dev");
    const { group } = await removed(token, member.id);

    const response = await postExpense(token, expenseBody(group, { paidBy: member.id }));

    expect(await refusal(response)).toEqual({ status: 404, body: NOT_FOUND_BODY });
    expect((await added(token, "dev")).member.id).not.toBe(member.id);
  });

  it("refuses to leave fewer than two members with 409 too_few_members, and offers no Remove", async () => {
    const { token, group } = await startGroup({ members: ["Ana", "Ben"] });
    expect(group.members.map((member) => member.removable)).toEqual([false, false]);
    const before = await stateOf(token);

    const response = await deleteMember(token, group.members[0].id);

    expect(await refusal(response)).toEqual({ status: 409, body: '{"error":{"code":"too_few_members"}}' });
    expect(await stateOf(token)).toEqual(before);
  });

  describe("anyone a single expense or payment names, live or deleted", () => {
    let token: string;

    // Ana paid 10.00 for Ben, then it was deleted; Chen paid Dev 5.00, then it was undone. All four are back at zero.
    // Eli paid 12.00 for Eli and Fay, and Gus paid Hal 3.00; those stand, so all four have a balance.
    beforeAll(async () => {
      const started = await startGroup({ members: ["Ana", "Ben", "Chen", "Dev", "Eli", "Fay", "Gus", "Hal"] });
      token = started.token;
      const g = started.group;
      const gone = await postExpense(
        token,
        expenseBody(g, { amount: "10.00", paidBy: idOf(g, "Ana"), split: { mode: "equal", members: [idOf(g, "Ben")] } }),
      );
      expect(gone.status).toBe(201);
      const { expense } = await gone.json();
      expect((await deleteExpense(token, expense.id, expense.version)).status).toBe(200);
      const undone = await postPayment(
        token,
        paymentBody(await readGroup(token), { from: idOf(g, "Chen"), to: idOf(g, "Dev"), amount: "5.00" }),
      );
      expect(undone.status).toBe(201);
      expect((await deletePayment(token, (await undone.json()).payment.id)).status).toBe(200);
      const split = { mode: "equal" as const, members: [idOf(g, "Eli"), idOf(g, "Fay")] };
      expect((await postExpense(token, expenseBody(g, { amount: "12.00", paidBy: idOf(g, "Eli"), split }))).status).toBe(201);
      expect(
        (await postPayment(token, paymentBody(await readGroup(token), { from: idOf(g, "Gus"), to: idOf(g, "Hal"), amount: "3.00" })))
          .status,
      ).toBe(201);
    });

    it("shows each of them with no Remove, and the balances the story above gives", async () => {
      const view = await readGroup(token);

      expect(view.members.map((member) => [member.name, member.removable])).toEqual(
        ["Ana", "Ben", "Chen", "Dev", "Eli", "Fay", "Gus", "Hal"].map((name) => [name, false]),
      );
      expect(view.balances.map((row) => row.amount)).toEqual(["0.00", "0.00", "0.00", "0.00", "6.00", "-6.00", "3.00", "-3.00"]);
    });

    it.each([
      ["the payer of a deleted expense, back at zero", "Ana"],
      ["a member in the split of a deleted expense, back at zero", "Ben"],
      ["the payer of an undone payment, back at zero", "Chen"],
      ["the receiver of an undone payment, back at zero", "Dev"],
      ["the payer of a live expense", "Eli"],
      ["a member in the split of a live expense, with a non-zero balance", "Fay"],
      ["the payer of a live payment", "Gus"],
      ["the receiver of a live payment, with a non-zero balance", "Hal"],
    ])("refuses %s with 409 member_in_use and changes nothing", async (_label, name) => {
      const before = await stateOf(token);

      const response = await deleteMember(token, idOf(before.view, name));

      expect(await refusal(response)).toEqual({ status: 409, body: '{"error":{"code":"member_in_use"}}' });
      expect(await stateOf(token)).toEqual(before);
    });
  });

  it("holds a non-zero balance against removal even with no entry naming the member, the rule's own check", () => {
    const history = { hasEntries: true, involved: new Set<string>() };

    expect(removalBlock("m", history, new Map([["m", BigInt(1)]]), 5)).toBe("member_in_use");
    expect(removalBlock("m", history, new Map([["m", BigInt(-1)]]), 5)).toBe("member_in_use");
    expect(removalBlock("m", history, new Map([["m", BigInt(0)]]), 5)).toBeNull();
  });

  describe("one group cannot reach another", () => {
    let a: CreateGroupResponse;
    let b: CreateGroupResponse;

    beforeAll(async () => {
      a = await startGroup();
      b = await startGroup({ members: ["Ana", "Ben", "Chen", "Dev"] });
    });

    it("answers 404 to removing another group's member, and that member stays", async () => {
      const otherBefore = await stateOf(b.token);
      const mineBefore = await stateOf(a.token);

      const response = await deleteMember(a.token, b.group.members[3].id);

      expect(await refusal(response)).toEqual({ status: 404, body: NOT_FOUND_BODY });
      expect(await stateOf(b.token)).toEqual(otherBefore);
      expect(await stateOf(a.token)).toEqual(mineBefore);
    });

    it.each([
      ["not a uuid", "abc"],
      ["a uuid with an extra character", `${crypto.randomUUID()}0`],
      ["a uuid in braces", `{${crypto.randomUUID()}}`],
      ["a well formed id that matches nothing", crypto.randomUUID()],
    ])("answers the plain 404 to %s", async (_label, memberId) => {
      expect(await refusal(await deleteMember(a.token, memberId))).toEqual({ status: 404, body: NOT_FOUND_BODY });
    });

    it("answers an unknown token with the plain 404", async () => {
      const response = await deleteMember(mintGroupToken().token, a.group.members[0].id);

      expect(await refusal(response)).toEqual({ status: 404, body: NOT_FOUND_BODY });
    });
  });
});

describe("changing the base currency", () => {
  it("changes it while the group has no money, writes base_currency_changed and moves the version on", async () => {
    const { token, group } = await startGroup();
    expect(group.baseLocked).toBe(false);

    const response = await patchGroup(token, { baseCurrency: "JPY" });

    expect(response.status).toBe(200);
    const { group: after } = (await response.json()) as { group: GroupView };
    expect(after).toMatchObject({ baseCurrency: "JPY", baseDigits: 0, baseLocked: false, total: "0" });
    expect(after.balances.map((row) => row.amount)).toEqual(["0", "0", "0"]);
    expect(after.version).toBe(group.version + 1);
    expect(await readGroup(token)).toEqual(after);
    const [row] = await db.select().from(groups).where(eq(groups.id, group.id));
    expect(row.baseCurrency).toBe("JPY");
    const log = await db.select().from(events).where(eq(events.groupId, group.id)).orderBy(asc(events.seq));
    expect(log.at(-1)).toMatchObject({ kind: "base_currency_changed", payload: { from: "EUR", to: "JPY" } });

    // Expenses now use the new base: one in JPY needs no rate, and one in EUR needs one.
    expect((await postExpense(token, expenseBody(after))).status).toBe(201);
    expect(await errorCode(await postExpense(token, expenseBody(after, { currency: "EUR", amount: "10.00" })))).toBe(
      "rate_required",
    );
  });

  it("answers the base the group already has with 200 and writes nothing", async () => {
    const { token } = await startGroup();
    const before = await stateOf(token);

    const response = await patchGroup(token, { baseCurrency: "EUR" });

    expect(response.status).toBe(200);
    expect(await stateOf(token)).toEqual(before);
  });

  it("answers the base it already has with 200 and changed: false once the group has had money, and writes nothing", async () => {
    const { token, group } = await startGroup();
    expect((await postExpense(token, expenseBody(group))).status).toBe(201);
    const before = await stateOf(token);
    expect(before.view.baseLocked).toBe(true);

    const response = await patchGroup(token, { baseCurrency: "EUR" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { group: GroupView }).group).toEqual(before.view);
    expect(await stateOf(token)).toEqual(before);
    const row = await resolveGroup(db, token);
    if (row === null) throw new Error("the group did not resolve");
    expect(await changeBaseCurrency(db, row, { baseCurrency: "EUR" })).toEqual({ ok: true, value: { changed: false } });
    expect(await stateOf(token)).toEqual(before);
  });

  it.each([
    ["bad_currency", "a lower-case code", { baseCurrency: "usd" }],
    ["bad_currency", "a code with no minor unit", { baseCurrency: "XAU" }],
    ["bad_currency", "an unknown code", { baseCurrency: "ZZZ" }],
    ["invalid_body", "an unknown field", { baseCurrency: "USD", name: "Renamed" }],
    ["invalid_body", "a missing code", {}],
    ["invalid_body", "a body over 16 KB", { baseCurrency: "x".repeat(17 * 1024) }],
  ])("answers 400 %s for %s and changes nothing", async (code, _label, body) => {
    const { token } = await startGroup();
    const before = await stateOf(token);

    const response = await patchGroup(token, body);

    expect(await refusal(response)).toEqual({ status: 400, body: JSON.stringify({ error: { code } }) });
    expect(await stateOf(token)).toEqual(before);
  });

  it.each([
    ["a live expense", false, "expense"],
    ["a deleted expense", true, "expense"],
    ["a live payment", false, "payment"],
    ["an undone payment", true, "payment"],
  ] as const)("refuses a change once the group has had %s, with 409 base_locked", async (_label, undo, kind) => {
    const { token, group } = await startGroup();
    if (kind === "expense") {
      const { expense } = await (await postExpense(token, expenseBody(group))).json();
      if (undo) expect((await deleteExpense(token, expense.id, expense.version)).status).toBe(200);
    } else {
      const { payment } = await (await postPayment(token, paymentBody(group))).json();
      if (undo) expect((await deletePayment(token, payment.id)).status).toBe(200);
    }
    const before = await stateOf(token);
    expect(before.view.baseLocked).toBe(true);

    const response = await patchGroup(token, { baseCurrency: "USD" });

    expect(await refusal(response)).toEqual({ status: 409, body: '{"error":{"code":"base_locked"}}' });
    expect(await stateOf(token)).toEqual(before);
  });

  it("answers an unknown token with the plain 404", async () => {
    const response = await patchGroup(mintGroupToken().token, { baseCurrency: "USD" });

    expect(await refusal(response)).toEqual({ status: 404, body: NOT_FOUND_BODY });
  });
});
