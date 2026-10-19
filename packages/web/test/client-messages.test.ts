// Not covered: which field each message sits under, its aria-describedby link and the focus move. Those need a browser.
import { describe, expect, it } from "vitest";
import { FALLBACK_MESSAGE, messageFor } from "@/lib/client/messages";

const expense = { currency: "USD", digits: 2, total: "100.00", base: "EUR" };

describe("messageFor", () => {
  it.each([
    ["too_few_members", "Add at least two members."],
    ["duplicate_member_name", "Each member needs a different name."],
    ["bad_member_name", "Names can be at most 40 characters."],
    ["bad_description", "Describe the expense."],
    ["amount_format", "Enter an amount like 12.50."],
    ["amount_zero", "The amount must be more than zero."],
    ["amount_too_large", "That amount is too large."],
    ["base_too_large", "That amount is too large."],
    ["converts_to_zero", "That amount is too small to convert."],
    ["split_empty", "Choose at least one person to split with."],
    ["stale_version", "This expense was changed by someone else. Reload to see the latest."],
  ])("%s gives its exact string", (code, expected) => {
    expect(messageFor(code, expense)).toBe(expected);
  });

  it("bad_name tells an empty name from a long one", () => {
    expect(messageFor("bad_name", { groupName: "" })).toBe("Give the group a name.");
    expect(messageFor("bad_name", { groupName: "   " })).toBe("Give the group a name.");
    expect(messageFor("bad_name", { groupName: "x".repeat(61) })).toBe("Group names can be at most 60 characters.");
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
    "limit_reached",
    "bad_currency",
    "too_many_members",
    "split_bad_amount",
    "",
    "constructor",
    "__proto__",
  ])("%j gives the generic message", (code) => {
    expect(messageFor(code, expense)).toBe("Something went wrong. Try again.");
  });

  it("gives the generic message, never a blank, when a needed value is missing", () => {
    expect(messageFor("bad_name")).toBe(FALLBACK_MESSAGE);
    expect(messageFor("bad_name", { groupName: "Trip" })).toBe(FALLBACK_MESSAGE);
    expect(messageFor("amount_too_many_decimals", { currency: "USD" })).toBe(FALLBACK_MESSAGE);
    expect(messageFor("split_exact_sum_mismatch", { currency: "USD" })).toBe(FALLBACK_MESSAGE);
    expect(messageFor("rate_required")).toBe(FALLBACK_MESSAGE);
  });
});
