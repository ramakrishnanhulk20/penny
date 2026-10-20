"use client";

import {
  MAX_AMOUNT_MINOR,
  allocate,
  convert,
  currency,
  formatAmount,
  listCurrencies,
  parseAmount,
  parseRate,
  type Currency,
} from "@penny/core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FieldError } from "@/components/field-error";
import {
  SplitEditor,
  draftFor,
  memberControlId,
  readSplit,
  startingDraft,
  withoutExactAmounts,
  type SplitDraft,
} from "@/components/split-editor";
import type { ExpenseView, GroupView, MemberView, SplitRequest } from "@/lib/api-types";
import { addExpense, editExpense } from "@/lib/client/api";
import { lookUpRate } from "@/lib/client/fx";
import {
  DESCRIPTION_MAX,
  FALLBACK_MESSAGE,
  RATE_FIELD_CODES,
  cleanText,
  messageFor,
  textProblem,
  type MessageContext,
} from "@/lib/client/messages";

const CURRENCY_CODES = listCurrencies().map((cur) => cur.code);
const ZERO = BigInt(0);
// Arrow keys through the currency list change it once per currency passed; only the last one gets a lookup.
const RATE_LOOKUP_DELAY_MS = 300;
const NO_MEMBER_ERRORS: ReadonlyMap<string, string> = new Map();

type Field = "description" | "amount" | "currency" | "rate" | "split" | "form";

/** Where the rate field's suggestion stands: none asked for yet, being looked up, found, or not available. */
type RateSource =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "found"; readonly date: string }
  | { readonly state: "none" };

type FieldErrors = { readonly [field in Field]?: string } & { readonly members?: ReadonlyMap<string, string> };

type ExpenseInput = {
  readonly description: string;
  readonly amountText: string;
  readonly cur: Currency;
  readonly base: Currency;
  readonly rateText: string;
  readonly draft: SplitDraft;
  readonly members: readonly MemberView[];
};

type ExpenseCheck =
  | { readonly ok: true; readonly split: SplitRequest }
  | {
      readonly ok: false;
      readonly codes: { readonly [field in Field]?: string };
      readonly memberCodes: ReadonlyMap<string, string>;
    };

// The browser's checks, run with the server's own parsers so a refusal here is the refusal the server would give.
// Unlike the server, it reports every bad field at once.
function checkExpense(input: ExpenseInput): ExpenseCheck {
  const codes: { [field in Field]?: string } = {};
  if (textProblem(input.description, DESCRIPTION_MAX) !== null) codes.description = "bad_description";

  const parsed = parseAmount(input.amountText, input.cur);
  const total = parsed.ok ? parsed.value : null;
  if (!parsed.ok) codes.amount = `amount_${parsed.error}`;

  if (input.cur.code !== input.base.code) {
    const rate = input.rateText === "" ? null : parseRate(input.rateText);
    if (rate === null) codes.rate = "rate_required";
    else if (!rate.ok) codes.rate = `rate_${rate.error}`;
    else if (total !== null) {
      const inBase = convert(total, input.cur, input.base, rate.value);
      if (inBase === ZERO) codes.amount = "converts_to_zero";
      else if (inBase > MAX_AMOUNT_MINOR) codes.amount = "base_too_large";
    }
  }

  const reading = readSplit(input.draft, input.members, input.cur);
  const memberCodes = reading.ok ? NO_MEMBER_ERRORS : reading.memberErrors;
  if (reading.ok) {
    const included = reading.split.mode === "equal" ? reading.split.members.length : reading.split.parts.length;
    if (included === 0) codes.split = "split_empty";
    else if (total !== null) {
      const allocation = allocate(total, reading.split);
      if (!allocation.ok) codes.split = `split_${allocation.error}`;
    }
  }

  if (reading.ok && Object.keys(codes).length === 0) return { ok: true, split: reading.request };
  return { ok: false, codes, memberCodes };
}

function fieldForServerCode(code: string): Field {
  if (code === "bad_description") return "description";
  if (code === "bad_currency") return "currency";
  if (code.startsWith("amount_") || code === "converts_to_zero" || code === "base_too_large") return "amount";
  if (RATE_FIELD_CODES.has(code)) return "rate";
  if (code.startsWith("split_")) return "split";
  return "form";
}

type ExpenseFormProps = {
  /** The group's link token, sent only in the request header. */
  readonly token: string;
  readonly group: GroupView;
  /** The member chosen under "You are:", or "" for none. */
  readonly you: string;
  /** The expense to edit, exactly as it was shown when "Edit" was pressed, or null to add a new one. */
  readonly editing: ExpenseView | null;
  readonly onSaved: (group: GroupView) => void;
  /** Called by "Cancel" and after a saved edit. The parent mounts a fresh, empty form to add an expense. */
  readonly onEditDone: () => void;
};

/**
 * The "Add an expense" form, which also edits an expense. One clientId is made when the form opens and kept until a
 * save succeeds, so a double press or a retry after a dropped connection sends the same clientId and the server
 * stores one expense. An edit sends the version it was shown instead, so the server refuses it once someone else has
 * changed the expense, and recognises a resend of the same edit. Its values are read once, when the form mounts.
 */
export function ExpenseForm({ token, group, you, editing, onSaved, onEditDone }: ExpenseFormProps) {
  const idPrefix = useId();
  const descriptionId = `${idPrefix}-description`;
  const amountId = `${idPrefix}-amount`;
  const currencyId = `${idPrefix}-currency`;
  const rateId = `${idPrefix}-rate`;
  const rateHelpId = `${idPrefix}-rate-help`;
  const paidById = `${idPrefix}-paid-by`;
  const splitPrefix = `${idPrefix}-split`;
  const submitId = `${idPrefix}-submit`;
  const formErrorId = `${idPrefix}-form-error`;

  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [description, setDescription] = useState(editing?.description ?? "");
  const [amount, setAmount] = useState(editing?.amount ?? "");
  const [currencyCode, setCurrencyCode] = useState(editing?.currency ?? group.baseCurrency);
  const [rate, setRate] = useState(editing?.rate ?? "");
  const [paidByChoice, setPaidByChoice] = useState<string | null>(editing?.paidBy ?? null);
  const [draft, setDraft] = useState<SplitDraft>(() =>
    editing === null ? startingDraft() : draftFor(editing, group.members),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  // "Edit" sits in the list below the form, so the filled form is brought into view by focusing its first field.
  const [focusRequest, setFocusRequest] = useState<{ readonly id: string } | null>(
    editing === null ? null : { id: descriptionId },
  );
  // A second press can land before React re-renders the disabled button, so the guard lives outside render.
  const inFlight = useRef(false);
  const [rateSource, setRateSource] = useState<RateSource>({ state: "idle" });
  // Read inside the lookup's answer, which can arrive after any number of renders, so these live outside render.
  const rateTyped = useRef(false);
  const rateLookup = useRef<AbortController | null>(null);
  const rateLookupTimer = useRef<number | null>(null);
  const suggestedRate = useRef<string | null>(null);

  useEffect(() => {
    if (focusRequest !== null) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  useEffect(
    () => () => {
      rateLookup.current?.abort();
      if (rateLookupTimer.current !== null) window.clearTimeout(rateLookupTimer.current);
    },
    [],
  );

  const base = currency(group.baseCurrency);
  const cur = currency(currencyCode);
  if (base === null || cur === null) return <p className="error">{FALLBACK_MESSAGE}</p>;

  const members = group.members;
  const foreign = cur.code !== base.code;
  const parsedAmount = parseAmount(amount, cur);
  const total = parsedAmount.ok ? parsedAmount.value : null;
  const context: MessageContext = {
    description,
    currency: cur.code,
    digits: cur.digits,
    total: total === null ? undefined : formatAmount(total, cur),
    base: base.code,
  };
  const isMember = (id: string | null) => id !== null && members.some((member) => member.id === id);
  const paidBy =
    paidByChoice !== null && isMember(paidByChoice) ? paidByChoice : isMember(you) ? you : (members[0]?.id ?? "");

  const focusIdFor = (field: Field): string => {
    switch (field) {
      case "description":
        return descriptionId;
      case "amount":
        return amountId;
      case "currency":
        return currencyId;
      case "rate":
        return rateId;
      case "split":
        return memberControlId(splitPrefix, 0);
      default:
        return submitId;
    }
  };

  // Asked RATE_LOOKUP_DELAY_MS after the last currency change. A change in the meantime cancels the wait, an answer for
  // a currency that has since been changed again is dropped, and a rate the person typed is never replaced.
  const lookUpReferenceRate = (code: string) => {
    rateLookup.current?.abort();
    rateLookup.current = null;
    if (rateLookupTimer.current !== null) window.clearTimeout(rateLookupTimer.current);
    rateLookupTimer.current = null;
    rateTyped.current = false;
    suggestedRate.current = null;
    if (code === base.code) {
      setRateSource({ state: "idle" });
      return;
    }
    setRateSource({ state: "loading" });
    rateLookupTimer.current = window.setTimeout(() => {
      rateLookupTimer.current = null;
      const controller = new AbortController();
      rateLookup.current = controller;
      void lookUpRate(code, base.code, controller.signal).then((found) => {
        if (controller.signal.aborted) return;
        rateLookup.current = null;
        if (!found.ok) {
          setRateSource({ state: "none" });
          return;
        }
        suggestedRate.current = found.rate;
        setRateSource({ state: "found", date: found.date });
        if (!rateTyped.current) setRate((current) => (current === "" ? found.rate : current));
      });
    }, RATE_LOOKUP_DELAY_MS);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;

    const checked = checkExpense({ description, amountText: amount, cur, base, rateText: rate, draft, members });
    if (!checked.ok) {
      const memberMessages = new Map<string, string>();
      for (const [memberId, code] of checked.memberCodes) memberMessages.set(memberId, messageFor(code, context));
      const messages: { [field in Field]?: string } = {};
      for (const [field, code] of Object.entries(checked.codes) as [Field, string][]) {
        messages[field] = messageFor(code, context);
      }
      setErrors({ ...messages, members: memberMessages });

      const firstField = (["description", "amount", "currency", "rate"] as const).find((field) => field in messages);
      const firstMember = members.findIndex((member) => memberMessages.has(member.id));
      if (firstField !== undefined) setFocusRequest({ id: focusIdFor(firstField) });
      else if (firstMember >= 0) setFocusRequest({ id: memberControlId(splitPrefix, firstMember) });
      else setFocusRequest({ id: focusIdFor("split") });
      return;
    }

    inFlight.current = true;
    setPending(true);
    setErrors({});
    const fields = {
      description: cleanText(description),
      amount,
      currency: cur.code,
      rate: foreign ? rate : null,
      paidBy,
      split: checked.split,
    };
    const result =
      editing === null
        ? await addExpense(token, { clientId, ...fields })
        : await editExpense(token, editing.id, { version: editing.version, ...fields });
    inFlight.current = false;
    setPending(false);

    if (result.ok && editing !== null) {
      onSaved(result.data.group);
      onEditDone();
      return;
    }

    if (result.ok) {
      setDescription("");
      setAmount("");
      // The currency stays as it was, so the next expense starts from the same suggested rate.
      rateTyped.current = false;
      setRate(suggestedRate.current ?? "");
      setDraft((current) => withoutExactAmounts(current));
      setClientId(crypto.randomUUID());
      onSaved(result.data.group);
      return;
    }

    // An earlier press was stored but its answer was lost, and the form has changed since. Without a fresh clientId
    // every later press would be refused until a reload.
    if (result.error === "client_id_conflict") setClientId(crypto.randomUUID());

    const serverField = fieldForServerCode(result.error);
    const field = serverField === "rate" && !foreign ? "form" : serverField;
    setErrors({ [field]: messageFor(result.error, context) });
    setFocusRequest({ id: focusIdFor(field) });
  };

  const describedBy = (id: string, message: string | undefined) => (message === undefined ? undefined : `${id}-error`);

  return (
    <form onSubmit={submit} data-testid="expense-form">
      <div className="field">
        <label htmlFor={descriptionId}>What was it for?</label>
        <input
          id={descriptionId}
          type="text"
          autoComplete="off"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-invalid={errors.description === undefined ? undefined : true}
          aria-describedby={describedBy(descriptionId, errors.description)}
          data-testid="expense-description"
        />
        <FieldError id={`${descriptionId}-error`} message={errors.description} />
      </div>

      <div className="field">
        <label htmlFor={amountId}>Amount</label>
        <input
          id={amountId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          aria-invalid={errors.amount === undefined ? undefined : true}
          aria-describedby={describedBy(amountId, errors.amount)}
          data-testid="expense-amount"
        />
        <FieldError id={`${amountId}-error`} message={errors.amount} />
      </div>

      <div className="field">
        <label htmlFor={currencyId}>Currency</label>
        <select
          id={currencyId}
          value={cur.code}
          onChange={(event) => {
            setCurrencyCode(event.target.value);
            // A rate belongs to one pair of currencies, so it never carries over to another.
            setRate("");
            lookUpReferenceRate(event.target.value);
          }}
          aria-invalid={errors.currency === undefined ? undefined : true}
          aria-describedby={describedBy(currencyId, errors.currency)}
          data-testid="expense-currency"
        >
          {CURRENCY_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <FieldError id={`${currencyId}-error`} message={errors.currency} />
      </div>

      {foreign && (
        <div className="field">
          <label htmlFor={rateId}>{`Rate to ${base.code}`}</label>
          <input
            id={rateId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={rate}
            placeholder={rateSource.state === "loading" ? "Looking up the rate..." : undefined}
            onChange={(event) => {
              rateTyped.current = true;
              setRate(event.target.value);
            }}
            aria-invalid={errors.rate === undefined ? undefined : true}
            aria-describedby={errors.rate === undefined ? rateHelpId : `${rateHelpId} ${rateId}-error`}
            data-testid="expense-rate"
          />
          {rateSource.state === "found" && (
            <p id={rateHelpId} data-testid="rate-source">{`ECB reference rate, ${rateSource.date}`}</p>
          )}
          {rateSource.state === "none" && (
            <p id={rateHelpId} data-testid="rate-source">
              No reference rate available. Enter the rate you used.
            </p>
          )}
          {(rateSource.state === "idle" || rateSource.state === "loading") && (
            <p id={rateHelpId}>Enter the rate you used.</p>
          )}
          <FieldError id={`${rateId}-error`} message={errors.rate} />
        </div>
      )}

      <div className="field">
        <label htmlFor={paidById}>Paid by</label>
        <select
          id={paidById}
          value={paidBy}
          onChange={(event) => setPaidByChoice(event.target.value)}
          data-testid="expense-paid-by"
        >
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </div>

      <SplitEditor
        idPrefix={splitPrefix}
        members={members}
        currency={cur}
        total={total}
        draft={draft}
        onChange={setDraft}
        splitError={errors.split}
        memberErrors={errors.members ?? NO_MEMBER_ERRORS}
      />

      <div>
        <button
          id={submitId}
          type="submit"
          disabled={pending}
          aria-describedby={errors.form === undefined ? undefined : formErrorId}
          data-testid={editing === null ? "expense-submit" : "expense-save"}
        >
          {editing === null ? "Add expense" : "Save changes"}
        </button>
        {editing !== null && (
          <>
            {" "}
            <button type="button" disabled={pending} onClick={onEditDone} data-testid="expense-edit-cancel">
              Cancel
            </button>
          </>
        )}
      </div>
      <FieldError id={formErrorId} message={errors.form} />
    </form>
  );
}
