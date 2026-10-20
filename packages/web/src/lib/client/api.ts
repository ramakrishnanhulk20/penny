import type {
  AddExpenseRequest,
  AddExpenseResponse,
  AddMemberRequest,
  AddMemberResponse,
  AddPaymentRequest,
  AddPaymentResponse,
  ChangeBaseCurrencyRequest,
  ChangeBaseCurrencyResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  DeleteExpenseResponse,
  EditExpenseRequest,
  GroupView,
  RemoveMemberResponse,
  ResetLinkRequest,
  ResetLinkResponse,
  TransferView,
  UndoPaymentResponse,
} from "@/lib/api-types";

/** The success body, or the short code the server sent ("network" when no answer arrived, "internal" when it was unreadable). */
export type ApiResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

// Same name as GROUP_TOKEN_HEADER in lib/group-token.ts. That module pulls in node:crypto, so the browser cannot import it.
const GROUP_HEADER = "x-penny-group";

function errorCode(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "internal";
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return "internal";
  return typeof error.code === "string" ? error.code : "internal";
}

// Every call declares JSON, body or not: the server answers 415 to any body that is not declared JSON, and Next.js
// gives a DELETE a body stream even when it sends none.
async function send<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer" });
  } catch {
    return { ok: false, error: "network" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "internal" };
  }

  if (!response.ok) return { ok: false, error: errorCode(body) };
  if (typeof body !== "object" || body === null) return { ok: false, error: "internal" };
  return { ok: true, data: body as T };
}

/** POST /api/groups. On success the body carries the new link token, which the caller puts only in the address fragment. */
export function createGroup(request: CreateGroupRequest): Promise<ApiResult<CreateGroupResponse>> {
  return send<CreateGroupResponse>("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

/** GET /api/group. The token travels only in the header, never in the URL. An unknown or reset link gives "not_found". */
export function getGroup(token: string, signal?: AbortSignal): Promise<ApiResult<GroupView>> {
  return send<GroupView>("/api/group", {
    method: "GET",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    signal,
  });
}

/** POST /api/group/expenses. A repeat with the same clientId and body returns the first result instead of a second expense. */
export function addExpense(token: string, request: AddExpenseRequest): Promise<ApiResult<AddExpenseResponse>> {
  return send<AddExpenseResponse>("/api/group/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    body: JSON.stringify(request),
  });
}

/**
 * PATCH /api/group/expenses/{id}. "stale_version" when someone changed the expense since `request.version`; sending
 * the same edit again after a lost answer returns the edited expense instead.
 */
export function editExpense(
  token: string,
  expenseId: string,
  request: EditExpenseRequest,
): Promise<ApiResult<AddExpenseResponse>> {
  // The id came from a server response, but it is still encoded so no value can change which path is called.
  return send<AddExpenseResponse>(`/api/group/expenses/${encodeURIComponent(expenseId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    body: JSON.stringify(request),
  });
}

/**
 * DELETE /api/group/expenses/{id}?version=N. "stale_version" when someone changed the expense since `version`;
 * deleting it again succeeds and changes nothing.
 */
export function deleteExpense(token: string, expenseId: string, version: number): Promise<ApiResult<DeleteExpenseResponse>> {
  const query = new URLSearchParams({ version: String(version) });
  return send<DeleteExpenseResponse>(`/api/group/expenses/${encodeURIComponent(expenseId)}?${query}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
  });
}

/**
 * The clientId of one settle-up line as shown on one group version: the same line on the same version always gives the
 * same id, so a double press, a retry after a lost answer, or two people pressing one line at once records one
 * payment. Hex SHA-256, 64 characters, the API's maximum. Rejects where crypto.subtle is missing (an insecure context).
 */
export async function settleClientId(version: number, transfer: TransferView): Promise<string> {
  const text = `settle:${version}:${transfer.from}:${transfer.to}:${transfer.amount}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * POST /api/group/payments. A repeat with the same clientId and body returns the first result instead of a second
 * payment. "stale_version" when the group has changed since the plan at `request.planVersion` was shown.
 */
export function addPayment(token: string, request: AddPaymentRequest): Promise<ApiResult<AddPaymentResponse>> {
  return send<AddPaymentResponse>("/api/group/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    body: JSON.stringify(request),
  });
}

/** DELETE /api/group/payments/{id}. Undoing a payment that is already undone succeeds again and changes nothing. */
export function undoPayment(token: string, paymentId: string): Promise<ApiResult<UndoPaymentResponse>> {
  // The id came from a server response, but it is still encoded so no value can change which path is called.
  return send<UndoPaymentResponse>(`/api/group/payments/${encodeURIComponent(paymentId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
  });
}

/** POST /api/group/members. "duplicate_member_name" when a current member has the same name, letter case ignored. */
export function addMember(token: string, request: AddMemberRequest): Promise<ApiResult<AddMemberResponse>> {
  return send<AddMemberResponse>("/api/group/members", {
    method: "POST",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    body: JSON.stringify(request),
  });
}

/**
 * DELETE /api/group/members/{id}. "member_in_use" for anyone named in an expense or payment; removing a member again
 * succeeds and changes nothing.
 */
export function removeMember(token: string, memberId: string): Promise<ApiResult<RemoveMemberResponse>> {
  // The id came from a server response, but it is still encoded so no value can change which path is called.
  return send<RemoveMemberResponse>(`/api/group/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
  });
}

/** PATCH /api/group. "base_locked" once the group has had any expense or payment. */
export function changeBaseCurrency(
  token: string,
  request: ChangeBaseCurrencyRequest,
): Promise<ApiResult<ChangeBaseCurrencyResponse>> {
  return send<ChangeBaseCurrencyResponse>("/api/group", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    body: JSON.stringify(request),
  });
}

/**
 * A new link token made in this browser: 16 bytes from crypto.getRandomValues, written as base64url without padding,
 * which is always 22 characters, the format lib/group-token.ts checks.
 */
export function newLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * POST /api/group/reset-link, moving the group to `newToken` (from newLinkToken). The caller keeps `newToken` before
 * calling, because the answer carries only the group. Sending the same request again after a lost answer succeeds
 * and changes nothing more. The old token answers "not_found" from then on, for everyone.
 */
export function resetLink(token: string, newToken: string, signal?: AbortSignal): Promise<ApiResult<ResetLinkResponse>> {
  const request: ResetLinkRequest = { newToken };
  return send<ResetLinkResponse>("/api/group/reset-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    body: JSON.stringify(request),
    signal,
  });
}
