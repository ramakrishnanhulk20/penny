// Every error a person sees comes from here, for the browser's own checks and for the server's codes alike,
// so one problem is always worded one way. A server code is only ever a lookup key, never shown as text.
import type { RateError } from "@penny/core";
import { DESCRIPTION_MAX, GROUP_NAME_MAX, MEMBER_NAME_MAX, cleanName } from "@/lib/text";

export { DESCRIPTION_MAX, GROUP_NAME_MAX, MEMBER_NAME_MAX };

export const FALLBACK_MESSAGE = "Something went wrong. Try again.";

/** Shown once the page has loaded the latest group after "Mark as paid" or "Undo" found it changed. */
export const ALREADY_CHANGED_MESSAGE = "This was already changed. Showing the latest.";

/**
 * True for the answers that mean the page is behind the server: the 404 (the payment, or a member it names, is gone,
 * or a retried payment was undone since) and the 409s that a newer state explains. "limit_reached" is a 409 too, but a
 * full group is not a stale page, so it stays out.
 */
export function isStaleAnswer(code: string): boolean {
  return code === "not_found" || code === "client_id_conflict" || code === "stale_version";
}

// A Record over core's RateError, so a new rate error fails the typecheck here instead of reaching the page as the
// generic message.
const RATE_PARSE_CODES: Record<RateError, string> = {
  format: "rate_format",
  too_precise: "rate_too_precise",
  zero: "rate_zero",
  out_of_range: "rate_out_of_range",
};

/**
 * Every code the server sends about the rate field, and nothing else. Listed, never matched by prefix: "rate_limited"
 * is about the caller's network, not the rate.
 */
export const RATE_FIELD_CODES: ReadonlySet<string> = new Set([
  ...Object.values(RATE_PARSE_CODES),
  "rate_required",
  "rate_forbidden",
]);

export type MessageContext = {
  /** The group name as typed. bad_name covers an empty, a long and a hidden-character name, told apart by the name. */
  readonly groupName?: string;
  /** The member name as typed, for bad_member_name. */
  readonly memberName?: string;
  /** The description as typed, for bad_description. */
  readonly description?: string;
  /** The expense currency code, such as "USD". */
  readonly currency?: string;
  /** How many decimals that currency has, from the ISO 4217 table. */
  readonly digits?: number;
  /** The expense amount written with the currency's decimals, such as "100.00". */
  readonly total?: string;
  /** The group's base currency code. */
  readonly base?: string;
};

/**
 * The text a name or description is checked and sent as: trimmed and in NFC, the same steps the server applies,
 * so the browser counts characters the way the server does.
 */
export function cleanText(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** True when the cleaned text is longer than `max` characters. */
export function isTooLong(raw: string, max: number): boolean {
  // Characters, not UTF-16 units, so an emoji counts once here exactly as it does on the server.
  return [...cleanText(raw)].length > max;
}

export type TextProblem = "empty" | "too_long" | "hidden";

/**
 * Why the server's own rule for names and descriptions (cleanName in lib/text.ts, imported, never copied) refuses
 * `raw`, or null when it accepts it. Whether the text passes is cleanName's answer alone; the reason only picks the
 * words.
 */
export function textProblem(raw: string, max: number): TextProblem | null {
  if (cleanName(raw, max) !== null) return null;
  if (cleanText(raw) === "") return "empty";
  if (isTooLong(raw, max)) return "too_long";
  // Not empty and not too long, so what the rule refused is a hidden character, or broken text that hides one.
  return "hidden";
}

// The words for one refused name or description. With no text to read, or text the rule accepts (the server refused
// what the browser passed), the server's own wording is all that can be said.
function textMessage(
  raw: string | undefined,
  max: number,
  words: { readonly [problem in TextProblem]: string },
  fallback: string,
): string {
  const problem = raw === undefined ? null : textProblem(raw, max);
  return problem === null ? fallback : words[problem];
}

/**
 * The exact message for an error code. Codes that need a value (a currency, a total, the base) fall back to
 * the generic message when the context lacks it, so a message never shows "undefined".
 * Unknown codes, including a network failure, give the generic message.
 */
export function messageFor(code: string, context: MessageContext = {}): string {
  switch (code) {
    case "bad_name": {
      const fallback = `Group names need 1 to ${GROUP_NAME_MAX} characters, with no hidden formatting.`;
      return textMessage(
        context.groupName,
        GROUP_NAME_MAX,
        {
          empty: "Give the group a name.",
          too_long: `Group names can be at most ${GROUP_NAME_MAX} characters.`,
          hidden: "Remove hidden formatting characters from the group name.",
        },
        fallback,
      );
    }
    case "too_few_members":
      return "Add at least two members.";
    case "duplicate_member_name":
      return "Each member needs a different name.";
    case "bad_member_name": {
      const fallback = `Names need 1 to ${MEMBER_NAME_MAX} characters, with no hidden formatting.`;
      return textMessage(
        context.memberName,
        MEMBER_NAME_MAX,
        {
          empty: fallback,
          too_long: `Names can be at most ${MEMBER_NAME_MAX} characters.`,
          hidden: "Remove hidden formatting characters from this name.",
        },
        fallback,
      );
    }
    case "too_many_members":
      return "A group can have at most 20 members.";
    case "member_in_use":
      return "Only a member with no expenses or payments can be removed.";
    case "base_locked":
      return "Base currency is fixed once money is recorded.";
    case "bad_description": {
      const fallback = `Descriptions need 1 to ${DESCRIPTION_MAX} characters, with no hidden formatting.`;
      return textMessage(
        context.description,
        DESCRIPTION_MAX,
        {
          empty: "Describe the expense.",
          too_long: fallback,
          hidden: "Remove hidden formatting characters from the description.",
        },
        fallback,
      );
    }
    case "amount_format":
      return "Enter an amount like 12.50.";
    case "amount_too_many_decimals":
      if (context.currency === undefined || context.digits === undefined) return FALLBACK_MESSAGE;
      return `${context.currency} amounts have at most ${context.digits} decimals.`;
    case "amount_zero":
      return "The amount must be more than zero.";
    case "amount_too_large":
    case "base_too_large":
      return "That amount is too large.";
    case "converts_to_zero":
      return "That amount is too small to convert.";
    case "split_empty":
      return "Choose at least one person to split with.";
    case "split_bad_weight":
      return "Shares are whole numbers from 0 to 1000.";
    case "split_exact_sum_mismatch":
      if (context.total === undefined || context.currency === undefined) return FALLBACK_MESSAGE;
      return `The exact amounts must add up to ${context.total} ${context.currency}.`;
    case "rate_required":
      if (context.base === undefined) return FALLBACK_MESSAGE;
      return `Enter the rate to ${context.base}.`;
    case "rate_limited":
      return "Too many requests from your network. Wait a minute and try again.";
    case "stale_version":
      return "This expense was changed by someone else. Reload to see the latest.";
    case "limit_reached":
      return "This group has reached its size limit.";
    default:
      return RATE_FIELD_CODES.has(code) ? "Enter a rate like 0.92." : FALLBACK_MESSAGE;
  }
}
