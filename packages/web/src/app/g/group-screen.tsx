"use client";

import { listCurrencies } from "@penny/core";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { FieldError } from "@/components/field-error";
import type { ExpenseView, GroupView, TransferView } from "@/lib/api-types";
import {
  addMember,
  addPayment,
  changeBaseCurrency,
  deleteExpense,
  getGroup,
  removeMember,
  resetLink,
  undoPayment,
  type ApiResult,
} from "@/lib/client/api";
import { FALLBACK_MESSAGE, cleanText, messageFor } from "@/lib/client/messages";
import { ExpenseForm } from "./expense-form";

// The format lib/group-token.ts checks on the server, repeated here because that module needs node:crypto.
// A fragment that fails it never leaves the browser.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{22}$/;
const COPIED_FOR_MS = 2000;
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

// Balances arrive as exact decimal strings such as "-12.00". Reading the sign and the digits as text keeps every
// amount out of a binary float.
function balanceLine(name: string, amount: string, base: string): string {
  if (!/[1-9]/.test(amount)) return `${name} is settled up`;
  if (amount.startsWith("-")) return `${name} owes ${amount.slice(1)} ${base}`;
  return `${name} is owed ${amount} ${base}`;
}

function proofLine(payments: number, expenses: number): string {
  const paymentWords = payments === 1 ? "1 payment" : `${payments} payments`;
  const expenseWords = expenses === 1 ? "1 expense" : `${expenses} expenses`;
  return `${paymentWords} ${payments === 1 ? "settles" : "settle"} ${expenseWords}.`;
}

// The same line on the same group version always gives the same clientId, so a double press, a retry after a lost
// answer, or two people pressing one line at once records one payment. The server moves the version with every new
// payment, so a key is never shown again once its payment exists. Hex SHA-256 is 64 characters, the API's maximum.
async function settleClientId(version: number, transfer: TransferView): Promise<string> {
  const text = `settle:${version}:${transfer.from}:${transfer.to}:${transfer.amount}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    <section data-testid="not-found">
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
  onLinkReset,
}: {
  readonly token: string;
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
    const result = await resetLink(token);
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

  if (group.baseLocked) return <p data-testid="base-locked">Base currency is fixed once money is recorded.</p>;
  return (
    <div className="field">
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
    // The server judges length and duplicates with the same rules as group creation, so the browser does not guess.
    if (await run(() => addMember(token, { name: cleaned }))) setName("");
  }

  async function remove(memberId: string) {
    if (await run(() => removeMember(token, memberId))) onRemoved(memberId);
  }

  return (
    <section>
      <h2>Members</h2>
      <ul>
        {group.members.map((member) => (
          <li key={member.id} data-testid="member-row">
            {member.name}
            {member.removable && (
              <>
                {" "}
                <button
                  type="button"
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
      <form onSubmit={add}>
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
    paymentInFlight.current = false;
    setPaymentPending(false);
    if (result.ok) onSaved(result.data.group);
    else setPaymentError(messageFor(result.error));
  }

  function markPaid(transfer: TransferView) {
    void runPaymentAction(async () =>
      addPayment(token, {
        clientId: await settleClientId(group.version, transfer),
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
    <>
      <header>
        <h1 data-testid="group-title">{group.name}</h1>
        <p data-testid="group-base-label">{`Balances in ${base}`}</p>
        <div>
          <CopyLinkButton link={link} testId="copy-link" /> <ResetLinkButton token={token} onLinkReset={onLinkReset} />
        </div>
      </header>

      <BaseCurrencyPicker token={token} group={group} onSaved={onSaved} />

      {created && !linkReset && (
        <section data-testid="created-banner">
          <label htmlFor={linkId}>Group created. Share this link with your group:</label>
          <input id={linkId} className="link" type="text" readOnly value={link} />
          <div>
            <CopyLinkButton link={link} />
          </div>
        </section>
      )}

      {linkReset && (
        <section data-testid="new-link-banner">
          <label htmlFor={newLinkId}>New link made. The old link no longer works. Share this one:</label>
          <input id={newLinkId} className="link" type="text" readOnly value={link} />
          <div>
            <CopyLinkButton link={link} />
          </div>
        </section>
      )}

      <div className="field">
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

      <section>
        <h2>Balances</h2>
        <ul>
          {group.balances.map((balance) => {
            const name = names.get(balance.memberId);
            if (name === undefined) return null;
            return (
              <li key={balance.memberId} data-testid="balance-row" data-member={name}>
                {balanceLine(name, balance.amount, base)}
              </li>
            );
          })}
        </ul>
        <p data-testid="balances-total">{`Total: ${group.total} ${base}`}</p>
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

      <section>
        <h2>Settle up</h2>
        {transfers.length === 0 ? (
          <p data-testid="settled-message">Everyone is settled up.</p>
        ) : (
          <>
            <ul>
              {transfers.map((transfer, index) => (
                <li key={`${index}:${transfer.from}:${transfer.to}`} data-testid="settle-line">
                  {`${names.get(transfer.from) ?? ""} pays ${names.get(transfer.to) ?? ""} ${transfer.amount} ${base}`}{" "}
                  <button
                    type="button"
                    disabled={paymentPending}
                    onClick={() => markPaid(transfer)}
                    data-testid="settle-mark-paid"
                  >
                    Mark as paid
                  </button>
                </li>
              ))}
            </ul>
            <p data-testid="settle-proof">{proofLine(transfers.length, group.settlement.expenseCount)}</p>
          </>
        )}
        <FieldError id={paymentErrorId} message={paymentError} />
      </section>

      <section>
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

      <section>
        <h2>Expenses</h2>
        {group.expenses.length === 0 ? (
          <p>No expenses yet.</p>
        ) : (
          <ul>
            {group.expenses.map((expense) => (
              <li key={expense.id} data-testid="expense-row">
                <div>
                  <span>{expense.description}</span> <span>{`${expense.amount} ${expense.currency}`}</span>{" "}
                  <span>{`paid by ${names.get(expense.paidBy) ?? ""}`}</span>
                </div>
                {expense.currency !== base && expense.rate !== null && (
                  <div>{`= ${expense.baseAmount} ${base} at ${expense.rate}`}</div>
                )}
                <div className="inline">
                  {confirmingDelete === expense.id ? (
                    <>
                      <span>Delete this expense?</span>
                      <button
                        type="button"
                        disabled={deletePending}
                        onClick={() => void confirmDelete(expense)}
                        data-testid="expense-delete-confirm"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        disabled={deletePending}
                        onClick={() => setConfirmingDelete(null)}
                        data-testid="expense-delete-cancel"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => startEdit(expense)} data-testid="expense-edit">
                        Edit
                      </button>
                      <button type="button" onClick={() => askDelete(expense.id)} data-testid="expense-delete">
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

      <section>
        <h2>Payments</h2>
        {group.payments.length === 0 ? (
          <p>No payments yet.</p>
        ) : (
          <ul>
            {group.payments.map((payment) => (
              <li key={payment.id} data-testid="payment-row">
                {`${names.get(payment.from) ?? ""} paid ${names.get(payment.to) ?? ""} ${payment.baseAmount} ${base}`}{" "}
                <button
                  type="button"
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
    </>
  );
}

/**
 * The group page. The link token is read from the address fragment and sent only in the x-penny-group header;
 * it is never rendered, logged, stored or used as a React key. A new fragment loads the group it names.
 */
export function GroupScreen() {
  const token = useSyncExternalStore<string | null | undefined>(subscribeToHash, tokenFromHash, tokenOnServer);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The token a reset just put in the address. Its group is already on screen, and loading it again would drop the
  // new-link banner.
  const adopted = useRef<string | null>(null);

  useEffect(() => {
    if (typeof token !== "string") return;
    if (adopted.current === token) {
      adopted.current = null;
      return;
    }
    const controller = new AbortController();
    const created = createdFlagIsSet();
    void getGroup(token, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        // Cleared only once the group is on screen: in development React runs this effect twice and drops the first run.
        if (created) clearCreatedFlag();
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
        setLoaded({ token, status: "not_found" });
      } else {
        setLoaded({ token, status: "failed" });
      }
    });
    return () => controller.abort();
  }, [token]);

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

  function linkWasReset(newToken: string, group: GroupView) {
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
  }

  if (token === undefined) return <p>Loading the group...</p>;
  if (token === null) return <LinkNotFound />;
  if (loaded === null || loaded.token !== token) return <p>Loading the group...</p>;
  if (loaded.status === "not_found") return <LinkNotFound />;
  if (loaded.status === "failed") return <p className="error">{FALLBACK_MESSAGE}</p>;
  return <GroupBoard ready={loaded} onYouChange={changeYou} onSaved={saved} onLinkReset={linkWasReset} />;
}
