// The JSON contract between the API routes and the pages. Amounts are decimal strings formatted to the
// currency's exact number of decimals, so no amount ever passes through a JavaScript number.

export type SplitMode = "equal" | "shares" | "exact";

export type MemberView = { id: string; name: string };

export type ExpensePartView = { memberId: string; amount: string; baseAmount: string };

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

export type GroupView = {
  id: string;
  name: string;
  baseCurrency: string;
  baseDigits: number;
  version: number;
  members: MemberView[];
  balances: { memberId: string; amount: string }[];
  total: string;
  settlement: { transfers: TransferView[]; expenseCount: number };
  expenses: ExpenseView[];
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

export type ApiError = { error: { code: string } };
