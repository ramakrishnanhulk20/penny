"use client";

import { MAX_WEIGHT, allocate, formatAmount, parseAmount, type Currency, type Split } from "@penny/core";
import type { MemberView, SplitMode, SplitRequest } from "@/lib/api-types";
import { FieldError } from "@/components/field-error";

export type SplitDraft = {
  readonly mode: SplitMode;
  /** Equally: the members whose box is unticked. Stored as the exceptions so everyone starts ticked. */
  readonly unticked: ReadonlySet<string>;
  /** By shares: the typed whole number per member id. No entry means the default of 1. */
  readonly weights: ReadonlyMap<string, string>;
  /** Exact amounts: the typed amount per member id. No entry means empty. */
  readonly exact: ReadonlyMap<string, string>;
};

/** What the browser read from the draft: the split to preview and send, or an error code per member field. */
export type SplitReading =
  | { readonly ok: true; readonly split: Split; readonly request: SplitRequest }
  | { readonly ok: false; readonly memberErrors: ReadonlyMap<string, string> };

const DEFAULT_WEIGHT = "1";
const ZERO = BigInt(0);

const MODES: readonly (readonly [SplitMode, string])[] = [
  ["equal", "Equally"],
  ["shares", "By shares"],
  ["exact", "Exact amounts"],
];

export function startingDraft(): SplitDraft {
  return { mode: "equal", unticked: new Set(), weights: new Map(), exact: new Map() };
}

/** The same draft with every exact amount emptied. The mode, the ticks and the shares stay. */
export function withoutExactAmounts(draft: SplitDraft): SplitDraft {
  return { ...draft, exact: new Map() };
}

/** The id of the split control for the member at `index`, so a form can move focus to it. */
export function memberControlId(idPrefix: string, index: number): string {
  return `${idPrefix}-member-${index}`;
}

// At most four ASCII digits reach Number(), so the conversion is exact and cannot produce NaN or a fraction.
function readWeight(text: string): number | null {
  if (!/^[0-9]{1,4}$/.test(text)) return null;
  const weight = Number(text);
  return weight <= MAX_WEIGHT ? weight : null;
}

/**
 * Reads the draft with the same parser the server uses. A share of 0 and an empty or zero exact amount leave
 * that member out of the split. Anything that is not a valid share or amount is an error on that member's field.
 * Never checks the split against the expense total: `allocate` does that.
 */
export function readSplit(draft: SplitDraft, members: readonly MemberView[], cur: Currency): SplitReading {
  if (draft.mode === "equal") {
    const ids = members.filter((member) => !draft.unticked.has(member.id)).map((member) => member.id);
    return { ok: true, split: { mode: "equal", members: ids }, request: { mode: "equal", members: ids } };
  }

  const memberErrors = new Map<string, string>();

  if (draft.mode === "shares") {
    const parts: { memberId: string; weight: number }[] = [];
    for (const member of members) {
      const weight = readWeight(draft.weights.get(member.id) ?? DEFAULT_WEIGHT);
      if (weight === null) memberErrors.set(member.id, "split_bad_weight");
      else if (weight > 0) parts.push({ memberId: member.id, weight });
    }
    if (memberErrors.size > 0) return { ok: false, memberErrors };
    return { ok: true, split: { mode: "shares", parts }, request: { mode: "shares", parts } };
  }

  const parts: { memberId: string; amount: bigint }[] = [];
  const requestParts: { memberId: string; amount: string }[] = [];
  for (const member of members) {
    const text = draft.exact.get(member.id) ?? "";
    if (text === "") continue;
    const parsed = parseAmount(text, cur);
    if (parsed.ok) {
      parts.push({ memberId: member.id, amount: parsed.value });
      requestParts.push({ memberId: member.id, amount: text });
    } else if (parsed.error !== "zero") {
      memberErrors.set(member.id, `amount_${parsed.error}`);
    }
  }
  if (memberErrors.size > 0) return { ok: false, memberErrors };
  return { ok: true, split: { mode: "exact", parts }, request: { mode: "exact", parts: requestParts } };
}

function remainingLine(total: bigint, split: Split, cur: Currency): string | null {
  if (split.mode !== "exact") return null;
  const left = split.parts.reduce((rest, part) => rest - part.amount, total);
  if (left > ZERO) return `${formatAmount(left, cur)} ${cur.code} left to assign`;
  if (left < ZERO) return `${formatAmount(-left, cur)} ${cur.code} over the total`;
  return "All assigned";
}

function withEntry(map: ReadonlyMap<string, string>, key: string, value: string): ReadonlyMap<string, string> {
  const updated = new Map(map);
  updated.set(key, value);
  return updated;
}

function withTick(unticked: ReadonlySet<string>, memberId: string, ticked: boolean): ReadonlySet<string> {
  const updated = new Set(unticked);
  if (ticked) updated.delete(memberId);
  else updated.add(memberId);
  return updated;
}

type SplitEditorProps = {
  readonly idPrefix: string;
  readonly members: readonly MemberView[];
  readonly currency: Currency;
  /** The expense amount in minor units, or null while the amount field does not parse. */
  readonly total: bigint | null;
  readonly draft: SplitDraft;
  readonly onChange: (draft: SplitDraft) => void;
  /** The message for the split as a whole, shown at the end of the fieldset. */
  readonly splitError: string | undefined;
  /** The message per member id, shown under that member's share or amount. */
  readonly memberErrors: ReadonlyMap<string, string>;
};

/**
 * The three split modes, the live preview of each member's part and, for exact amounts, the line that says
 * what is left to assign. The preview runs `allocate` from @penny/core, the same code the server runs.
 */
export function SplitEditor({
  idPrefix,
  members,
  currency,
  total,
  draft,
  onChange,
  splitError,
  memberErrors,
}: SplitEditorProps) {
  const reading = readSplit(draft, members, currency);
  const allocation = total !== null && reading.ok ? allocate(total, reading.split) : null;
  const parts = allocation !== null && allocation.ok ? allocation.value : null;
  const remaining = total !== null && reading.ok ? remainingLine(total, reading.split, currency) : null;
  const splitErrorId = `${idPrefix}-split-error`;

  return (
    <>
      <fieldset aria-describedby={splitError === undefined ? undefined : splitErrorId}>
        <legend>Split</legend>
        <div className="choices">
          {MODES.map(([mode, label]) => (
            <label key={mode}>
              <input
                type="radio"
                name={`${idPrefix}-mode`}
                value={mode}
                checked={draft.mode === mode}
                onChange={() => onChange({ ...draft, mode })}
                data-testid={`split-mode-${mode}`}
              />{" "}
              {label}
            </label>
          ))}
        </div>

        <ul className="plain">
          {members.map((member, index) => {
            const controlId = memberControlId(idPrefix, index);
            const errorId = `${controlId}-error`;
            const message = memberErrors.get(member.id);

            if (draft.mode === "equal") {
              return (
                <li key={member.id}>
                  <label>
                    <input
                      id={controlId}
                      type="checkbox"
                      checked={!draft.unticked.has(member.id)}
                      onChange={(event) =>
                        onChange({ ...draft, unticked: withTick(draft.unticked, member.id, event.target.checked) })
                      }
                      data-testid="split-member-checkbox"
                    />{" "}
                    {member.name}
                  </label>
                </li>
              );
            }

            const isShares = draft.mode === "shares";
            return (
              <li key={member.id} className="field">
                <label htmlFor={controlId}>{member.name}</label>
                <input
                  id={controlId}
                  type="text"
                  inputMode={isShares ? "numeric" : "decimal"}
                  autoComplete="off"
                  value={
                    isShares ? (draft.weights.get(member.id) ?? DEFAULT_WEIGHT) : (draft.exact.get(member.id) ?? "")
                  }
                  onChange={(event) =>
                    onChange(
                      isShares
                        ? { ...draft, weights: withEntry(draft.weights, member.id, event.target.value) }
                        : { ...draft, exact: withEntry(draft.exact, member.id, event.target.value) },
                    )
                  }
                  aria-invalid={message === undefined ? undefined : true}
                  aria-describedby={message === undefined ? undefined : errorId}
                  data-testid={isShares ? "split-weight" : "split-exact"}
                />
                <FieldError id={errorId} message={message} />
              </li>
            );
          })}
        </ul>

        {draft.mode === "exact" && remaining !== null && <p data-testid="split-remaining">{remaining}</p>}
        <FieldError id={splitErrorId} message={splitError} />
      </fieldset>

      {parts !== null && (
        <ul data-testid="split-preview">
          {members.flatMap((member) => {
            const part = parts.get(member.id);
            if (part === undefined) return [];
            return [
              <li key={member.id} data-testid="split-preview-row">
                {`${member.name}: ${formatAmount(part, currency)} ${currency.code}`}
              </li>,
            ];
          })}
        </ul>
      )}
    </>
  );
}
