"use client";

import { listCurrencies } from "@penny/core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FieldError } from "@/components/field-error";
import { createGroup } from "@/lib/client/api";
import { GROUP_NAME_MAX, MEMBER_NAME_MAX, cleanText, isTooLong, messageFor } from "@/lib/client/messages";

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 20;
const DEFAULT_BASE = "EUR";
const CURRENCY_CODES = listCurrencies().map((cur) => cur.code);

type MemberRow = { readonly key: number; readonly value: string };

type FormErrors = {
  readonly name?: string;
  readonly currency?: string;
  readonly members?: string;
  /** Messages by row key, for the one member field each belongs to. */
  readonly rows?: ReadonlyMap<number, string>;
  readonly form?: string;
};

type Field = "name" | "currency" | "members" | "form";

// The browser's own checks, as error codes, run before any request. A blank member field is skipped rather than
// refused, because the rule counts named members.
function checkForm(name: string, rows: readonly MemberRow[]) {
  const nameCode = cleanText(name) === "" || isTooLong(name, GROUP_NAME_MAX) ? "bad_name" : undefined;
  const rowCodes = new Map<number, string>();
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows) {
    const value = cleanText(row.value);
    if (value === "") continue;
    names.push(value);
    if (isTooLong(value, MEMBER_NAME_MAX)) {
      rowCodes.set(row.key, "bad_member_name");
      continue;
    }
    // The server compares names the same way: NFC first, then lower case, so "Ana" and "ana" are one name.
    const key = value.toLowerCase();
    if (seen.has(key)) rowCodes.set(row.key, "duplicate_member_name");
    else seen.add(key);
  }
  const membersCode = names.length < MIN_MEMBERS ? "too_few_members" : undefined;
  return { nameCode, membersCode, rowCodes, names };
}

function fieldForServerCode(code: string): Field {
  switch (code) {
    case "bad_name":
      return "name";
    case "bad_currency":
      return "currency";
    case "too_few_members":
    case "too_many_members":
    case "duplicate_member_name":
    case "bad_member_name":
      return "members";
    default:
      return "form";
  }
}

export function CreateGroupForm() {
  const idPrefix = useId();
  const nameId = `${idPrefix}-name`;
  const currencyId = `${idPrefix}-currency`;
  const membersErrorId = `${idPrefix}-members-error`;
  const submitId = `${idPrefix}-submit`;
  const formErrorId = `${idPrefix}-form-error`;
  const rowId = (key: number) => `${idPrefix}-member-${key}`;

  const [name, setName] = useState("");
  const [baseCurrency, setBaseCurrency] = useState(DEFAULT_BASE);
  const [members, setMembers] = useState<{ readonly rows: readonly MemberRow[]; readonly nextKey: number }>({
    rows: [
      { key: 0, value: "" },
      { key: 1, value: "" },
    ],
    nextKey: 2,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [pending, setPending] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ readonly id: string } | null>(null);
  // A second press can land before React re-renders the disabled button, so the guard lives outside render.
  const inFlight = useRef(false);

  useEffect(() => {
    if (focusRequest !== null) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  const rows = members.rows;
  const firstRowId = rowId(rows[0]?.key ?? 0);

  function focusIdFor(field: Field): string {
    if (field === "name") return nameId;
    if (field === "currency") return currencyId;
    if (field === "members") return firstRowId;
    return submitId;
  }

  function setRowValue(key: number, value: string) {
    setMembers((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.key === key ? { key, value } : row)),
    }));
  }

  function addRow() {
    setMembers((current) =>
      current.rows.length >= MAX_MEMBERS
        ? current
        : { rows: [...current.rows, { key: current.nextKey, value: "" }], nextKey: current.nextKey + 1 },
    );
  }

  function removeRow(key: number) {
    setMembers((current) => ({ ...current, rows: current.rows.filter((row) => row.key !== key) }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    const context = { groupName: name };
    const checked = checkForm(name, rows);
    if (checked.nameCode !== undefined || checked.membersCode !== undefined || checked.rowCodes.size > 0) {
      const rowMessages = new Map<number, string>();
      for (const [key, code] of checked.rowCodes) rowMessages.set(key, messageFor(code, context));
      setErrors({
        name: checked.nameCode === undefined ? undefined : messageFor(checked.nameCode, context),
        members: checked.membersCode === undefined ? undefined : messageFor(checked.membersCode, context),
        rows: rowMessages,
      });
      const firstBadRow = rows.find((row) => rowMessages.has(row.key));
      if (checked.nameCode !== undefined) setFocusRequest({ id: nameId });
      else if (firstBadRow !== undefined) setFocusRequest({ id: rowId(firstBadRow.key) });
      else setFocusRequest({ id: firstRowId });
      return;
    }

    inFlight.current = true;
    setPending(true);
    setErrors({});
    const result = await createGroup({ name: cleanText(name), baseCurrency, members: checked.names });
    if (result.ok) {
      try {
        window.sessionStorage.setItem("penny:created", "1");
      } catch {
        // Storage can be switched off in the browser. The group still opens, just without the created banner.
      }
      // A full page load on purpose, so the group page reads its token from a fresh address with no client-router
      // timing in between. The button stays disabled while the browser leaves.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load wanted, see above
      window.location.assign("/g#" + result.data.token);
      return;
    }

    inFlight.current = false;
    setPending(false);
    const field = fieldForServerCode(result.error);
    setErrors({ [field]: messageFor(result.error, context) });
    setFocusRequest({ id: focusIdFor(field) });
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor={nameId}>Group name</label>
        <input
          id={nameId}
          type="text"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={errors.name === undefined ? undefined : true}
          aria-describedby={errors.name === undefined ? undefined : `${nameId}-error`}
        />
        <FieldError id={`${nameId}-error`} message={errors.name} />
      </div>

      <div className="field">
        <label htmlFor={currencyId}>Base currency</label>
        <select
          id={currencyId}
          value={baseCurrency}
          onChange={(event) => setBaseCurrency(event.target.value)}
          aria-invalid={errors.currency === undefined ? undefined : true}
          aria-describedby={errors.currency === undefined ? undefined : `${currencyId}-error`}
        >
          {CURRENCY_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <FieldError id={`${currencyId}-error`} message={errors.currency} />
      </div>

      <fieldset aria-describedby={errors.members === undefined ? undefined : membersErrorId}>
        <legend>Members</legend>
        {rows.map((row, index) => {
          const id = rowId(row.key);
          const message = errors.rows?.get(row.key);
          return (
            <div key={row.key} className="field">
              <label htmlFor={id}>{`Member ${index + 1}`}</label>
              <div className="inline">
                <input
                  id={id}
                  type="text"
                  autoComplete="off"
                  value={row.value}
                  onChange={(event) => setRowValue(row.key, event.target.value)}
                  aria-invalid={message === undefined ? undefined : true}
                  aria-describedby={message === undefined ? undefined : `${id}-error`}
                />
                {index >= MIN_MEMBERS && (
                  <button type="button" onClick={() => removeRow(row.key)}>
                    Remove
                  </button>
                )}
              </div>
              <FieldError id={`${id}-error`} message={message} />
            </div>
          );
        })}
        <FieldError id={membersErrorId} message={errors.members} />
        <div>
          <button type="button" onClick={addRow} disabled={rows.length >= MAX_MEMBERS}>
            Add member
          </button>
        </div>
      </fieldset>

      <div>
        <button
          id={submitId}
          type="submit"
          disabled={pending}
          aria-describedby={errors.form === undefined ? undefined : formErrorId}
        >
          Create group
        </button>
      </div>
      <FieldError id={formErrorId} message={errors.form} />
    </form>
  );
}
