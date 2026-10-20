// Not covered: which field each message sits under, its aria-describedby link and the focus move; that the create form,
// the expense form and the member form call the checks tested here; and the reload a stale answer starts. Those need a
// browser. The scan for server codes reads the source as text, so a code built at run time from anything but core's
// RateError would slip past it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX as SERVER_DESCRIPTION_MAX,
  GROUP_NAME_MAX as SERVER_GROUP_NAME_MAX,
  MEMBER_NAME_MAX as SERVER_MEMBER_NAME_MAX,
} from "@/lib/api-schemas";
import {
  ALREADY_CHANGED_MESSAGE,
  DESCRIPTION_MAX,
  FALLBACK_MESSAGE,
  GROUP_NAME_MAX,
  MEMBER_NAME_MAX,
  RATE_FIELD_CODES,
  isStaleAnswer,
  isTooLong,
  messageFor,
  textProblem,
} from "@/lib/client/messages";
import { cleanName } from "@/lib/text";

const expense = { currency: "USD", digits: 2, total: "100.00", base: "EUR" };

describe("messageFor", () => {
  it.each([
    ["too_few_members", "Add at least two members."],
    ["duplicate_member_name", "Each member needs a different name."],
    ["bad_member_name", "Names need 1 to 40 characters, with no hidden formatting."],
    ["too_many_members", "A group can have at most 20 members."],
    ["member_in_use", "Only a member with no expenses or payments can be removed."],
    ["base_locked", "Base currency is fixed once money is recorded."],
    ["bad_description", "Descriptions need 1 to 80 characters, with no hidden formatting."],
    ["rate_limited", "Too many requests from your network. Wait a minute and try again."],
    ["amount_format", "Enter an amount like 12.50."],
    ["amount_zero", "The amount must be more than zero."],
    ["amount_too_large", "That amount is too large."],
    ["base_too_large", "That amount is too large."],
    ["converts_to_zero", "That amount is too small to convert."],
    ["split_empty", "Choose at least one person to split with."],
    ["stale_version", "This expense was changed by someone else. Reload to see the latest."],
    ["limit_reached", "This group has reached its size limit."],
  ])("%s gives its exact string", (code, expected) => {
    expect(messageFor(code, expense)).toBe(expected);
  });

  it("bad_name tells an empty name from a long one and from one with a hidden character", () => {
    expect(messageFor("bad_name", { groupName: "" })).toBe("Give the group a name.");
    expect(messageFor("bad_name", { groupName: "   " })).toBe("Give the group a name.");
    expect(messageFor("bad_name", { groupName: "x".repeat(61) })).toBe("Group names can be at most 60 characters.");
    expect(messageFor("bad_name", { groupName: "Trip\u200B" })).toBe(
      "Remove hidden formatting characters from the group name.",
    );
    // The browser passed it but the server refused it: only the server's wording is left to say.
    expect(messageFor("bad_name", { groupName: "Trip" })).toBe(
      "Group names need 1 to 60 characters, with no hidden formatting.",
    );
  });

  it("bad_member_name and bad_description name a hidden character, a long name and an empty description", () => {
    expect(messageFor("bad_member_name", { memberName: "Ana\u200F" })).toBe(
      "Remove hidden formatting characters from this name.",
    );
    expect(messageFor("bad_member_name", { memberName: "m".repeat(41) })).toBe("Names can be at most 40 characters.");
    expect(messageFor("bad_member_name", { memberName: "Ana" })).toBe(
      "Names need 1 to 40 characters, with no hidden formatting.",
    );
    expect(messageFor("bad_description", { description: "Taxi\u00AD" })).toBe(
      "Remove hidden formatting characters from the description.",
    );
    expect(messageFor("bad_description", { description: "  " })).toBe("Describe the expense.");
    expect(messageFor("bad_description", { description: "d".repeat(81) })).toBe(
      "Descriptions need 1 to 80 characters, with no hidden formatting.",
    );
  });

  it.each([
    ["USD", 2, "USD amounts have at most 2 decimals."],
    ["JPY", 0, "JPY amounts have at most 0 decimals."],
    ["KWD", 3, "KWD amounts have at most 3 decimals."],
  ])("amount_too_many_decimals fills in %s and its decimals", (currency, digits, expected) => {
    expect(messageFor("amount_too_many_decimals", { currency, digits })).toBe(expected);
  });

  it("split_bad_weight names the allowed range of shares", () => {
    expect(messageFor("split_bad_weight", expense)).toBe("Shares are whole numbers from 0 to 1000.");
  });

  it("split_exact_sum_mismatch fills in the total and the currency", () => {
    expect(messageFor("split_exact_sum_mismatch", expense)).toBe("The exact amounts must add up to 100.00 USD.");
    expect(messageFor("split_exact_sum_mismatch", { total: "1500", currency: "JPY" })).toBe(
      "The exact amounts must add up to 1500 JPY.",
    );
  });

  it("rate_required fills in the base currency", () => {
    expect(messageFor("rate_required", expense)).toBe("Enter the rate to EUR.");
    expect(messageFor("rate_required", { base: "GBP" })).toBe("Enter the rate to GBP.");
  });

  it.each(["rate_format", "rate_too_precise", "rate_zero", "rate_out_of_range", "rate_forbidden"])(
    "%s asks for a rate like 0.92",
    (code) => {
      expect(messageFor(code, expense)).toBe("Enter a rate like 0.92.");
    },
  );

  it.each([
    "invalid_body",
    "not_found",
    "internal",
    "network",
    "client_id_conflict",
    "bad_currency",
    "split_bad_amount",
    "",
    "constructor",
    "__proto__",
  ])("%j gives the generic message", (code) => {
    expect(messageFor(code, expense)).toBe("Something went wrong. Try again.");
  });

  it("gives the generic message, never a blank, when a needed value is missing", () => {
    expect(messageFor("amount_too_many_decimals", { currency: "USD" })).toBe(FALLBACK_MESSAGE);
    expect(messageFor("split_exact_sum_mismatch", { currency: "USD" })).toBe(FALLBACK_MESSAGE);
    expect(messageFor("rate_required")).toBe(FALLBACK_MESSAGE);
  });
});

describe("member name length", () => {
  it("counts an emoji as one character in the browser's check and in cleanName: 40 pass and 41 fail", () => {
    const forty = "\u{1F600}".repeat(40);
    const fortyOne = "\u{1F600}".repeat(41);
    expect([GROUP_NAME_MAX, MEMBER_NAME_MAX, DESCRIPTION_MAX]).toEqual([
      SERVER_GROUP_NAME_MAX,
      SERVER_MEMBER_NAME_MAX,
      SERVER_DESCRIPTION_MAX,
    ]);
    // 80 UTF-16 units, which a check on .length would have refused.
    expect(forty).toHaveLength(80);

    expect(isTooLong(forty, MEMBER_NAME_MAX)).toBe(false);
    expect(isTooLong(fortyOne, MEMBER_NAME_MAX)).toBe(true);
    expect(cleanName(forty, SERVER_MEMBER_NAME_MAX)).toBe(forty);
    expect(cleanName(fortyOne, SERVER_MEMBER_NAME_MAX)).toBeNull();
  });
});

describe("a stale Mark as paid or Undo", () => {
  it.each(["not_found", "client_id_conflict", "stale_version"])("treats %s as the page being behind", (code) => {
    expect(isStaleAnswer(code)).toBe(true);
  });

  it.each(["limit_reached", "rate_limited", "self_payment", "network", "internal", ""])(
    "does not treat %j as the page being behind",
    (code) => {
      expect(isStaleAnswer(code)).toBe(false);
    },
  );

  it("says so in its exact words", () => {
    expect(ALREADY_CHANGED_MESSAGE).toBe("This was already changed. Showing the latest.");
  });
});

describe("the browser's text check", () => {
  const samples = [
    "Ana",
    "  Ana  ",
    "",
    "   ",
    "m".repeat(40),
    "m".repeat(41),
    "Ana\u200B",
    "\u200FAna",
    "Ana\tBen",
    "Ana\u00AD",
    "Ana\uFEFFBen",
    "Ana\uD800",
    "Cafe\u0301",
    "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
    "\u0DC1\u0DCA\u200D\u0DBB\u0DD3",
    "\u200DAna",
    "Ana\u200C",
    "\u200D",
    "A\u200D\u200Dna",
    "Ana \u200DBen",
  ];

  it.each(samples)("passes %j exactly when the server's cleanName does", (raw) => {
    for (const max of [GROUP_NAME_MAX, MEMBER_NAME_MAX, DESCRIPTION_MAX]) {
      expect(textProblem(raw, max) === null).toBe(cleanName(raw, max) !== null);
    }
  });

  it("passes the family emoji, Persian and Sinhala joiners, and names a misplaced joiner as hidden formatting", () => {
    for (const name of [
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
      "\u0DC1\u0DCA\u200D\u0DBB\u0DD3",
    ]) {
      expect(textProblem(name, MEMBER_NAME_MAX)).toBeNull();
    }
    expect(messageFor("bad_member_name", { memberName: "Ana \u200DBen" })).toBe(
      "Remove hidden formatting characters from this name.",
    );
  });

  it("names the reason for each refusal", () => {
    expect(textProblem("   ", MEMBER_NAME_MAX)).toBe("empty");
    expect(textProblem("m".repeat(41), MEMBER_NAME_MAX)).toBe("too_long");
    expect(textProblem("Ana\u200B", MEMBER_NAME_MAX)).toBe("hidden");
    expect(textProblem("Ana\uD800", MEMBER_NAME_MAX)).toBe("hidden");
  });
});

// The codes the server's own source can send, read from it as text: every refuse(status, "code"), badRequest("code"),
// { error: { code } } and { ok: false, code } answer, every schema field code, the amount codes, and core's rate codes.
function serverCodes(): Set<string> {
  const src = join(__dirname, "..", "src");
  const files = [
    ...readdirSync(join(src, "lib"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(src, "lib", entry.name)),
    ...readdirSync(join(src, "app", "api"), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith("route.ts"))
      .map((name) => join(src, "app", "api", name)),
  ];
  const patterns = [
    /refuse\(\d{3}, "([a-z_]+)"\)/g,
    /badRequest\("([a-z_]+)"\)/g,
    /error: \{ code: "([a-z_]+)" \}/g,
    /ok: false, code: "([a-z_]+)"/g,
    /\{ error: "([a-z_]+)" \}/g,
    /cleanText\([A-Z_]+, "([a-z_]+)"\)/g,
    /"(amount_[a-z_]+)"/g,
  ];
  const codes = new Set<string>(RATE_FIELD_CODES);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) codes.add(match[1]);
  }
  return codes;
}

describe("every code the server sends", () => {
  const ENTER_RATE = "Enter a rate like 0.92.";
  const WORDS: Record<string, string> = {
    invalid_body: FALLBACK_MESSAGE,
    bad_name: "Group names need 1 to 60 characters, with no hidden formatting.",
    bad_member_name: "Names need 1 to 40 characters, with no hidden formatting.",
    bad_description: "Descriptions need 1 to 80 characters, with no hidden formatting.",
    too_few_members: "Add at least two members.",
    too_many_members: "A group can have at most 20 members.",
    duplicate_member_name: "Each member needs a different name.",
    bad_currency: FALLBACK_MESSAGE,
    amount_format: "Enter an amount like 12.50.",
    amount_too_many_decimals: FALLBACK_MESSAGE,
    amount_zero: "The amount must be more than zero.",
    amount_too_large: "That amount is too large.",
    split_empty: "Choose at least one person to split with.",
    split_duplicate_member: FALLBACK_MESSAGE,
    split_bad_weight: "Shares are whole numbers from 0 to 1000.",
    split_too_many_parts: FALLBACK_MESSAGE,
    split_exact_sum_mismatch: FALLBACK_MESSAGE,
    split_bad_amount: FALLBACK_MESSAGE,
    rate_required: FALLBACK_MESSAGE,
    rate_forbidden: ENTER_RATE,
    rate_format: ENTER_RATE,
    rate_too_precise: ENTER_RATE,
    rate_zero: ENTER_RATE,
    rate_out_of_range: ENTER_RATE,
    self_payment: FALLBACK_MESSAGE,
    converts_to_zero: "That amount is too small to convert.",
    base_too_large: "That amount is too large.",
    not_found: FALLBACK_MESSAGE,
    stale_version: "This expense was changed by someone else. Reload to see the latest.",
    member_in_use: "Only a member with no expenses or payments can be removed.",
    limit_reached: "This group has reached its size limit.",
    client_id_conflict: FALLBACK_MESSAGE,
    base_locked: "Base currency is fixed once money is recorded.",
    internal: FALLBACK_MESSAGE,
    unsupported_media_type: FALLBACK_MESSAGE,
    rate_limited: "Too many requests from your network. Wait a minute and try again.",
    no_rate: FALLBACK_MESSAGE,
    unavailable: FALLBACK_MESSAGE,
  };

  it("has words for exactly the codes the server's source holds", () => {
    expect(Object.keys(WORDS).sort()).toEqual([...serverCodes()].sort());
  });

  it.each(Object.entries(WORDS))("%s, with nothing typed to read, gives %j", (code, words) => {
    expect(messageFor(code)).toBe(words);
  });

  it("puts only rate codes on the rate field, and never the network's rate limit", () => {
    expect([...RATE_FIELD_CODES].sort()).toEqual([
      "rate_forbidden",
      "rate_format",
      "rate_out_of_range",
      "rate_required",
      "rate_too_precise",
      "rate_zero",
    ]);
    expect(RATE_FIELD_CODES.has("rate_limited")).toBe(false);
    expect(messageFor("rate_limited", { currency: "USD", base: "EUR", digits: 2 })).not.toMatch(/rate like|rate to/);
  });
});
