"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { SampleTripStory, StoryExpense, StoryPayment } from "@/lib/sample-trip-story";
import styles from "./fold.module.css";
import { capitalized, numberWord } from "./number-words";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export type FoldCopy = {
  readonly kicker: string;
  readonly titles: readonly { readonly word: string; readonly rest: string }[];
  readonly captions: readonly string[];
  readonly split: { readonly lineOne: string; readonly lineTwo: string } | null;
  readonly rail: readonly string[];
};

export type BalanceRow = {
  readonly person: string;
  readonly sentence: string;
  readonly cents: number;
  readonly signed: string;
  readonly ratio: number;
};

/** Reads whole cents from an amount string such as "-95.15", digit by digit, so no float is ever involved. */
export function centsOf(amount: string): number {
  const digits = amount.replace(/\D/g, "");
  const value = Number(digits);
  return amount.startsWith("-") ? -value : value;
}

/** Writes whole cents as a signed amount: "+155.74", "-95.15", and a bare "0.00" for nothing. */
export function formatSignedCents(cents: number): string {
  if (cents === 0) return "0.00";
  const size = Math.abs(cents);
  const whole = Math.floor(size / 100);
  const fraction = String(size % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : "+"}${whole}.${fraction}`;
}

export function foldCopy(story: SampleTripStory): FoldCopy {
  const currencies = new Set(story.expenses.map((expense) => expense.currency)).size;
  const currencyWords = currencies === 1 ? "one currency" : `${numberWord(currencies)} currencies`;
  const uneven = story.expenses.find((expense) => expense.parts.some((part) => part.base !== expense.parts[0]?.base));
  return {
    kicker: `${story.groupName} · ${story.people.length} people · ${story.baseCurrency}`.toUpperCase(),
    titles: [
      { word: capitalized(numberWord(story.expenses.length)), rest: "receipts." },
      { word: capitalized(numberWord(story.balances.length)), rest: "balances." },
      { word: capitalized(numberWord(story.payments.length)), rest: "payments." },
    ],
    captions: [
      `Everything the group paid for, in the order it was added, in ${currencyWords}.`,
      "Penny splits each one to the cent, converts it once, and adds up who is owed and who owes.",
      `${story.proof} Everyone ends at exactly 0.00 ${story.baseCurrency}.`,
    ],
    split:
      uneven === undefined
        ? null
        : {
            lineOne:
              `${uneven.description} ${uneven.amount} ${uneven.currency} → ${uneven.parts
                .map((part) => `${part.person} ${part.base}`)
                .join(" · ")}`.toUpperCase(),
            lineTwo: "The leftover cent goes to the first person listed.",
          },
    rail: ["01 Receipts", "02 Balances", "03 Payments"].map((label) => label.toUpperCase()),
  };
}

export function balanceRows(story: SampleTripStory): BalanceRow[] {
  const sizes = story.balances.map((balance) => Math.abs(centsOf(balance.amount)));
  const largest = Math.max(1, ...sizes);
  return story.balances.map((balance) => {
    const cents = centsOf(balance.amount);
    return {
      person: balance.person,
      sentence: balance.sentence,
      cents,
      signed: formatSignedCents(cents),
      ratio: Math.abs(cents) / largest,
    };
  });
}

/** Largest payment first. This is only the order the page draws them in; the plan itself is unchanged. */
export function paymentsLargestFirst(story: SampleTripStory): StoryPayment[] {
  return [...story.payments].sort((a, b) => centsOf(b.amount) - centsOf(a.amount));
}

export function ReceiptCard({ expense, baseCurrency }: { expense: StoryExpense; baseCurrency: string }) {
  return (
    <article className={styles.card}>
      <div className={styles.paper}>
        <p className={styles.desc}>{expense.description}</p>
        <p className={styles.payer}>{`Paid by ${expense.paidBy}`.toUpperCase()}</p>
        <p className={styles.amount}>{`${expense.amount} ${expense.currency}`}</p>
        {expense.rate !== null ? (
          <p className={styles.rate}>{`× ${expense.rate} = ${expense.base} ${baseCurrency}`}</p>
        ) : null}
      </div>
    </article>
  );
}

function Reveal({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className={styles.reveal}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

function ActTitle({ word, rest }: { word: string; rest: string }) {
  return (
    <h3 className={styles.staticTitle}>
      <span className={styles.num}>{word}</span> {rest}
    </h3>
  );
}

function PaymentRow({ payment, baseCurrency }: { payment: StoryPayment; baseCurrency: string }) {
  return (
    <li>
      <Reveal>
        <div className={styles.payRow}>
          <span className={styles.payName}>
            {payment.from}
            <span className={styles.srOnly}> pays </span>
          </span>
          <div className={styles.payMid}>
            <span className={styles.payAmount}>
              {payment.amount}
              <span className={styles.srOnly}>{` ${baseCurrency}, to `}</span>
            </span>
            <motion.div
              className={styles.payLine}
              aria-hidden="true"
              initial="hidden"
              whileInView="shown"
              viewport={{ once: true, amount: 0.3 }}
            >
              <svg className={styles.payLineSvg} viewBox="0 0 100 12" preserveAspectRatio="none">
                <motion.path
                  className={styles.payStroke}
                  d="M0 6 H100"
                  variants={{ hidden: { pathLength: 0 }, shown: { pathLength: 1, transition: { duration: 0.9, ease: EASE_OUT } } }}
                />
              </svg>
              <motion.svg
                className={styles.payArrowSvg}
                viewBox="0 0 9 12"
                variants={{ hidden: { opacity: 0 }, shown: { opacity: 1, transition: { delay: 0.8, duration: 0.2 } } }}
              >
                <path className={styles.payArrow} d="M0 0 L9 6 L0 12 Z" />
              </motion.svg>
            </motion.div>
          </div>
          <span className={styles.payName}>{payment.to}</span>
        </div>
      </Reveal>
    </li>
  );
}

export function FoldStatic({ story }: { story: SampleTripStory }) {
  const copy = foldCopy(story);
  const rows = balanceRows(story);
  const payments = paymentsLargestFirst(story);

  return (
    <section id="how-it-works" aria-labelledby="fold-title" className={styles.staticFold}>
      <h2 id="fold-title" className={styles.srOnly}>
        How Penny settles a trip
      </h2>
      <p className={styles.kicker}>{copy.kicker}</p>

      <div className={styles.staticActs}>
        <div>
          <Reveal>
            <ActTitle {...copy.titles[0]} />
            <p className={styles.staticCaption}>{copy.captions[0]}</p>
          </Reveal>
          <div className={`${styles.staticBody} ${styles.staticCards}`}>
            {story.expenses.map((expense, index) => (
              <Reveal key={expense.id}>
                <div style={{ transform: `rotate(${index % 2 === 0 ? -1.5 : 1.5}deg)` }}>
                  <ReceiptCard expense={expense} baseCurrency={story.baseCurrency} />
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <div>
          <Reveal>
            <ActTitle {...copy.titles[1]} />
            <p className={styles.staticCaption}>{copy.captions[1]}</p>
          </Reveal>
          <div className={styles.staticBody}>
            {copy.split !== null ? (
              <Reveal>
                <div className={`${styles.callout} ${styles.staticCallout}`}>
                  <p>{copy.split.lineOne}</p>
                  <p className={styles.calloutNote}>{copy.split.lineTwo}</p>
                </div>
              </Reveal>
            ) : null}
            <ul className={styles.staticBalances}>
              {rows.map((row) => (
                <li key={row.person}>
                  <Reveal>
                    <div className={styles.staticRow}>
                      <div className={styles.staticRowTop}>
                        <span className={styles.staticName}>{row.person}</span>
                        <span className={styles.staticAmount} aria-hidden="true">
                          {row.signed}
                        </span>
                      </div>
                      <p className={styles.staticSentence}>{row.sentence}</p>
                      <div className={styles.staticTrack} aria-hidden="true">
                        {row.cents === 0 ? null : (
                          <span
                            className={`${styles.staticBar} ${row.cents > 0 ? styles.staticBarUp : styles.staticBarDown}`}
                            style={{ width: `${row.ratio * 50}%` }}
                          />
                        )}
                      </div>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div>
          <Reveal>
            <ActTitle {...copy.titles[2]} />
          </Reveal>
          <div className={styles.staticBody}>
            <ul className={styles.staticPayments}>
              {payments.map((payment) => (
                <PaymentRow key={`${payment.from}-${payment.to}`} payment={payment} baseCurrency={story.baseCurrency} />
              ))}
            </ul>
            <Reveal>
              <p className={styles.staticProof}>{copy.captions[2]}</p>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
