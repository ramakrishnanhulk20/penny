// Every error a person sees comes from here, for the browser's own checks and for the server's codes alike,
// so one problem is always worded one way. A server code is only ever a lookup key, never shown as text.

export const GROUP_NAME_MAX = 60;
export const MEMBER_NAME_MAX = 40;
export const DESCRIPTION_MAX = 80;

export const FALLBACK_MESSAGE = "Something went wrong. Try again.";

export type MessageContext = {
  /** The group name as typed. bad_name covers both an empty and a long name, and only the name tells them apart. */
  readonly groupName?: string;
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
  return cleanText(raw).length > max;
}

/**
 * The exact message for an error code. Codes that need a value (a currency, a total, the base) fall back to
 * the generic message when the context lacks it, so a message never shows "undefined".
 * Unknown codes, including a network failure, give the generic message.
 */
export function messageFor(code: string, context: MessageContext = {}): string {
  switch (code) {
    case "bad_name": {
      if (context.groupName === undefined) return FALLBACK_MESSAGE;
      if (cleanText(context.groupName) === "") return "Give the group a name.";
      if (isTooLong(context.groupName, GROUP_NAME_MAX)) return "Group names can be at most 60 characters.";
      return FALLBACK_MESSAGE;
    }
    case "too_few_members":
      return "Add at least two members.";
    case "duplicate_member_name":
      return "Each member needs a different name.";
    case "bad_member_name":
      return "Names can be at most 40 characters.";
    case "bad_description":
      return "Describe the expense.";
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
    default:
      return code.startsWith("rate_") ? "Enter a rate like 0.92." : FALLBACK_MESSAGE;
  }
}
