import { MIMEType } from "node:util";

// Money is bigint end to end; a JSON number would round anything past 2^53, so bigints go out as decimal strings.
function serialise(data: unknown): string {
  return (
    JSON.stringify(data, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)) ?? "null"
  );
}

/** A JSON response that no browser or shared cache may store. bigint values become decimal strings. */
export function json(data: unknown, init?: { status?: number }): Response {
  return new Response(serialise(data), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** 404 with the same bytes for an unknown token, a malformed token and a foreign id, so none can be told apart. */
export function notFound(): Response {
  return json({ error: { code: "not_found" } }, { status: 404 });
}

/** 400 carrying only a short code chosen by our own code, never the input or a validator message. */
export function badRequest(code: string): Response {
  return json({ error: { code } }, { status: 400 });
}

/** 500 with no detail at all: no message, stack, SQL or connection string. */
export function serverError(): Response {
  return json({ error: { code: "internal" } }, { status: 500 });
}

/** 415 {"error":{"code":"unsupported_media_type"}}. */
export function unsupportedMediaType(): Response {
  return json({ error: { code: "unsupported_media_type" } }, { status: 415 });
}

/**
 * True when Content-Type, read by Node's own MIME parser, is application/json, parameters such as charset allowed and
 * case ignored. A missing value, one the parser refuses, or two values joined by a comma is not JSON.
 */
export function declaresJson(request: Request): boolean {
  const raw = request.headers.get("content-type");
  if (raw === null) return false;
  try {
    return new MIMEType(raw).essence === "application/json";
  } catch {
    return false;
  }
}

/**
 * True when the request carries a body, or says it does through Content-Type, Content-Length or Transfer-Encoding, and
 * that body is not declared application/json. Another site can make a browser send a text/plain, form or multipart
 * body, or one with no type at all, without asking this origin first; a JSON body always needs the CORS check, which
 * this origin never grants, so holding every body to JSON keeps other sites from writing here. Next.js hands every
 * POST, PATCH and DELETE a body stream, even an empty one, so in production each of those needs the header.
 */
export function sendsNonJsonBody(request: Request): boolean {
  const length = request.headers.get("content-length");
  const carriesBody =
    request.body !== null ||
    request.headers.has("content-type") ||
    request.headers.has("transfer-encoding") ||
    (length !== null && length.trim() !== "0");
  return carriesBody && !declaresJson(request);
}
