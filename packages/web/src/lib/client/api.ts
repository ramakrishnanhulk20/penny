import type {
  AddExpenseRequest,
  AddExpenseResponse,
  AddPaymentRequest,
  AddPaymentResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  GroupView,
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
  return send<GroupView>("/api/group", { method: "GET", headers: { [GROUP_HEADER]: token }, signal });
}

/** POST /api/group/expenses. A repeat with the same clientId and body returns the first result instead of a second expense. */
export function addExpense(token: string, request: AddExpenseRequest): Promise<ApiResult<AddExpenseResponse>> {
  return send<AddExpenseResponse>("/api/group/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json", [GROUP_HEADER]: token },
    body: JSON.stringify(request),
  });
}

/** POST /api/group/payments. A repeat with the same clientId and body returns the first result instead of a second payment. */
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
    headers: { [GROUP_HEADER]: token },
  });
}
