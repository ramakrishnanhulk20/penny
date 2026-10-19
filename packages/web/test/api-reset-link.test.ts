// Not covered: the page's Reset link flow and its address swap (they need a browser), whether a browser or a chat app
// still holds the old link somewhere, two resets truly overlapping (PGlite runs one transaction at a time), or Neon.
import { asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events, groups } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { GroupView, ResetLinkResponse } from "@/lib/api-types";
import { hashGroupToken, mintGroupToken } from "@/lib/group-token";
import { resolveGroup } from "@/lib/groups";
import { addExpense, resetLink } from "@/lib/ledger-store";
import {
  deleteExpense,
  deleteMember,
  deletePayment,
  editBody,
  expenseBody,
  getGroup,
  patchExpense,
  patchGroup,
  paymentBody,
  postExpense,
  postMember,
  postPayment,
  postResetLink,
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

type Answer = { status: number; headers: [string, string][]; body: string };

async function answer(response: Response): Promise<Answer> {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

async function eventCount(groupId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(events).where(eq(events.groupId, groupId));
  return row.n;
}

describe("after a reset", () => {
  let oldToken: string;
  let before: GroupView;
  let reset: ResetLinkResponse;
  let resetText: string;
  let expense: { id: string; version: number };
  let paymentId: string;
  let memberId: string;
  // The body of every other answer this block gets, searched for secrets at the end.
  const otherAnswers: string[] = [];

  beforeAll(async () => {
    const started = await startGroup();
    oldToken = started.token;
    expense = (await (await postExpense(oldToken, expenseBody(started.group))).json()).expense;
    paymentId = (await (await postPayment(oldToken, paymentBody(started.group))).json()).payment.id;
    memberId = (await (await postMember(oldToken, { name: "Dev" })).json()).member.id;
    before = await readGroup(oldToken);

    const response = await postResetLink(oldToken);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    resetText = await response.text();
    reset = JSON.parse(resetText) as ResetLinkResponse;
  });

  it("answers with a new token of the link format and the same group, its version moved on", () => {
    expect(reset.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(reset.token).not.toBe(oldToken);
    expect(reset.group).toEqual({ ...before, version: before.version + 1 });
  });

  it("stores the new token's hash in place of the old one, and never the token", async () => {
    const [row] = await db.select().from(groups).where(eq(groups.id, before.id));

    expect(row.tokenHash).toBe(hashGroupToken(reset.token));
    expect(row.tokenHash).not.toBe(hashGroupToken(oldToken));
    expect(JSON.stringify(row)).not.toContain(reset.token);
  });

  it("writes one link_reset event that names no token and no hash", async () => {
    const log = await db.select().from(events).where(eq(events.groupId, before.id)).orderBy(asc(events.seq));

    expect(log.filter((row) => row.kind === "link_reset").map((row) => [row.entityId, row.payload])).toEqual([
      [before.id, {}],
    ]);
  });

  it("gives the old token the unknown-link 404, byte for byte, on the read and on every write route", async () => {
    const stranger = await answer(await getGroup(mintGroupToken().token));
    const logged = await eventCount(before.id);

    const answers = await Promise.all(
      [
        getGroup(oldToken),
        postExpense(oldToken, expenseBody(before)),
        patchExpense(oldToken, expense.id, editBody(before, expense.version)),
        deleteExpense(oldToken, expense.id, expense.version),
        postPayment(oldToken, paymentBody(before)),
        deletePayment(oldToken, paymentId),
        postMember(oldToken, { name: "Zed" }),
        deleteMember(oldToken, memberId),
        patchGroup(oldToken, { baseCurrency: "EUR" }),
        postResetLink(oldToken),
      ].map(async (pending) => answer(await pending)),
    );

    expect(stranger.body).toBe('{"error":{"code":"not_found"}}');
    for (const item of answers) expect(item).toEqual(stranger);
    otherAnswers.push(...answers.map((item) => item.body));
    expect(await eventCount(before.id)).toBe(logged);
    expect(await readGroup(reset.token)).toEqual(reset.group);
  });

  it("lets the new token read and write", async () => {
    const read = await getGroup(reset.token);
    expect(read.status).toBe(200);
    otherAnswers.push(await read.text());

    const removed = await deleteMember(reset.token, memberId);
    expect(removed.status).toBe(200);
    const removedText = await removed.text();
    otherAnswers.push(removedText);
    const { group } = JSON.parse(removedText) as { group: GroupView };
    const added = await postExpense(reset.token, expenseBody(group, { amount: "30.00" }));
    expect(added.status).toBe(201);
    otherAnswers.push(await added.text());
  });

  it("keeps the new token and both hashes out of the event log and out of every answer but the reset's", async () => {
    const secrets = [reset.token, oldToken, hashGroupToken(reset.token), hashGroupToken(oldToken)];
    const log = await db.select().from(events).where(eq(events.groupId, before.id));
    const logText = JSON.stringify(log.map((row) => ({ kind: row.kind, entityId: row.entityId, payload: row.payload })));

    expect(otherAnswers.length).toBeGreaterThan(10);
    for (const secret of secrets) {
      expect(logText).not.toContain(secret);
      for (const text of otherAnswers) expect(text).not.toContain(secret);
    }
    // The reset's own answer carries the new token once, and nothing else secret.
    expect(resetText.split(reset.token)).toHaveLength(2);
    for (const secret of secrets.slice(1)) expect(resetText).not.toContain(secret);
  });
});

describe("refusals", () => {
  it.each([
    ["an unknown field", { token: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["an array body", []],
    ["broken JSON", "{"],
    ["an empty body", ""],
    ["a body over 16 KB", { pad: "x".repeat(17 * 1024) }],
  ])("refuses %s with invalid_body and keeps the link", async (_label, body) => {
    const { token, group } = await startGroup();

    const response = await postResetLink(token, body);

    expect(await answer(response)).toMatchObject({ status: 400, body: '{"error":{"code":"invalid_body"}}' });
    const [row] = await db.select().from(groups).where(eq(groups.id, group.id));
    expect(row.tokenHash).toBe(hashGroupToken(token));
  });

  it("answers an unknown token with the plain 404", async () => {
    const response = await postResetLink(mintGroupToken().token);

    expect(await answer(response)).toMatchObject({ status: 404, body: '{"error":{"code":"not_found"}}' });
  });

  it("refuses a reset or a write that read the group before another reset landed, so the old link writes nothing", async () => {
    const { token, group } = await startGroup();
    const stale = await resolveGroup(db, token);
    if (stale === null) throw new Error("the new group did not resolve");
    const first = (await (await postResetLink(token)).json()) as ResetLinkResponse;
    const logged = await eventCount(group.id);

    const again = await resetLink(db, stale);
    const write = await addExpense(db, stale, expenseBody(group));

    expect(again).toEqual({ ok: false, status: 404, code: "not_found" });
    expect(write).toEqual({ ok: false, status: 404, code: "not_found" });
    const [row] = await db.select().from(groups).where(eq(groups.id, group.id));
    expect(row.tokenHash).toBe(hashGroupToken(first.token));
    expect(await eventCount(group.id)).toBe(logged);
  });
});
