import type { CreateGroupRequest } from "./api-types";

export type Person = "Ana" | "Ben" | "Cy" | "Dev";

export type SampleSplit =
  | { readonly mode: "equal"; readonly members: readonly Person[] }
  | { readonly mode: "shares"; readonly parts: readonly { readonly person: Person; readonly weight: number }[] }
  | { readonly mode: "exact"; readonly parts: readonly { readonly person: Person; readonly amount: string }[] };

export type SampleExpense = {
  readonly description: string;
  readonly amount: string;
  readonly currency: string;
  readonly rate: string | null;
  readonly paidBy: Person;
  readonly split: SampleSplit;
};

export const SAMPLE_PEOPLE: readonly Person[] = ["Ana", "Ben", "Cy", "Dev"];

export const SAMPLE_GROUP: CreateGroupRequest = { name: "Lisbon trip", baseCurrency: "EUR", members: [...SAMPLE_PEOPLE] };

// In the order a person would add them. The taxi leaves Dev out the way the form does for a share of 0: the form
// sends only shares above 0, and the server refuses a 0.
export const SAMPLE_EXPENSES: readonly SampleExpense[] = [
  { description: "Flights", amount: "480.00", currency: "EUR", rate: null, paidBy: "Ana", split: { mode: "equal", members: SAMPLE_PEOPLE } },
  { description: "Apartment", amount: "360.00", currency: "EUR", rate: null, paidBy: "Ben", split: { mode: "equal", members: SAMPLE_PEOPLE } },
  {
    description: "Dinner at Taberna",
    amount: "96.50",
    currency: "EUR",
    rate: null,
    paidBy: "Cy",
    split: { mode: "equal", members: ["Ana", "Ben", "Cy"] },
  },
  {
    description: "Museum tickets",
    amount: "54.00",
    currency: "EUR",
    rate: null,
    paidBy: "Dev",
    split: {
      mode: "exact",
      parts: [
        { person: "Ana", amount: "18.00" },
        { person: "Ben", amount: "18.00" },
        { person: "Dev", amount: "18.00" },
      ],
    },
  },
  {
    description: "Taxi from airport",
    amount: "31.20",
    currency: "EUR",
    rate: null,
    paidBy: "Ana",
    split: {
      mode: "shares",
      parts: [
        { person: "Ana", weight: 2 },
        { person: "Ben", weight: 1 },
        { person: "Cy", weight: 1 },
      ],
    },
  },
  { description: "Groceries", amount: "42.75", currency: "EUR", rate: null, paidBy: "Dev", split: { mode: "equal", members: SAMPLE_PEOPLE } },
  {
    description: "Surf lesson",
    amount: "150.00",
    currency: "USD",
    rate: "0.92",
    paidBy: "Cy",
    split: { mode: "equal", members: ["Ana", "Cy"] },
  },
];
