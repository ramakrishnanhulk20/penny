import { expect } from "vitest";
import { DELETE as deleteExpenseRoute, PATCH as editExpenseRoute } from "@/app/api/group/expenses/[expenseId]/route";
import { POST as addExpenseRoute } from "@/app/api/group/expenses/route";
import { DELETE as removeMemberRoute } from "@/app/api/group/members/[memberId]/route";
import { POST as addMemberRoute } from "@/app/api/group/members/route";
import { DELETE as undoPaymentRoute } from "@/app/api/group/payments/[paymentId]/route";
import { POST as addPaymentRoute } from "@/app/api/group/payments/route";
import { POST as resetLinkRoute } from "@/app/api/group/reset-link/route";
import { GET as getGroupRoute, PATCH as changeGroupRoute } from "@/app/api/group/route";
import { POST as createGroupRoute } from "@/app/api/groups/route";
import type {
  AddExpenseRequest,
  AddPaymentRequest,
  CreateGroupRequest,
  CreateGroupResponse,
  EditExpenseRequest,
  GroupView,
} from "@/lib/api-types";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";

let addressesHandedOut = 0;

/**
 * A new client address from 198.18.0.0/15, the range set aside for network benchmark tests, on every call. Each
 * request then counts against its own network, so a test file's volume never adds up the way one real client's would.
 */
export function freshAddress(): string {
  addressesHandedOut += 1;
  const n = addressesHandedOut % 0x20000;
  return `198.${18 + (n >> 16)}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

export function groupBody(overrides: Partial<CreateGroupRequest> = {}): CreateGroupRequest {
  return { name: "Lisbon trip", baseCurrency: "EUR", members: ["Ana", "Ben", "Chen"], ...overrides };
}

/** A request with a JSON body, POST unless told otherwise. A string body is sent as it is, so tests can send broken JSON. */
export function jsonRequest(path: string, body: unknown, token?: string, method = "POST"): Request {
  const headers = new Headers({ "content-type": "application/json", "x-vercel-forwarded-for": freshAddress() });
  if (token !== undefined) headers.set(GROUP_TOKEN_HEADER, token);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function postGroup(body: unknown): Promise<Response> {
  return createGroupRoute(jsonRequest("/api/groups", body));
}

export async function startGroup(overrides: Partial<CreateGroupRequest> = {}): Promise<CreateGroupResponse> {
  const response = await postGroup(groupBody(overrides));
  expect(response.status).toBe(201);
  return (await response.json()) as CreateGroupResponse;
}

export function getGroup(token: string | null): Promise<Response> {
  const headers = new Headers({ "x-vercel-forwarded-for": freshAddress() });
  if (token !== null) headers.set(GROUP_TOKEN_HEADER, token);
  return getGroupRoute(new Request("http://localhost/api/group", { headers }));
}

export async function readGroup(token: string): Promise<GroupView> {
  const response = await getGroup(token);
  expect(response.status).toBe(200);
  return (await response.json()) as GroupView;
}

/** An equal split of 100 in the base currency between every member, paid by the first. */
export function expenseBody(group: GroupView, overrides: Partial<AddExpenseRequest> = {}): AddExpenseRequest {
  return {
    clientId: `test-${crypto.randomUUID()}`,
    description: "Dinner",
    amount: group.baseDigits === 0 ? "100" : `100.${"0".repeat(group.baseDigits)}`,
    currency: group.baseCurrency,
    rate: null,
    paidBy: group.members[0].id,
    split: { mode: "equal", members: group.members.map((member) => member.id) },
    ...overrides,
  };
}

export function postExpense(token: string, body: unknown): Promise<Response> {
  return addExpenseRoute(jsonRequest("/api/group/expenses", body, token));
}

/** expenseBody's expense as an edit from `version`, with the overrides on top. */
export function editBody(group: GroupView, version: number, overrides: Partial<EditExpenseRequest> = {}): EditExpenseRequest {
  const { description, amount, currency, rate, paidBy, split } = expenseBody(group);
  return { version, description, amount, currency, rate, paidBy, split, ...overrides };
}

/** PATCH /api/group/expenses/{expenseId}, with the params Next.js would pass for that path. */
export function patchExpense(token: string | null, expenseId: string, body: unknown): Promise<Response> {
  const request = jsonRequest(`/api/group/expenses/${encodeURIComponent(expenseId)}`, body, token ?? undefined, "PATCH");
  return editExpenseRoute(request, { params: Promise.resolve({ expenseId }) });
}

/**
 * DELETE /api/group/expenses/{expenseId}?version=..., with the params Next.js would pass for that path. A string
 * version goes into the query as it is, so tests can send malformed ones; null sends no query at all.
 */
export function deleteExpense(token: string | null, expenseId: string, version: number | string | null): Promise<Response> {
  const headers = new Headers({ "x-vercel-forwarded-for": freshAddress() });
  if (token !== null) headers.set(GROUP_TOKEN_HEADER, token);
  const query = version === null ? "" : `?version=${version}`;
  const request = new Request(`http://localhost/api/group/expenses/${encodeURIComponent(expenseId)}${query}`, {
    method: "DELETE",
    headers,
  });
  return deleteExpenseRoute(request, { params: Promise.resolve({ expenseId }) });
}

/** A payment of 10 in the base currency from the second member to the first, pressed on `group`'s version. */
export function paymentBody(group: GroupView, overrides: Partial<AddPaymentRequest> = {}): AddPaymentRequest {
  return {
    clientId: `test-${crypto.randomUUID()}`,
    planVersion: group.version,
    from: group.members[1].id,
    to: group.members[0].id,
    amount: group.baseDigits === 0 ? "10" : `10.${"0".repeat(group.baseDigits)}`,
    currency: group.baseCurrency,
    rate: null,
    ...overrides,
  };
}

export function postPayment(token: string, body: unknown): Promise<Response> {
  return addPaymentRoute(jsonRequest("/api/group/payments", body, token));
}

/** DELETE /api/group/payments/{paymentId}, with the params Next.js would pass for that path. */
export function deletePayment(token: string | null, paymentId: string): Promise<Response> {
  const headers = new Headers({ "x-vercel-forwarded-for": freshAddress() });
  if (token !== null) headers.set(GROUP_TOKEN_HEADER, token);
  const request = new Request(`http://localhost/api/group/payments/${encodeURIComponent(paymentId)}`, {
    method: "DELETE",
    headers,
  });
  return undoPaymentRoute(request, { params: Promise.resolve({ paymentId }) });
}

export function postMember(token: string, body: unknown): Promise<Response> {
  return addMemberRoute(jsonRequest("/api/group/members", body, token));
}

/** DELETE /api/group/members/{memberId}, with the params Next.js would pass for that path. */
export function deleteMember(token: string | null, memberId: string): Promise<Response> {
  const headers = new Headers({ "x-vercel-forwarded-for": freshAddress() });
  if (token !== null) headers.set(GROUP_TOKEN_HEADER, token);
  const request = new Request(`http://localhost/api/group/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
    headers,
  });
  return removeMemberRoute(request, { params: Promise.resolve({ memberId }) });
}

/** PATCH /api/group, the base currency change. */
export function patchGroup(token: string, body: unknown): Promise<Response> {
  return changeGroupRoute(jsonRequest("/api/group", body, token, "PATCH"));
}

/** POST /api/group/reset-link. A null token sends no header at all. */
export function postResetLink(token: string | null, body: unknown): Promise<Response> {
  return resetLinkRoute(jsonRequest("/api/group/reset-link", body, token ?? undefined));
}

/** Minor units of an amount the API wrote: formatAmount always writes every decimal, so dropping the point is exact. */
export function toMinor(amount: string): bigint {
  return BigInt(amount.replace(".", ""));
}

export async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
