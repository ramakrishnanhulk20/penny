# Penny: product requirements

Penny splits shared costs between a group of people (flatmates, a trip, a small team) to the exact smallest unit of each currency, and turns the group's balances into the fewest payments that settle everyone up. There are no accounts: a group is opened by its private link.

This document describes exactly what Penny does, screen by screen, including the exact wording of every message, so that every behaviour can be tested.

## Users and the core promise

- A **group** has a name, a base currency and 2 to 20 members.
- Anyone holding the group's link can view and change it. The link's secret part sits after `#` in the address, so it is never sent to the server in the address itself.
- Every amount is exact. A split always adds up to the expense, to the cent (or to the currency's smallest unit). The balances of a group always add up to exactly zero.
- **Settle up** lists the fewest payments that bring every balance to exactly zero.

## Pages

### 1. Home `/`
- Headline: "Split shared costs to the penny."
- Subline: "Add what everyone paid. Penny works out the fewest payments to settle up, exact to the last cent."
- Primary button: "Start a group" (goes to `/new`).
- Secondary button: "Try a sample trip" (creates a brand-new group pre-filled with a sample four-person trip and opens it; every click makes a new, separate group).

### 2. Start a group `/new`
- Fields:
  - "Group name": required, 1 to 60 characters.
  - "Base currency": a list of ISO 4217 currencies, default EUR. This is the currency balances are shown in.
  - "Members": starts with 2 name fields; "Add member" adds one more field, up to 20; each extra field has a "Remove" button. Each name 1 to 40 characters. Two members cannot have the same name (letter case ignored).
- Button: "Create group".
- Errors, shown under the field:
  - Empty group name: "Give the group a name."
  - Fewer than 2 named members: "Add at least two members."
  - Duplicate names: "Each member needs a different name."
  - Name too long: "Names can be at most 40 characters." (group name: "Group names can be at most 60 characters.")
- On success the browser opens the group page and shows a banner: "Group created. Share this link with your group:" followed by the full link and a "Copy link" button.

### 3. Group page `/g#<link-secret>`
Top: the group name, "Balances in <BASE>" (for example "Balances in EUR"), and the buttons "Copy link" and "Reset link".

**Who are you?** A selector "You are:" listing the members. The choice is remembered on this device only and is used to pre-select "Paid by". It is a convenience, not a login.

**Balances** section, one row per member, in the order they were added:
- Positive balance: "<Name> is owed <amount> <BASE>" (for example "Ana is owed 45.67 EUR").
- Negative balance: "<Name> owes <amount> <BASE>".
- Zero: "<Name> is settled up".
- Below the list: "Total: 0.00 <BASE>", always exactly zero.

**Settle up** section:
- When everyone is at zero: "Everyone is settled up."
- Otherwise one line per payment: "<From> pays <To> <amount> <BASE>", each with a "Mark as paid" button. "Mark as paid" records that payment; the balances and the plan update at once.
- Under the list: "<N> payments settle <M> expenses." (the proof line; "1 payment settles" for one).

**Add an expense** form:
- "What was it for?": required, 1 to 80 characters.
- "Amount": required, for example 12.50. Up to the currency's number of decimals (USD 2, JPY 0, KWD 3).
- "Currency": defaults to the base currency.
- "Rate to <BASE>": shown only when the currency differs from the base. Pre-filled with the European Central Bank reference rate for the latest day available, labelled "ECB reference rate, <date>"; the user can change it. If no rate can be fetched: "No reference rate available. Enter the rate you used."
- "Paid by": one member.
- "Split": three choices.
  - "Equally": a checkbox per member, all ticked by default; the amount is divided equally among ticked members, with any leftover cents going to the members listed first.
  - "By shares": a whole number per member (for example 2 for a couple, 1 for a single), 0 to leave someone out.
  - "Exact amounts": an amount per member; a live line shows "<remaining> <CUR> left to assign" or "<excess> <CUR> over the total".
- A live preview lists each member's share before saving.
- Button: "Add expense".
- Errors:
  - "Describe the expense."
  - "Enter an amount like 12.50."
  - "<CUR> amounts have at most <n> decimals." (for example "USD amounts have at most 2 decimals.", "JPY amounts have at most 0 decimals.")
  - "The amount must be more than zero."
  - "That amount is too large."
  - "That amount is too small to convert."
  - "Choose at least one person to split with."
  - "Shares are whole numbers from 0 to 1000."
  - "Enter a rate like 0.92."
  - "The exact amounts must add up to <total> <CUR>."
  - "Enter the rate to <BASE>."
- After saving, the expense appears at the top of the list, and the balances and the settle-up plan update.

Any unexpected failure shows "Something went wrong. Try again." While the group loads the page shows "Loading the group...". "Copy link" confirms with "Link copied". The "You are:" selector starts on "Choose your name". In "Exact amounts" mode the live line reads "All assigned" once the amounts add up.

**Expenses** list, newest first (empty: "No expenses yet."): description, "<amount> <CUR>", "paid by <Name>", and for a foreign currency also "= <base amount> <BASE> at <rate>". Each has "Edit" and "Delete".
- "Edit" opens the same form filled in; "Save changes" updates it. If someone else changed it first: "This expense was changed by someone else. Reload to see the latest."
- "Delete" asks "Delete this expense?" with "Delete" and "Cancel".

**Payments** list: "<From> paid <To> <amount> <BASE>", each with "Undo".

**Reset link**: asks "Make a new link? The old link will stop working for everyone." with "Make new link" and "Cancel". After confirming, the page shows the new link with "Copy link", and the old link opens the not-found page.

**Members**: "Add member" adds a member (same name rules). "Remove" next to a member is offered only for members with a zero balance who appear in no expense or payment; otherwise the button is absent.

**Base currency**: can be changed only while the group has no expenses or payments; afterwards it is shown as fixed.

### 4. Link not found
Any group link that is malformed, unknown or reset shows: "This link doesn't open a group. It may have been reset. Ask the group for the current link." and a "Start a group" button.

### 5. Checks `/checks`
A public page showing how Penny is tested. For the version that is live right now: its commit, and the TestSprite verdict that allowed it to ship. Then every recent pull request with its TestSprite verdict ("passed", "failed", "not run", "unknown"), pass and fail counts, and links to the pull request and the TestSprite report.

## Rules (what must always be true)

1. Every amount is stored exactly in the currency's smallest unit; nothing is rounded except a currency conversion, which rounds once per expense, half up.
2. The parts of every split add up exactly to the expense, in its own currency and in the base currency.
3. The balances of a group always add up to exactly zero.
4. Applying the settle-up payments brings every member to exactly zero, using the fewest payments possible for groups of up to 16 people with a balance.
5. Pressing "Add expense" twice quickly, or a dropped connection that retries, never adds the expense twice.
6. One group's link can never read or change another group.
7. After "Reset link", the old link opens nothing.

## Limits

- 2 to 20 members per group; 500 expenses and 500 payments per group.
- Amounts up to 10^12 of the currency's smallest unit (10,000,000,000.00 in a two-decimal currency).
- Rates above 0 and up to 1,000,000, with at most 10 decimals.

## Out of scope

Accounts and passwords, moving real money, receipt photos, recurring expenses, notifications.
