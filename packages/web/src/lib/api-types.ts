// The JSON contract between the API routes and the pages. Amounts are decimal strings formatted to the
// currency's exact number of decimals, so no amount ever passes through a JavaScript number.

export type SplitMode = "equal" | "shares" | "exact";

export type MemberView = {
  id: string;
  name: string;
  /**
   * True only when removing this member is allowed: a balance of exactly zero, named in no expense or payment
   * (deleted ones included), and the group keeps at least two members afterwards.
   */
  removable: boolean;
};

export type ExpensePartView = {
  memberId: string;
  amount: string;
  baseAmount: string;
  /** Splits by shares only: the whole-number share behind this part, so the edit form can show the split as entered. */
  weight?: number;
};

export type ExpenseView = {
  id: string;
  description: string;
  currency: string;
  amount: string;
  rate: string | null;
  baseAmount: string;
  paidBy: string;
  splitMode: SplitMode;
  parts: ExpensePartView[];
  version: number;
  createdAt: string;
};

export type TransferView = { from: string; to: string; amount: string };

export type PaymentView = {
  id: string;
  from: string;
  to: string;
  currency: string;
  amount: string;
  rate: string | null;
  baseAmount: string;
  createdAt: string;
};

export type GroupView = {
  id: string;
  name: string;
  baseCurrency: string;
  baseDigits: number;
  /** True once the group has had any expense or payment, deleted ones included. The base currency is then fixed. */
  baseLocked: boolean;
  version: number;
  members: MemberView[];
  balances: { memberId: string; amount: string }[];
  total: string;
  settlement: { transfers: TransferView[]; expenseCount: number };
  expenses: ExpenseView[];
  /** Live payments, newest first. */
  payments: PaymentView[];
};

export type CreateGroupRequest = { name: string; baseCurrency: string; members: string[] };
export type CreateGroupResponse = { token: string; group: GroupView };

export type SplitRequest =
  | { mode: "equal"; members: string[] }
  | { mode: "shares"; parts: { memberId: string; weight: number }[] }
  | { mode: "exact"; parts: { memberId: string; amount: string }[] };

export type AddExpenseRequest = {
  clientId: string;
  description: string;
  amount: string;
  currency: string;
  rate: string | null;
  paidBy: string;
  split: SplitRequest;
};
export type AddExpenseResponse = { expense: ExpenseView; group: GroupView };

/** The whole expense as it should be after the edit, and the version of it the editor saw. Answered with an AddExpenseResponse. */
export type EditExpenseRequest = {
  version: number;
  description: string;
  amount: string;
  currency: string;
  rate: string | null;
  paidBy: string;
  split: SplitRequest;
};
export type DeleteExpenseResponse = { group: GroupView };

export type AddPaymentRequest = {
  clientId: string;
  from: string;
  to: string;
  amount: string;
  currency: string;
  rate: string | null;
};
export type AddPaymentResponse = { payment: PaymentView; group: GroupView };
export type UndoPaymentResponse = { group: GroupView };

export type AddMemberRequest = { name: string };
export type AddMemberResponse = { member: MemberView; group: GroupView };
export type RemoveMemberResponse = { group: GroupView };

export type ChangeBaseCurrencyRequest = { baseCurrency: string };
export type ChangeBaseCurrencyResponse = { group: GroupView };

/**
 * The header names the group; newToken is the next link token, made and kept by the browser before it sends this, so
 * an answer lost on the way back cannot lose the only copy of the new link.
 */
export type ResetLinkRequest = { newToken: string };
/** The group under its new link. No token comes back: the browser already holds it. */
export type ResetLinkResponse = { group: GroupView };

export type ApiError = { error: { code: string } };
