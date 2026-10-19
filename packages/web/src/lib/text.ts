// One Unicode category test instead of a list of bad characters (threat model C25): Cc and Cf cover every control,
// bidi override and zero-width character, including ones nobody thought to list. It does not catch lookalikes.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/**
 * Cleans a group name, member name or description: refuses it if it is not well-formed Unicode (a lone surrogate,
 * which JSON can carry as an escape), then trims it, normalises it to NFC, and refuses it if it is empty, holds any
 * Unicode control or format character, or is longer than `max` characters (counted as code points, so an emoji counts
 * once). Returns the cleaned string, or null when it is refused. Free of server imports so the browser can run the
 * same rule.
 */
export function cleanName(raw: string, max: number): string | null {
  // One built-in test for every lone surrogate. Let through, one is either stored as U+FFFD in place of what was sent,
  // or refused by Postgres inside the event log's JSON, which turns this 400 into a 500.
  if (!raw.isWellFormed()) return null;
  const name = raw.trim().normalize("NFC");
  if (name === "" || CONTROL_OR_FORMAT.test(name) || [...name].length > max) return null;
  return name;
}

/** The key two member names are compared on: NFC, then lower case. Stored as members.name_key. */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
