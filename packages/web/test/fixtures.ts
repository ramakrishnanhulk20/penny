import { expect } from "vitest";
import { POST as addExpenseRoute } from "@/app/api/group/expenses/route";
import { GET as getGroupRoute } from "@/app/api/group/route";
import { POST as createGroupRoute } from "@/app/api/groups/route";
import type { AddExpenseRequest, CreateGroupRequest, CreateGroupResponse, GroupView } from "@/lib/api-types";
import { GROUP_TOKEN_HEADER } from "@/lib/group-token";

export function groupBody(overrides: Partial<CreateGroupRequest> = {}): CreateGroupRequest {
  return { name: "Lisbon trip", baseCurrency: "EUR", members: ["Ana", "Ben", "Chen"], ...overrides };
}

/** A POST with a JSON body. A string body is sent as it is, so tests can send broken JSON. */
export function jsonRequest(path: string, body: unknown, token?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set(GROUP_TOKEN_HEADER, token);
  return new Request(`http://localhost${path}`, {
    method: "POST",
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
  const headers = new Headers();
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

/** Minor units of an amount the API wrote: formatAmount always writes every decimal, so dropping the point is exact. */
export function toMinor(amount: string): bigint {
  return BigInt(amount.replace(".", ""));
}

export async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
