import { MAX_PARTS } from "@penny/core";
import { z } from "zod";
import type { AddExpenseRequest, AddPaymentRequest, CreateGroupRequest } from "./api-types";
import { cleanName } from "./text";

/** Bodies above this many bytes are refused before any parsing. */
export const MAX_BODY_BYTES = 16 * 1024;
export const GROUP_NAME_MAX = 60;
export const MEMBER_NAME_MAX = 40;
export const DESCRIPTION_MAX = 80;
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 20;

// Each limit below names its own error code, so the page can say which rule failed. Strings with no limit of their
// own (amounts, rates, currency codes, member ids) are capped by MAX_BODY_BYTES and judged by @penny/core or by
// group membership, never here.
const FIELD_CODES: ReadonlySet<string> = new Set([
  "bad_name",
  "bad_member_name",
  "too_few_members",
  "too_many_members",
  "bad_description",
  "split_too_many_parts",
]);

function cleanText(max: number, code: string) {
  return z.string().transform((raw, ctx) => {
    const cleaned = cleanName(raw, max);
    if (cleaned === null) {
      ctx.addIssue({ code: "custom", message: code });
      return z.NEVER;
    }
    return cleaned;
  });
}

const memberId = z.string();
const clientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const splitBody = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("equal"),
    members: z.array(memberId).max(MAX_PARTS, { error: "split_too_many_parts" }),
  }),
  z.strictObject({
    mode: z.literal("shares"),
    // Any finite number gets through; @penny/core decides whether it is a valid whole share.
    parts: z
      .array(z.strictObject({ memberId, weight: z.number() }))
      .max(MAX_PARTS, { error: "split_too_many_parts" }),
  }),
  z.strictObject({
    mode: z.literal("exact"),
    parts: z
      .array(z.strictObject({ memberId, amount: z.string() }))
      .max(MAX_PARTS, { error: "split_too_many_parts" }),
  }),
]);

export const createGroupBody = z.strictObject({
  name: cleanText(GROUP_NAME_MAX, "bad_name"),
  baseCurrency: z.string(),
  members: z
    .array(cleanText(MEMBER_NAME_MAX, "bad_member_name"))
    .min(MIN_MEMBERS, { error: "too_few_members" })
    .max(MAX_MEMBERS, { error: "too_many_members" }),
}) satisfies z.ZodType<unknown, CreateGroupRequest>;

export const addExpenseBody = z.strictObject({
  clientId,
  description: cleanText(DESCRIPTION_MAX, "bad_description"),
  amount: z.string(),
  currency: z.string(),
  rate: z.string().nullable(),
  paidBy: memberId,
  split: splitBody,
}) satisfies z.ZodType<unknown, AddExpenseRequest>;

export const addPaymentBody = z.strictObject({
  clientId,
  from: memberId,
  to: memberId,
  amount: z.string(),
  currency: z.string(),
  rate: z.string().nullable(),
}) satisfies z.ZodType<unknown, AddPaymentRequest>;

export type CreateGroupBody = z.output<typeof createGroupBody>;
export type AddExpenseBody = z.output<typeof addExpenseBody>;
export type AddPaymentBody = z.output<typeof addPaymentBody>;

export type ParsedBody<T> = { ok: true; value: T } | { ok: false; code: string };

// Reads at most MAX_BODY_BYTES whatever Content-Length claims, so a client cannot make us buffer more.
async function readCapped(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads the request body as JSON and checks it against `schema`.
 * Fails with "invalid_body" for a body over MAX_BODY_BYTES, invalid UTF-8 or JSON, an unknown field, or a wrong
 * type; with a field's own code (such as "bad_name") when that is the only kind of problem.
 */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<ParsedBody<z.output<S>>> {
  const text = await readCapped(request);
  if (text === null) return { ok: false, code: "invalid_body" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_body" };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  // A structural problem anywhere outranks a field rule, so a half-valid body never gets a field-level answer.
  const issues = parsed.error.issues;
  if (issues.some((issue) => !FIELD_CODES.has(issue.message))) return { ok: false, code: "invalid_body" };
  return { ok: false, code: issues[0].message };
}
