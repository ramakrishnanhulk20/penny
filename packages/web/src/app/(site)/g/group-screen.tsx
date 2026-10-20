"use client";

import { listCurrencies } from "@penny/core";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { FieldError } from "@/components/field-error";
import type { ExpenseView, GroupView, TransferView } from "@/lib/api-types";
import {
  addMember,
  addPayment,
  changeBaseCurrency,
  deleteExpense,
  getGroup,
  newLinkToken,
  removeMember,
  resetLink,
  settleClientId,
  undoPayment,
  type ApiResult,
} from "@/lib/client/api";
import {
  ALREADY_CHANGED_MESSAGE,
  FALLBACK_MESSAGE,
  MEMBER_NAME_MAX,
  cleanText,
  isStaleAnswer,
  messageFor,
  textProblem,
} from "@/lib/client/messages";
import { balanceLine, proofLine } from "@/lib/settle-words";
import { ExpenseForm } from "./expense-form";

// The format lib/group-token.ts checks on the server, repeated here because that module needs node:crypto.
// A fragment that fails it never leaves the browser.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{22}$/;
const COPIED_FOR_MS = 2000;
const RESET_TIMEOUT_MS = 10_000;
const PENDING_RESET_PREFIX = "penny:pending-reset:";
// Each kept link costs one group read when the address's link opens nothing, so only this many keys are looked at.
const PENDING_RESETS_TRIED = 5;
const CURRENCY_CODES = listCurrencies().map((cur) => cur.code);

type Ready = {
  readonly token: string;
  readonly status: "ready";
  readonly group: GroupView;
  readonly link: string;
  readonly created: boolean;
  /** True once this page made a new link, so it shows that link in place of the created banner. */
  readonly linkReset: boolean;
  readonly you: string;
};

type Loaded =
  | Ready
  | { readonly token: string; readonly status: "not_found" }
  | { readonly token: string; readonly status: "failed" };

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function tokenFromHash(): string | null {
  const raw = window.location.hash.replace(/^#/, "");
  return TOKEN_FORMAT.test(raw) ? raw : null;
}

// The server never receives the fragment, so while it prerenders this page the token is unknown, not missing.
function tokenOnServer(): undefined {
  return undefined;
}

function createdFlagIsSet(): boolean {
  try {
    return window.sessionStorage.getItem("penny:created") === "1";
  } catch {
    return false;
  }
}

function clearCreatedFlag(): void {
  try {
    window.sessionStorage.removeItem("penny:created");
  } catch {
    // Storage is switched off, so there is no flag to clear.
  }
}

// Keyed by the group's id, never its link token, so the secret never sits in storage.
function readYou(group: GroupView): string {
  try {
    const stored = window.localStorage.getItem(`penny:you:${group.id}`);
    return group.members.find((member) => member.id === stored)?.id ?? "";
  } catch {
    return "";
  }
}

function saveYou(groupId: string, memberId: string): void {
  try {
    if (memberId === "") window.localStorage.removeItem(`penny:you:${groupId}`);
    else window.localStorage.setItem(`penny:you:${groupId}`, memberId);
  } catch {
    // The choice is a convenience on this device only, so losing it does no harm.
  }
}

// The one link token that sits in storage, and only in this tab's session storage until its reset is confirmed: kept
// before the reset is sent, so an answer lost on the way back cannot lose the only copy of the new link (C38).
function keepPendingReset(groupId: string, newToken: string): void {
  try {
    window.sessionStorage.setItem(`${PENDING_RESET_PREFIX}${groupId}`, newToken);
  } catch {
    // Storage is switched off. This attempt still holds the token in memory through its retry and its check.
  }
}

// Read back as untrusted: anything not in the link format counts as nothing kept.
function readPendingReset(groupId: string): string | null {
  try {
    const kept = window.sessionStorage.getItem(`${PENDING_RESET_PREFIX}${groupId}`);
    return kept !== null && TOKEN_FORMAT.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

function clearPendingReset(groupId: string): void {
  try {
    window.sessionStorage.removeItem(`${PENDING_RESET_PREFIX}${groupId}`);
  } catch {
    // Storage is switched off, so nothing was kept.
  }
}

type PendingReset = { readonly groupId: string; readonly token: string };

function pendingResets(): PendingReset[] {
  const found: PendingReset[] = [];
  try {
    const storage = window.sessionStorage;
    let seen = 0;
    for (let index = 0; index < storage.length && seen < PENDING_RESETS_TRIED; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(PENDING_RESET_PREFIX)) continue;
      seen += 1;
      const groupId = key.slice(PENDING_RESET_PREFIX.length);
      const token = readPendingReset(groupId);
      if (token !== null) found.push({ groupId, token });
    }
  } catch {
    // Storage is switched off, so nothing was kept.
  }
  return found;
}

// Aborts when `signal` does or after `ms`, whichever comes first. The built-in that merges signals reached browsers
// only in 2023 and 2024 (Safari 17.4), and where it is missing the call throws, which left the page loading for good.
function abortedByEither(signal: AbortSignal, ms: number): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/**
 * A reset whose every answer was lost may still have landed, leaving its new link only in this tab's session storage
 * (C38). When the address's link opens nothing, each kept link is tried, and the first that opens the group it was
 * kept for is that group's link now. Null when none does, or when `signal` aborts.
 */
export async function openPendingReset(
  signal: AbortSignal,
): Promise<(PendingReset & { readonly group: GroupView }) | null> {
  for (const pending of pendingResets()) {
    const opened = await getGroup(pending.token, abortedByEither(signal, RESET_TIMEOUT_MS));
    if (signal.aborted) return null;
    if (opened.ok && opened.data.id === pending.groupId) return { ...pending, group: opened.data };
  }
  return null;
}

// The reset is sent, and sent once more if it fails or times out. If that fails too, the reset may still have landed
// with its answer lost, so the new token itself is tried: when it opens this group, it is the group's link now.
// A later press sends the token an earlier one kept: if that reset landed unseen, the server answers the dead link only
// for that token, and a fresh one would be refused. A kept token that is already the page's link is not pending.
async function makeNewLink(
  token: string,
  groupId: string,
): Promise<ApiResult<{ readonly token: string; readonly group: GroupView }>> {
  const kept = readPendingReset(groupId);
  const newToken = kept !== null && kept !== token ? kept : newLinkToken();
  keepPendingReset(groupId, newToken);
  let sent = await resetLink(token, newToken, AbortSignal.timeout(RESET_TIMEOUT_MS));
  if (!sent.ok) sent = await resetLink(token, newToken, AbortSignal.timeout(RESET_TIMEOUT_MS));
  if (sent.ok) {
    clearPendingReset(groupId);
    return { ok: true, data: { token: newToken, group: sent.data.group } };
  }
  const opened = await getGroup(newToken, AbortSignal.timeout(RESET_TIMEOUT_MS));
  if (opened.ok && opened.data.id === groupId) {
    clearPendingReset(groupId);
    return { ok: true, data: { token: newToken, group: opened.data } };
  }
  return sent;
}

function CopyLinkButton({ link, testId }: { readonly link: string; readonly testId?: string }) {
  const [copies, setCopies] = useState(0);

  useEffect(() => {
    if (copies === 0) return;
    const timer = window.setTimeout(() => setCopies(0), COPIED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [copies]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // The browser refused the clipboard. Saying "Link copied" anyway would be untrue, so nothing changes.
      return;
    }
    setCopies((count) => count + 1);
  }

  return (
    <>
      <button type="button" onClick={copy} data-testid={testId}>
        Copy link
      </button>{" "}
      <span role="status">{copies > 0 ? "Link copied" : ""}</span>
    </>
  );
}

function LinkNotFound() {
  return (
    <section data-testid="not-found" className="card notfound">
      <p>{"This link doesn't open a group. It may have been reset. Ask the group for the current link."}</p>
      <div>
        <Link href="/new" className="button">
          Start a group
        </Link>
      </div>
    </section>
  );
}

function ResetLinkButton({
  token,
  groupId,
  onLinkReset,
}: {
  readonly token: string;
  readonly groupId: string;
  readonly onLinkReset: (token: string, group: GroupView) => void;
}) {
  const errorId = useId();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // A second press can land before React re-renders the disabled button, and a second reset would kill the first
  // new link, so the guard lives outside render.
  const inFlight = useRef(false);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    let result: ApiResult<{ readonly token: string; readonly group: GroupView }>;
    try {
      result = await makeNewLink(token, groupId);
    } catch {
      // The API calls never throw, so this is the browser refusing to make the token, before any request left.
      result = { ok: false, error: "internal" };
    }
    inFlight.current = false;
    setPending(false);
    setConfirming(false);
    if (result.ok) onLinkReset(result.data.token, result.data.group);
    else setError(messageFor(result.error));
  }

  return (
    <>
      {confirming ? (
        <>
          <span>Make a new link? The old link will stop working for everyone.</span>{" "}
          <button type="button" disabled={pending} onClick={() => void confirm()} data-testid="reset-link-confirm">
            Make new link
          </button>{" "}
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
            data-testid="reset-link-cancel"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
            setError(undefined);
          }}
          data-testid="reset-link"
        >
          Reset link
        </button>
      )}
      <FieldError id={errorId} message={error} />
    </>
  );
}

function BaseCurrencyPicker({
  token,
  group,
  onSaved,
}: {
  readonly token: string;
  readonly group: GroupView;
  readonly onSaved: (group: GroupView) => void;
}) {
  const selectId = useId();
  const errorId = useId();
  const [choice, setChoice] = useState(group.baseCurrency);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);

  async function change() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    const result = await changeBaseCurrency(token, { baseCurrency: choice });
    inFlight.current = false;
    setPending(false);
    if (result.ok) onSaved(result.data.group);
    else setError(messageFor(result.error));
  }

  if (group.baseLocked) {
    return (
      <p data-testid="base-locked" className="base-locked">
        Base currency is fixed once money is recorded.
      </p>
    );
  }
  return (
    <div className="field card">
      <label htmlFor={selectId}>Base currency</label>
      <div className="inline">
        <select
          id={selectId}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          data-testid="base-currency"
        >
          {CURRENCY_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <button type="button" disabled={pending} onClick={() => void change()} data-testid="base-currency-change">
          Change
        </button>
      </div>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function MembersSection({
  token,
  group,
  onSaved,
  onRemoved,
}: {
  readonly token: string;
  readonly group: GroupView;
  readonly onSaved: (group: GroupView) => void;
  readonly onRemoved: (memberId: string) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // One member change at a time, so two answers arriving out of order cannot put an older group back on screen.
  const inFlight = useRef(false);

  async function run(action: () => Promise<ApiResult<{ readonly group: GroupView }>>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    const result = await action();
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setError(messageFor(result.error));
      return false;
    }
    onSaved(result.data.group);
    return true;
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleaned = cleanText(name);
    if (cleaned === "") return;
    // The server's own name rule runs here first, so a hidden character is named before any request; the server
    // still judges duplicates.
    if (textProblem(name, MEMBER_NAME_MAX) !== null) {
      setError(messageFor("bad_member_name", { memberName: name }));
      return;
    }
    if (await run(() => addMember(token, { name: cleaned }))) setName("");
  }

  async function remove(memberId: string) {
    if (await run(() => removeMember(token, memberId))) onRemoved(memberId);
  }

  return (
    <section className="card">
      <h2>Members</h2>
      <ul className="chips">
        {group.members.map((member) => (
          <li key={member.id} data-testid="member-row">
            {member.name}
            {member.removable && (
              <>
                {" "}
                <button
                  type="button"
                  className="btn-sm"
                  disabled={pending}
                  onClick={() => void remove(member.id)}
                  data-testid="member-remove"
                >
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="member-add">
        <div className="field">
          <label htmlFor={inputId}>New member</label>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? undefined : errorId}
            data-testid="member-new"
          />
          <FieldError id={errorId} message={error} />
        </div>
        <div>
          <button type="submit" disabled={pending || cleanText(name) === ""} data-testid="member-add">
            Add member
          </button>
        </div>
      </form>
    </section>
  );
}

type GroupBoardProps = {
  readonly ready: Ready;
  readonly onYouChange: (memberId: string) => void;
  readonly onSaved: (group: GroupView) => void;
  readonly onLinkReset: (token: string, group: GroupView) => void;
};

function GroupBoard({ ready, onYouChange, onSaved, onLinkReset }: GroupBoardProps) {
  const { token, group, link, created, linkReset, you } = ready;
  const youId = useId();
  const linkId = useId();
  const newLinkId = useId();
  const paymentErrorId = useId();
  const [paymentPending, setPaymentPending] = useState(false);
  const [paymentError, setPaymentError] = useState<string | undefined>(undefined);
  // A second press can land before React re-renders the disabled buttons, so the guard lives outside render.
  const paymentInFlight = useRef(false);
  // The expense in the form, as it was shown when "Edit" was pressed. Its version is the one the save sends.
  const [editing, setEditing] = useState<ExpenseView | null>(null);
  // Part of the form's key: every Edit, Cancel and saved edit mounts a fresh form, filled or empty.
  const [formRound, setFormRound] = useState(0);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const deleteInFlight = useRef(false);
  const [rowError, setRowError] = useState<{ readonly expenseId: string; readonly message: string } | null>(null);
  const rowErrorId = useId();
  const base = group.baseCurrency;
  const names = new Map(group.members.map((member) => [member.id, member.name]));
  const transfers = group.settlement.transfers;
  // The form starts its currency on the base, so a new base mounts a new form.
  const formKey = `${group.id}:${base}:${formRound}`;

  // One payment action at a time: every settle-up line belongs to the plan on screen and paying one can change the
  // others, and two answers arriving out of order could put an older group back on screen.
  async function runPaymentAction(action: () => Promise<ApiResult<{ readonly group: GroupView }>>) {
    if (paymentInFlight.current) return;
    paymentInFlight.current = true;
    setPaymentPending(true);
    setPaymentError(undefined);
    let result: ApiResult<{ readonly group: GroupView }>;
    try {
      result = await action();
    } catch {
      // The API calls never throw, so this is hashing the clientId failing (crypto.subtle needs a secure context),
      // before any request left.
      result = { ok: false, error: "internal" };
    }
    // Someone else paid, undid or changed this first. Loaded while the buttons stay disabled, so no press lands on the
    // old plan in between.
    let latest: ApiResult<GroupView> | null = null;
    if (!result.ok && isStaleAnswer(result.error)) latest = await getGroup(token);
    paymentInFlight.current = false;
    setPaymentPending(false);
    if (result.ok) {
      onSaved(result.data.group);
    } else if (latest !== null && latest.ok && latest.data.id === group.id) {
      onSaved(latest.data);
      setPaymentError(ALREADY_CHANGED_MESSAGE);
    } else {
      setPaymentError(messageFor(result.error));
    }
  }

  // The server moves the version with every write that can change the plan, so a line's key is never shown again once
  // its payment exists, and a press on a plan another phone has already changed comes back stale_version.
  function markPaid(transfer: TransferView) {
    void runPaymentAction(async () =>
      addPayment(token, {
        clientId: await settleClientId(group.version, transfer),
        planVersion: group.version,
        from: transfer.from,
        to: transfer.to,
        amount: transfer.amount,
        currency: base,
        rate: null,
      }),
    );
  }

  function undo(paymentId: string) {
    void runPaymentAction(() => undoPayment(token, paymentId));
  }

  function startEdit(expense: ExpenseView) {
    setEditing(expense);
    setFormRound((round) => round + 1);
    setConfirmingDelete(null);
    setRowError(null);
  }

  function leaveEdit() {
    setEditing(null);
    setFormRound((round) => round + 1);
  }

  function askDelete(expenseId: string) {
    setConfirmingDelete(expenseId);
    setRowError(null);
  }

  // Sends the version this row shows, so a delete never removes an expense someone has changed since.
  async function confirmDelete(expense: ExpenseView) {
    if (deleteInFlight.current) return;
    deleteInFlight.current = true;
    setDeletePending(true);
    setRowError(null);
    const result = await deleteExpense(token, expense.id, expense.version);
    deleteInFlight.current = false;
    setDeletePending(false);
    setConfirmingDelete(null);
    if (!result.ok) {
      setRowError({ expenseId: expense.id, message: messageFor(result.error) });
      return;
    }
    // A form still holding the deleted expense could only ever save into a 404.
    if (editing?.id === expense.id) leaveEdit();
    onSaved(result.data.group);
  }

  return (
    <div className="board">
      <header className="board-head">
        <h1 data-testid="group-title">{group.name}</h1>
        <p data-testid="group-base-label">{`Balances in ${base}`}</p>
        <div>
          <CopyLinkButton link={link} testId="copy-link" />{" "}
          <ResetLinkButton token={token} groupId={group.id} onLinkReset={onLinkReset} />
        </div>
      </header>

      {created && !linkReset && (
        <section data-testid="created-banner" className="banner">
          <label htmlFor={linkId}>Group created. Share this link with your group:</label>
          <input id={linkId} className="link" type="text" readOnly value={link} />
          <div>
            <CopyLinkButton link={link} />
          </div>
        </section>
      )}

      {linkReset && (
        <section data-testid="new-link-banner" className="banner">
          <label htmlFor={newLinkId}>New link made. The old link no longer works. Share this one:</label>
          <input id={newLinkId} className="link" type="text" readOnly value={link} />
          <div>
            <CopyLinkButton link={link} />
          </div>
        </section>
      )}

      <div className="col col-money">
        <div className="field card you-card">
          <label htmlFor={youId}>You are:</label>
          <select id={youId} value={you} onChange={(event) => onYouChange(event.target.value)} data-testid="you-are">
            <option value="">Choose your name</option>
            {group.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </div>

        <section className="card">
          <h2>Balances</h2>
          <ul>
            {group.balances.map((balance) => {
              const name = names.get(balance.memberId);
              if (name === undefined) return null;
              const sign = !/[1-9]/.test(balance.amount) ? "settled" : balance.amount.startsWith("-") ? "owes" : "owed";
              return (
                <li key={balance.memberId} data-testid="balance-row" data-member={name} data-sign={sign}>
                  {balanceLine(name, balance.amount, base)}
                </li>
              );
            })}
          </ul>
          <p data-testid="balances-total" className="total">{`Total: ${group.total} ${base}`}</p>
        </section>

        <section className="card settle">
          <h2>Settle up</h2>
          {transfers.length === 0 ? (
            <p data-testid="settled-message" className="settled-message">
              Everyone is settled up.
            </p>
          ) : (
            <>
              <ul>
                {transfers.map((transfer, index) => (
                  <li key={`${index}:${transfer.from}:${transfer.to}`} data-testid="settle-line">
                    {`${names.get(transfer.from) ?? ""} pays ${names.get(transfer.to) ?? ""} ${transfer.amount} ${base}`}{" "}
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={paymentPending}
                      onClick={() => markPaid(transfer)}
                      data-testid="settle-mark-paid"
                    >
                      Mark as paid
                    </button>
                  </li>
                ))}
              </ul>
              <p data-testid="settle-proof" className="proof">
                {proofLine(transfers.length, group.settlement.expenseCount)}
              </p>
            </>
          )}
          <FieldError id={paymentErrorId} message={paymentError} />
        </section>

        <MembersSection
          token={token}
          group={group}
          onSaved={onSaved}
          onRemoved={(memberId) => {
            // The device would otherwise keep pre-selecting someone who is no longer in the group.
            if (you === memberId) onYouChange("");
          }}
        />

        <BaseCurrencyPicker token={token} group={group} onSaved={onSaved} />
      </div>

      <div className="col col-ledger">
        <section className="card expense-card">
          <h2>{editing === null ? "Add an expense" : "Edit expense"}</h2>
          <ExpenseForm
            key={formKey}
            token={token}
            group={group}
            you={you}
            editing={editing}
            onSaved={onSaved}
            onEditDone={leaveEdit}
          />
        </section>

        <section className="card">
          <h2>Expenses</h2>
          {group.expenses.length === 0 ? (
            <p className="empty">No expenses yet.</p>
          ) : (
            <ul>
              {group.expenses.map((expense) => (
                <li key={expense.id} data-testid="expense-row">
                  <div className="exp-details">
                    <span>{expense.description}</span> <span>{`${expense.amount} ${expense.currency}`}</span>{" "}
                    <span>{`paid by ${names.get(expense.paidBy) ?? ""}`}</span>
                  </div>
                  {expense.currency !== base && expense.rate !== null && (
                    <div className="exp-base">{`= ${expense.baseAmount} ${base} at ${expense.rate}`}</div>
                  )}
                  <div className="inline exp-actions">
                    {confirmingDelete === expense.id ? (
                      <>
                        <span>Delete this expense?</span>
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={deletePending}
                          onClick={() => void confirmDelete(expense)}
                          data-testid="expense-delete-confirm"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={deletePending}
                          onClick={() => setConfirmingDelete(null)}
                          data-testid="expense-delete-cancel"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => startEdit(expense)}
                          data-testid="expense-edit"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => askDelete(expense.id)}
                          data-testid="expense-delete"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                  {rowError?.expenseId === expense.id && <FieldError id={rowErrorId} message={rowError.message} />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Payments</h2>
          {group.payments.length === 0 ? (
            <p className="empty">No payments yet.</p>
          ) : (
            <ul>
              {group.payments.map((payment) => (
                <li key={payment.id} data-testid="payment-row">
                  {`${names.get(payment.from) ?? ""} paid ${names.get(payment.to) ?? ""} ${payment.baseAmount} ${base}`}{" "}
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={paymentPending}
                    onClick={() => undo(payment.id)}
                    data-testid="payment-undo"
                  >
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The group page. The link token is read from the address fragment and sent only in the x-penny-group header;
 * it is never logged or used as a React key, and the only token ever stored is a reset's next one, in this tab's
 * session storage until that reset is confirmed. A new fragment loads the group it names. When it opens nothing, the
 * links this tab kept for unconfirmed resets are tried before the not-found page, and one that opens its group is
 * shown as that group's new link.
 */
export function GroupScreen() {
  const token = useSyncExternalStore<string | null | undefined>(subscribeToHash, tokenFromHash, tokenOnServer);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The token a reset just put in the address. Its group is already on screen, and loading it again would drop the
  // new-link banner.
  const adopted = useRef<string | null>(null);

  // Stable, so the load effect below can adopt a kept link without running again on every render.
  const linkWasReset = useCallback((newToken: string, group: GroupView) => {
    // replaceState swaps the address without a hashchange or a new history entry, so Back never offers the dead link.
    window.history.replaceState(null, "", "/g#" + newToken);
    adopted.current = newToken;
    setLoaded({
      token: newToken,
      status: "ready",
      group,
      link: `${window.location.origin}/g#${newToken}`,
      created: false,
      linkReset: true,
      you: readYou(group),
    });
  }, []);

  useEffect(() => {
    if (typeof token !== "string") return;
    if (adopted.current === token) {
      adopted.current = null;
      return;
    }
    const controller = new AbortController();
    const created = createdFlagIsSet();
    void getGroup(token, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        // Cleared only once the group is on screen: in development React runs this effect twice and drops the first run.
        if (created) clearCreatedFlag();
        // The kept link has opened its own group, so its reset is no longer pending.
        if (readPendingReset(result.data.id) === token) clearPendingReset(result.data.id);
        setLoaded({
          token,
          status: "ready",
          group: result.data,
          link: `${window.location.origin}/g#${token}`,
          created,
          linkReset: false,
          you: readYou(result.data),
        });
      } else if (result.error === "not_found") {
        // Whatever goes wrong while the kept links are tried, the address's link still opens nothing, so the page says
        // so instead of waiting on an answer that will never come.
        const recovered = await openPendingReset(controller.signal).catch(() => null);
        if (controller.signal.aborted) return;
        if (recovered === null) {
          setLoaded({ token, status: "not_found" });
        } else {
          clearPendingReset(recovered.groupId);
          linkWasReset(recovered.token, recovered.group);
        }
      } else {
        setLoaded({ token, status: "failed" });
      }
    });
    return () => controller.abort();
  }, [token, linkWasReset]);

  function changeYou(memberId: string) {
    if (loaded === null || loaded.status !== "ready") return;
    const groupId = loaded.group.id;
    saveYou(groupId, memberId);
    setLoaded((current) =>
      current !== null && current.status === "ready" && current.group.id === groupId
        ? { ...current, you: memberId }
        : current,
    );
  }

  function saved(group: GroupView) {
    setLoaded((current) =>
      current !== null && current.status === "ready" && current.group.id === group.id ? { ...current, group } : current,
    );
  }

  if (token === undefined) return <p className="status-line">Loading the group...</p>;
  if (token === null) return <LinkNotFound />;
  if (loaded === null || loaded.token !== token) return <p className="status-line">Loading the group...</p>;
  if (loaded.status === "not_found") return <LinkNotFound />;
  if (loaded.status === "failed") return <p className="error status-line">{FALLBACK_MESSAGE}</p>;
  return <GroupBoard ready={loaded} onYouChange={changeYou} onSaved={saved} onLinkReset={linkWasReset} />;
}
