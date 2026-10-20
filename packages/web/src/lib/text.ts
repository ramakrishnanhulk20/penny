// The longest name, member name and description, in characters. Here rather than beside the schemas so the browser,
// which cannot load those, checks against the same numbers.
export const GROUP_NAME_MAX = 60;
export const MEMBER_NAME_MAX = 40;
export const DESCRIPTION_MAX = 80;

// One Unicode category test instead of a list of bad characters (threat model C25): Cc and Cf cover every control,
// bidi override and zero-width character, including ones nobody thought to list. It does not catch lookalikes.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
// In a u-flag pattern a paired surrogate is one code point, so this matches only a lone one. It stands in for
// String.prototype.isWellFormed, which Safari before 16.4 lacks, now that the browser runs this module too.
const LONE_SURROGATE = /\p{Cs}/u;
const VISIBLE = /[^\p{White_Space}\p{Cc}\p{Cf}]/u;

// The one exception, a product decision: the zero-width joiner and non-joiner (U+200D, U+200C) are how family emoji,
// Persian and Sinhala are written, so each is allowed where it joins two visible characters. Visible means anything
// but white space, a control or a format character, which also rules out a second joiner beside it. A joiner at
// either end, beside a space, beside another joiner or beside any other Cc or Cf character is kept, so it is still
// refused below. A scan rather than a lookbehind pattern, which Safari before 16.4 cannot even parse.
function withoutJoinersBetweenVisible(text: string): string {
  const chars = [...text];
  const joinsVisible = (char: string, i: number) =>
    (char === "\u200C" || char === "\u200D") && i > 0 && i < chars.length - 1 && VISIBLE.test(chars[i - 1]) && VISIBLE.test(chars[i + 1]);
  return chars.filter((char, i) => !joinsVisible(char, i)).join("");
}

/**
 * Cleans a group name, member name or description: refuses it if it is not well-formed Unicode (a lone surrogate,
 * which JSON can carry as an escape), then trims it, normalises it to NFC, and refuses it if it is empty, holds any
 * Unicode control or format character other than a joiner between two visible characters, or is longer than `max`
 * characters (counted as code points, so an emoji counts once per code point and every joiner counts). Returns the
 * cleaned string, joiners kept, or null when it is refused. Free of server imports so the browser can run the same
 * rule.
 */
export function cleanName(raw: string, max: number): string | null {
  // A lone surrogate let through is either stored as U+FFFD in place of what was sent, or refused by Postgres inside
  // the event log's JSON, which turns this 400 into a 500.
  if (LONE_SURROGATE.test(raw)) return null;
  const name = raw.trim().normalize("NFC");
  if (name === "" || CONTROL_OR_FORMAT.test(withoutJoinersBetweenVisible(name)) || [...name].length > max) {
    return null;
  }
  return name;
}

/** The key two member names are compared on: NFC, then lower case. Stored as members.name_key. */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
