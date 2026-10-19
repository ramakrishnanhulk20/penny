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
