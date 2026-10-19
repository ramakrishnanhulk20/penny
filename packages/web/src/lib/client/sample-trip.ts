import type { CreateGroupResponse } from "@/lib/api-types";
import type { ApiResult } from "./api";

// The format parseGroupToken in lib/group-token.ts accepts. That module pulls in node:crypto, which the browser
// cannot load.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{22}$/;

function errorCode(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "internal";
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return "internal";
  return typeof error.code === "string" ? error.code : "internal";
}

/**
 * POST /api/sample-trip with no body. On success the body carries the new group's link token, which the caller puts
 * only in the address fragment; a token in any other format is treated as an unreadable answer ("internal").
 * "rate_limited" after too many sample trips from this network, "network" when no answer arrived.
 */
export async function startSampleTrip(): Promise<ApiResult<CreateGroupResponse>> {
  let response: Response;
  try {
    response = await fetch("/api/sample-trip", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return { ok: false, error: "network" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "internal" };
  }

  if (response.status !== 201) return { ok: false, error: errorCode(body) };
  if (typeof body !== "object" || body === null || !("token" in body)) return { ok: false, error: "internal" };
  if (typeof body.token !== "string" || !TOKEN_FORMAT.test(body.token)) return { ok: false, error: "internal" };
  return { ok: true, data: body as CreateGroupResponse };
}
