"use client";

import Link from "next/link";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { GroupView } from "@/lib/api-types";
import { getGroup } from "@/lib/client/api";
import { FALLBACK_MESSAGE } from "@/lib/client/messages";
import { ExpenseForm } from "./expense-form";

// The format lib/group-token.ts checks on the server, repeated here because that module needs node:crypto.
// A fragment that fails it never leaves the browser.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{22}$/;
const COPIED_FOR_MS = 2000;

type Ready = {
  readonly token: string;
  readonly status: "ready";
  readonly group: GroupView;
  readonly link: string;
  readonly created: boolean;
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

type GroupBoardProps = {
  readonly ready: Ready;
  readonly onYouChange: (memberId: string) => void;
  readonly onSaved: (group: GroupView) => void;
};

function GroupBoard({ ready, onYouChange, onSaved }: GroupBoardProps) {
  const { token, group, link, created, you } = ready;
  const youId = useId();
  const linkId = useId();
  const base = group.baseCurrency;
  const names = new Map(group.members.map((member) => [member.id, member.name]));
  const transfers = group.settlement.transfers;

  return (
    <>
      <header>
        <h1 data-testid="group-title">{group.name}</h1>
        <p data-testid="group-base-label">{`Balances in ${base}`}</p>
        <div>
          <CopyLinkButton link={link} testId="copy-link" />
        </div>
      </header>

      {created && (
        <section data-testid="created-banner">
          <label htmlFor={linkId}>Group created. Share this link with your group:</label>
          <input id={linkId} className="link" type="text" readOnly value={link} />
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

      <section>
        <h2>Settle up</h2>
        {transfers.length === 0 ? (
          <p data-testid="settled-message">Everyone is settled up.</p>
        ) : (
          <>
            <ul>
              {transfers.map((transfer, index) => (
                <li key={`${index}:${transfer.from}:${transfer.to}`} data-testid="settle-line">
                  {`${names.get(transfer.from) ?? ""} pays ${names.get(transfer.to) ?? ""} ${transfer.amount} ${base}`}
                </li>
              ))}
            </ul>
            <p data-testid="settle-proof">{proofLine(transfers.length, group.settlement.expenseCount)}</p>
          </>
        )}
      </section>

      <section>
        <h2>Add an expense</h2>
        <ExpenseForm key={group.id} token={token} group={group} you={you} onSaved={onSaved} />
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

  useEffect(() => {
    if (typeof token !== "string") return;
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

  if (token === undefined) return <p>Loading the group...</p>;
  if (token === null) return <LinkNotFound />;
  if (loaded === null || loaded.token !== token) return <p>Loading the group...</p>;
  if (loaded.status === "not_found") return <LinkNotFound />;
  if (loaded.status === "failed") return <p className="error">{FALLBACK_MESSAGE}</p>;
  return <GroupBoard ready={loaded} onYouChange={changeYou} onSaved={saved} />;
}
