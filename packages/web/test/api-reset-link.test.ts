// Not covered: the page's Reset link flow, its retry, its timeout, its check of the new token and its address swap
// (they need a browser); whether a browser's random source is any good (only the token format, and that tokens
// differ); whether a browser or a chat app still holds the old link somewhere; two resets truly overlapping (PGlite runs
// one transaction at a time, so a retry still in flight is played by calling the store with a group read before the
// first reset landed); a reset in a group at the history cap (test/history-caps.test.ts); or Neon.
import { asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, setDbForTests } from "@/db/client";
import { events, groups } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import type { GroupView, ResetLinkResponse } from "@/lib/api-types";
import { newLinkToken } from "@/lib/client/api";
import { hashGroupToken, mintGroupToken, parseGroupToken } from "@/lib/group-token";
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

const NOT_FOUND_BODY = '{"error":{"code":"not_found"}}';
const INVALID_BODY = '{"error":{"code":"invalid_body"}}';

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

async function storedHash(groupId: string): Promise<string> {
  const [row] = await db.select({ tokenHash: groups.tokenHash }).from(groups).where(eq(groups.id, groupId));
  return row.tokenHash;
}

describe("the token the browser makes", () => {
  it("is 22 url-safe characters that pass the server's format check, and differs every time", () => {
    const tokens = Array.from({ length: 500 }, () => newLinkToken());

    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(parseGroupToken(token)).toBe(token);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("after a reset", () => {
  let oldToken: string;
  let newToken: string;
  let before: GroupView;
  let reset: ResetLinkResponse;
  let resetText: string;
  let expense: { id: string; version: number };
  let paymentId: string;
  let memberId: string;
  // The body of every answer this block gets, searched for secrets at the end.
  const answers: string[] = [];

  beforeAll(async () => {
    const started = await startGroup();
    oldToken = started.token;
    expense = (await (await postExpense(oldToken, expenseBody(started.group))).json()).expense;
    paymentId = (await (await postPayment(oldToken, paymentBody(await readGroup(oldToken)))).json()).payment.id;
    memberId = (await (await postMember(oldToken, { name: "Dev" })).json()).member.id;
    before = await readGroup(oldToken);
    newToken = newLinkToken();

    const response = await postResetLink(oldToken, { newToken });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    resetText = await response.text();
    answers.push(resetText);
    reset = JSON.parse(resetText) as ResetLinkResponse;
  });

  it("answers with the same group, its version unchanged, and no token", () => {
    expect(reset).toEqual({ group: before });
  });

  it("stores the hash of the browser's token in place of the old one, and never the token", async () => {
    const [row] = await db.select().from(groups).where(eq(groups.id, before.id));

    expect(row.tokenHash).toBe(hashGroupToken(newToken));
    expect(JSON.stringify(row)).not.toContain(newToken);
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

    const replies = await Promise.all(
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
        postResetLink(oldToken, { newToken: newLinkToken() }),
      ].map(async (pending) => answer(await pending)),
    );

    expect(stranger.body).toBe(NOT_FOUND_BODY);
    for (const item of replies) expect(item).toEqual(stranger);
    answers.push(...replies.map((item) => item.body));
    expect(await eventCount(before.id)).toBe(logged);
    expect(await readGroup(newToken)).toEqual(reset.group);
  });

  it("answers the same request sent again with 200 and the group, and writes nothing", async () => {
    const logged = await eventCount(before.id);
    const view = await readGroup(newToken);

    const again = await postResetLink(oldToken, { newToken });

    expect(again.status).toBe(200);
    const text = await again.text();
    answers.push(text);
    expect(JSON.parse(text)).toEqual({ group: view });
    expect(await eventCount(before.id)).toBe(logged);
    expect(await storedHash(before.id)).toBe(hashGroupToken(newToken));
    expect(await readGroup(newToken)).toEqual(view);
  });

  it("lets the new token read and write", async () => {
    const read = await getGroup(newToken);
    expect(read.status).toBe(200);
    answers.push(await read.text());

    const removed = await deleteMember(newToken, memberId);
    expect(removed.status).toBe(200);
    const removedText = await removed.text();
    answers.push(removedText);
    const { group } = JSON.parse(removedText) as { group: GroupView };
    const added = await postExpense(newToken, expenseBody(group, { amount: "30.00" }));
    expect(added.status).toBe(201);
    answers.push(await added.text());
  });

  it("keeps both tokens and both hashes out of the event log and out of every answer, the reset's own included", async () => {
    const secrets = [newToken, oldToken, hashGroupToken(newToken), hashGroupToken(oldToken)];
    const log = await db.select().from(events).where(eq(events.groupId, before.id));
    const logText = JSON.stringify(log.map((row) => ({ kind: row.kind, entityId: row.entityId, payload: row.payload })));

    expect(answers.length).toBeGreaterThan(12);
    for (const secret of secrets) {
      expect(logText).not.toContain(secret);
      for (const text of answers) expect(text).not.toContain(secret);
    }
  });
});

describe("a reset whose answer was lost", () => {
  it("answers the same request sent again with the old token with 200, and the new token opens the group", async () => {
    const { token, group } = await startGroup();
    const row = await resolveGroup(db, token);
    if (row === null) throw new Error("the new group did not resolve");
    const newToken = newLinkToken();
    // The reset lands and its answer never reaches the browser.
    await resetLink(db, row, newToken);
    const logged = await eventCount(group.id);

    const retry = await postResetLink(token, { newToken });

    expect(retry.status).toBe(200);
    const { group: view } = (await retry.json()) as ResetLinkResponse;
    expect(view).toEqual(group);
    expect(await readGroup(newToken)).toEqual(view);
    expect((await getGroup(token)).status).toBe(404);
    expect(await eventCount(group.id)).toBe(logged);
  });

  it("succeeds without a second reset when the retry read the group before the first one landed", async () => {
    const { token, group } = await startGroup();
    const stale = await resolveGroup(db, token);
    if (stale === null) throw new Error("the new group did not resolve");
    const newToken = newLinkToken();

    expect(await resetLink(db, stale, newToken)).toEqual({ ok: true, value: { rotated: true } });
    const logged = await eventCount(group.id);
    expect(await resetLink(db, stale, newToken)).toEqual({ ok: true, value: { rotated: false } });

    expect(await eventCount(group.id)).toBe(logged);
    expect(await storedHash(group.id)).toBe(hashGroupToken(newToken));
  });

  it("answers the old token with any other new token with the plain 404, and the link stays", async () => {
    const { token, group } = await startGroup();
    const newToken = newLinkToken();
    expect((await postResetLink(token, { newToken })).status).toBe(200);
    const logged = await eventCount(group.id);

    const other = await postResetLink(token, { newToken: newLinkToken() });

    expect(await answer(other)).toMatchObject({ status: 404, body: NOT_FOUND_BODY });
    expect(await storedHash(group.id)).toBe(hashGroupToken(newToken));
    expect(await eventCount(group.id)).toBe(logged);
  });
});

describe("refusals", () => {
  it.each([
    ["an empty object", {}],
    ["an unknown field beside a good token", { newToken: "AAAAAAAAAAAAAAAAAAAAAA", extra: 1 }],
    ["the token under another name", { token: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["a 21 character token", { newToken: "A".repeat(21) }],
    ["a 23 character token", { newToken: "A".repeat(23) }],
    ["a token with a plus sign", { newToken: `${"A".repeat(21)}+` }],
    ["a padded token", { newToken: `${"A".repeat(20)}==` }],
    ["a token with a leading space", { newToken: ` ${"A".repeat(21)}` }],
    ["a number", { newToken: 7 }],
    ["null", { newToken: null }],
    ["an array body", []],
    ["broken JSON", "{"],
    ["an empty body", ""],
    ["a body over 16 KB", { newToken: "x".repeat(17 * 1024) }],
  ])("refuses %s with invalid_body and keeps the link", async (_label, body) => {
    const { token, group } = await startGroup();
    const logged = await eventCount(group.id);

    const response = await postResetLink(token, body);

    expect(await answer(response)).toMatchObject({ status: 400, body: INVALID_BODY });
    expect(await storedHash(group.id)).toBe(hashGroupToken(token));
    expect(await eventCount(group.id)).toBe(logged);
  });

  it("refuses the current token as the new one with invalid_body, and keeps the link", async () => {
    const { token, group } = await startGroup();
    const logged = await eventCount(group.id);

    const response = await postResetLink(token, { newToken: token });

    expect(await answer(response)).toMatchObject({ status: 400, body: INVALID_BODY });
    expect(await storedHash(group.id)).toBe(hashGroupToken(token));
    expect(await eventCount(group.id)).toBe(logged);
  });

  it("refuses another group's link as the new token with invalid_body, and changes neither group", async () => {
    const a = await startGroup();
    const b = await startGroup();
    const bBefore = await readGroup(b.token);
    const logged = await eventCount(a.group.id);

    const response = await postResetLink(a.token, { newToken: b.token });

    expect(await answer(response)).toMatchObject({ status: 400, body: INVALID_BODY });
    expect(await storedHash(a.group.id)).toBe(hashGroupToken(a.token));
    expect(await eventCount(a.group.id)).toBe(logged);
    expect(await readGroup(b.token)).toEqual(bBefore);
  });

  it("answers an unknown token with the plain 404 whatever the body", async () => {
    for (const body of [{ newToken: newLinkToken() }, {}, "{"]) {
      expect(await answer(await postResetLink(mintGroupToken().token, body))).toMatchObject({
        status: 404,
        body: NOT_FOUND_BODY,
      });
    }
  });

  it("answers a missing or malformed header with the plain 404, even when the new token opens a group", async () => {
    const { token } = await startGroup();

    for (const header of [null, "not-a-token", `${token}A`]) {
      expect(await answer(await postResetLink(header, { newToken: token }))).toMatchObject({
        status: 404,
        body: NOT_FOUND_BODY,
      });
    }
  });

  it("refuses a different reset or a write that read the group before another reset landed", async () => {
    const { token, group } = await startGroup();
    const stale = await resolveGroup(db, token);
    if (stale === null) throw new Error("the new group did not resolve");
    const first = newLinkToken();
    expect((await postResetLink(token, { newToken: first })).status).toBe(200);
    const logged = await eventCount(group.id);

    const again = await resetLink(db, stale, newLinkToken());
    const write = await addExpense(db, stale, expenseBody(group));

    expect(again).toEqual({ ok: false, status: 404, code: "not_found" });
    expect(write).toEqual({ ok: false, status: 404, code: "not_found" });
    expect(await storedHash(group.id)).toBe(hashGroupToken(first));
    expect(await eventCount(group.id)).toBe(logged);
  });
});
