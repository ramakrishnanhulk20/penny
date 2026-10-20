"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SampleTripStory } from "@/lib/sample-trip-story";
import {
  type BalanceRow,
  balanceRows,
  centsOf,
  foldCopy,
  FoldStatic,
  formatSignedCents,
  paymentsLargestFirst,
  ReceiptCard,
} from "./fold-static";
import styles from "./fold.module.css";

gsap.registerPlugin(ScrollTrigger);

const PINNED_QUERY = "(min-width: 900px) and (min-height: 620px)";
const CALM_QUERY = "(prefers-reduced-motion: reduce)";

const SLOTS = [
  { left: 4, top: 6, rotate: -6 },
  { left: 40, top: 2, rotate: 4 },
  { left: 70, top: 12, rotate: -3 },
  { left: 12, top: 40, rotate: 5 },
  { left: 48, top: 34, rotate: -4 },
  { left: 74, top: 46, rotate: 7 },
  { left: 30, top: 66, rotate: -2 },
] as const;

const NODE_X = [80, 360, 640, 920] as const;
const NODE_Y = 400;
const NODE_RADIUS = 42;
const ARC_Y = NODE_Y - NODE_RADIUS;
const LABEL_FONT_SIZE = 22;
// IBM Plex Mono is 0.6em wide per character, so a label's text width is known before it is drawn.
const LABEL_CHAR_WIDTH = LABEL_FONT_SIZE * 0.6;
const ARROW_REF = "url(#fold-arrow)";

type PlannedPayment = {
  readonly payerName: string;
  readonly payeeName: string;
  readonly payerIndex: number;
  readonly payeeIndex: number;
  readonly cents: number;
  readonly amount: string;
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly labelWidth: number;
  readonly labelHeight: number;
};

type PaymentPlan = {
  readonly payments: readonly PlannedPayment[];
  readonly startCents: readonly number[];
};

function slotOf(index: number) {
  return SLOTS[index % SLOTS.length];
}

function nodeX(index: number): number {
  return NODE_X[index % NODE_X.length];
}

function planPayments(story: SampleTripStory, rows: readonly BalanceRow[]): PaymentPlan {
  const startCents = story.people.map((person) => {
    const row = rows.find((candidate) => candidate.person === person);
    if (row === undefined) throw new Error("fold_balance_missing");
    return row.cents;
  });
  const payments = paymentsLargestFirst(story).map((payment) => {
    const payerIndex = story.people.indexOf(payment.from);
    const payeeIndex = story.people.indexOf(payment.to);
    if (payerIndex < 0 || payeeIndex < 0) throw new Error("fold_unknown_person");
    const cents = centsOf(payment.amount);
    const x1 = nodeX(payerIndex);
    const x2 = nodeX(payeeIndex);
    const rise = Math.min(0.42 * Math.abs(x2 - x1), 300);
    return {
      payerName: payment.from,
      payeeName: payment.to,
      payerIndex,
      payeeIndex,
      cents,
      amount: payment.amount,
      path: `M ${x1} ${ARC_Y} Q ${(x1 + x2) / 2} ${ARC_Y - rise} ${x2} ${ARC_Y}`,
      labelX: (x1 + x2) / 2,
      labelY: ARC_Y - rise / 2,
      labelWidth: payment.amount.length * LABEL_CHAR_WIDTH + 20,
      labelHeight: LABEL_FONT_SIZE + 12,
    };
  });
  return { payments, startCents };
}

function buildTimelines(section: HTMLElement, rows: readonly BalanceRow[], plan: PaymentPlan): void {
  const all = <T extends Element>(selector: string): T[] => gsap.utils.toArray<T>(selector, section);
  const one = <T extends Element>(selector: string): T => {
    const found = section.querySelector<T>(selector);
    if (found === null) throw new Error(`fold_missing_${selector}`);
    return found;
  };
  const tokens = getComputedStyle(section);
  const paper = tokens.getPropertyValue("--paper").trim();
  const muted = tokens.getPropertyValue("--muted").trim();

  const cards = all<HTMLElement>("[data-card]");
  const faces = all<HTMLElement>("[data-card-face]");
  const titleStack = one<HTMLElement>("[data-title-stack]");
  const captionStack = one<HTMLElement>("[data-caption-stack]");
  const titles = [0, 1, 2].map((n) => one<HTMLElement>(`[data-title="${n}"]`));
  const captions = [0, 1, 2].map((n) => one<HTMLElement>(`[data-caption="${n}"]`));
  const rail = [0, 1, 2].map((n) => one<HTMLElement>(`[data-rail="${n}"]`));
  const railFill = one<HTMLElement>("[data-rail-fill]");
  const balances = one<HTMLElement>("[data-balances]");
  const nodes = all<SVGGElement>("[data-node]");

  // The entrance and the pinned scene never write the same property of the same element. If they did, a jump straight
  // into the middle of the section (a reload, an anchor link) would let whichever timeline finished last win, and the
  // scene would land in the wrong state. So the entrance owns the cards' outer box and the two text stacks, and the
  // pinned scene owns the card faces and the individual titles and captions.
  const entrance = gsap.timeline({
    scrollTrigger: { trigger: section, start: "top 85%", end: "top top", scrub: 0.6 },
  });
  entrance.fromTo(
    cards,
    { opacity: 0, y: -60, rotation: (index: number) => slotOf(index).rotate + 10 },
    { opacity: 1, y: 0, rotation: (index: number) => slotOf(index).rotate, duration: 1, ease: "power3.out", stagger: 0.06 },
    0,
  );
  entrance.fromTo(
    [titleStack, captionStack],
    { opacity: 0, y: 24 },
    { opacity: 1, y: 0, duration: 1, ease: "power3.out" },
    0,
  );

  const tl = gsap.timeline({
    defaults: { ease: "none", immediateRender: false },
    scrollTrigger: {
      trigger: section,
      start: "top top",
      end: "+=220%",
      pin: true,
      scrub: 0.6,
      anticipatePin: 1,
      invalidateOnRefresh: true,
    },
  });

  tl.fromTo(railFill, { scaleX: 0 }, { scaleX: 1, duration: 1 }, 0);
  tl.fromTo(rail[0], { color: paper }, { color: muted, duration: 0.02 }, 0.3);
  tl.fromTo(rail[1], { color: muted }, { color: paper, duration: 0.02 }, 0.3);
  tl.fromTo(rail[1], { color: paper }, { color: muted, duration: 0.02 }, 0.62);
  tl.fromTo(rail[2], { color: muted }, { color: paper, duration: 0.02 }, 0.62);

  // In each change of act the outgoing words leave over the first half and the incoming words arrive over the second,
  // so the two are never on screen together.
  tl.fromTo([titles[0], captions[0]], { opacity: 1, y: 0 }, { opacity: 0, y: -16, duration: 0.06 }, 0.12);
  tl.fromTo([titles[1], captions[1]], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.06 }, 0.18);
  tl.fromTo(
    cards,
    {
      scale: 1,
      left: (index: number) => `${slotOf(index).left}%`,
      top: (index: number) => `${slotOf(index).top}%`,
    },
    {
      scale: 0.42,
      left: (index: number) => `${62 + index * 2}%`,
      top: (index: number) => `${index * 1.2}%`,
      duration: 0.12,
    },
    0.12,
  );
  // The outer box keeps its slot tilt from the entrance, so the face turns the opposite way to bring the pile upright.
  tl.fromTo(
    faces,
    { opacity: 1, rotation: 0 },
    { opacity: 0.35, rotation: (index: number) => -slotOf(index).rotate, duration: 0.12 },
    0.12,
  );
  // The balances wait until the pile has settled in the corner, so no card is ever drawn across a bar.
  tl.fromTo(balances, { opacity: 0 }, { opacity: 1, duration: 0.08 }, 0.22);

  rows.forEach((row, index) => {
    const at = 0.28 + 0.04 * index;
    const bar = section.querySelector<HTMLElement>(`[data-bar="${index}"]`);
    const value = one<HTMLElement>(`[data-value="${index}"]`);
    const size = Math.abs(row.cents);
    const counter = { cents: 0 };

    if (bar !== null) tl.fromTo(bar, { scaleY: 0 }, { scaleY: 1, duration: 0.06 }, at);
    tl.fromTo(value, { opacity: 0 }, { opacity: 1, duration: 0.02 }, at);
    tl.fromTo(
      value,
      { y: () => (bar === null ? 0 : (row.cents > 0 ? 1 : -1) * bar.offsetHeight) },
      { y: 0, duration: 0.06 },
      at,
    );
    tl.fromTo(
      counter,
      { cents: 0 },
      {
        cents: size,
        duration: 0.06,
        onUpdate: () => {
          const shown = Math.round(counter.cents);
          value.textContent = shown === size ? row.signed : formatSignedCents(Math.sign(row.cents) * shown);
        },
      },
      at,
    );
  });

  tl.fromTo([titles[1], captions[1]], { opacity: 1, y: 0 }, { opacity: 0, y: -16, duration: 0.05 }, 0.52);
  tl.fromTo(balances, { opacity: 1 }, { opacity: 0, duration: 0.05 }, 0.52);
  tl.fromTo(faces, { opacity: 0.35 }, { opacity: 0, duration: 0.05 }, 0.52);
  tl.fromTo([titles[2], captions[2]], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.05 }, 0.57);
  tl.fromTo(nodes, { opacity: 0 }, { opacity: 1, duration: 0.05 }, 0.57);

  const count = plan.payments.length;
  const slot = 0.36 / Math.max(count, 1);
  plan.payments.forEach((payment, k) => {
    const start = 0.62 + k * slot;
    const arc = one<SVGPathElement>(`[data-arc="${k}"]`);
    const label = one<SVGGElement>(`[data-arc-label="${k}"]`);
    const length = arc.getTotalLength();
    const draw = { progress: 0 };
    arc.style.strokeDasharray = `${length}`;
    arc.style.strokeDashoffset = `${length}`;
    arc.removeAttribute("marker-end");

    // A round cap would leave a dot at the start of an undrawn arc, so each arc only appears when its slot begins.
    tl.fromTo(arc, { opacity: 0 }, { opacity: 1, duration: 0.005 }, start);
    tl.fromTo(
      draw,
      { progress: 0 },
      {
        progress: 1,
        duration: slot,
        onUpdate: () => {
          arc.style.strokeDashoffset = `${length * (1 - draw.progress)}`;
          // Markers ignore dashes, so the arrowhead is held back until the line has reached it.
          if (draw.progress >= 0.97) arc.setAttribute("marker-end", ARROW_REF);
          else arc.removeAttribute("marker-end");
        },
      },
      start,
    );
    tl.fromTo(label, { opacity: 0 }, { opacity: 1, duration: slot / 4 }, start + (slot * 3) / 4);
  });

  // One tween owns every running balance. Two payments can touch the same person, and tweens that each wrote their own
  // two people would overwrite one another depending on the order they happen to render in.
  const runningTexts = plan.startCents.map((_, index) => one<SVGTextElement>(`[data-run="${index}"]`));
  const steps = { done: 0 };
  tl.fromTo(
    steps,
    { done: 0 },
    {
      done: count,
      duration: slot * count,
      onUpdate: () => {
        const shown = [...plan.startCents];
        plan.payments.forEach((payment, k) => {
          const moved = payment.cents * Math.min(Math.max(steps.done - k, 0), 1);
          shown[payment.payerIndex] += moved;
          shown[payment.payeeIndex] -= moved;
        });
        runningTexts.forEach((text, index) => {
          text.textContent = formatSignedCents(Math.round(shown[index]));
        });
      },
    },
    0.62,
  );

  tl.set({}, {}, 1);
}

function FoldPinned({ story }: { story: SampleTripStory }) {
  const sectionRef = useRef<HTMLElement>(null);
  const copy = useMemo(() => foldCopy(story), [story]);
  const rows = useMemo(() => balanceRows(story), [story]);
  const plan = useMemo(() => planPayments(story, rows), [story, rows]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;
    const context = gsap.context(() => buildTimelines(section, rows, plan), section);
    let live = true;
    // Web fonts change line heights, which moves where the pin starts.
    void document.fonts.ready.then(() => {
      if (live) ScrollTrigger.refresh();
    });
    return () => {
      live = false;
      context.revert();
    };
  }, [rows, plan]);

  return (
    <div>
      <section ref={sectionRef} id="how-it-works" aria-labelledby="fold-title" className={styles.fold}>
        <h2 id="fold-title" className={styles.srOnly}>
          How Penny settles a trip
        </h2>
        <div className={styles.stage}>
          <div className={styles.left}>
            <p className={styles.kicker}>{copy.kicker}</p>
            <div data-title-stack className={styles.titleStack}>
              {copy.titles.map((title, index) => (
                <h3
                  key={title.rest}
                  data-title={index}
                  className={`${styles.title} ${index > 0 ? styles.titleLater : ""}`}
                >
                  <span className={styles.num}>{title.word}</span> {title.rest}
                </h3>
              ))}
            </div>
            <div data-caption-stack className={styles.captionStack}>
              {copy.captions.map((caption, index) => (
                <p
                  key={caption}
                  data-caption={index}
                  className={`${styles.caption} ${index > 0 ? styles.captionLater : ""}`}
                >
                  {caption}
                </p>
              ))}
            </div>
            <div className={styles.rail}>
              <div className={styles.railLabels}>
                {copy.rail.map((label, index) => (
                  <span key={label} data-rail={index} className={styles.railLabel}>
                    {label}
                  </span>
                ))}
              </div>
              <div className={styles.railTrack} aria-hidden="true">
                <div data-rail-fill className={styles.railFill} />
              </div>
            </div>
          </div>

          <div className={styles.visual}>
            <div className={`${styles.layer} ${styles.receipts}`}>
              {story.expenses.map((expense, index) => (
                <div
                  key={expense.id}
                  data-card
                  className={styles.cardSlot}
                  style={{ left: `${slotOf(index).left}%`, top: `${slotOf(index).top}%` }}
                >
                  <div data-card-face>
                    <ReceiptCard expense={expense} baseCurrency={story.baseCurrency} />
                  </div>
                </div>
              ))}
            </div>

            <div data-balances className={`${styles.layer} ${styles.balances}`}>
              {copy.split !== null ? (
                <div className={styles.callout}>
                  <p>{copy.split.lineOne}</p>
                  <p className={styles.calloutNote}>{copy.split.lineTwo}</p>
                </div>
              ) : null}
              <div className={styles.balanceGrid} style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
                {rows.map((row, index) => {
                  // 40% of the bar area, held back on short windows so the amount above the tallest bar always clears
                  // the sentence: 50% minus 36px leaves room for the label's height, its 8px lift and the air above it.
                  const length = `calc(${row.ratio} * min(40%, 50% - 36px))`;
                  const up = row.cents > 0;
                  return (
                    <div key={row.person} className={styles.balanceColumn}>
                      <div className={styles.balanceHead}>{row.person}</div>
                      <p className={styles.balanceSentence}>{row.sentence}</p>
                      <div className={styles.barArea} aria-hidden="true">
                        <div className={styles.zeroLine} />
                        {row.cents === 0 ? null : (
                          <div
                            data-bar={index}
                            className={`${styles.bar} ${up ? styles.barUp : styles.barDown}`}
                            style={{ height: length }}
                          />
                        )}
                        <div
                          data-value={index}
                          className={styles.barValue}
                          style={up ? { bottom: `calc(50% + ${length} + 8px)` } : { top: `calc(50% + ${length} + 8px)` }}
                        >
                          {row.signed}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={styles.layer}>
              <ul className={styles.srOnly}>
                {plan.payments.map((payment) => (
                  <li key={`${payment.payerName}-${payment.payeeName}`}>
                    {`${payment.payerName} pays ${payment.payeeName} ${payment.amount} ${story.baseCurrency}`}
                  </li>
                ))}
              </ul>
              <svg
                className={styles.nodes}
                viewBox="0 0 1000 520"
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="fold-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="8"
                    markerHeight="8"
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path className={styles.arrowHead} d="M0 0 L10 5 L0 10 Z" />
                  </marker>
                </defs>
                {plan.payments.map((payment, k) => (
                  <path key={`arc-${k}`} data-arc={k} className={styles.arc} d={payment.path} />
                ))}
                {story.people.map((person, index) => {
                  const row = rows.find((candidate) => candidate.person === person);
                  return (
                    <g key={person} data-node className={styles.node}>
                      <circle className={styles.nodeCircle} cx={nodeX(index)} cy={NODE_Y} r={NODE_RADIUS} />
                      <text className={styles.nodeName} x={nodeX(index)} y={NODE_Y} dy="0.35em">
                        {person}
                      </text>
                      <text data-run={index} className={styles.nodeRunning} x={nodeX(index)} y={NODE_Y + 76}>
                        {row === undefined ? "" : row.signed}
                      </text>
                    </g>
                  );
                })}
                {plan.payments.map((payment, k) => (
                  <g key={`label-${k}`} data-arc-label={k} className={styles.arcLabel}>
                    <rect
                      className={styles.arcLabelBox}
                      rx={6}
                      x={payment.labelX - payment.labelWidth / 2}
                      y={payment.labelY - payment.labelHeight / 2}
                      width={payment.labelWidth}
                      height={payment.labelHeight}
                    />
                    <text className={styles.arcLabelText} x={payment.labelX} y={payment.labelY} dy="0.35em">
                      {payment.amount}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function subscribe(onChange: () => void): () => void {
  const queries = [window.matchMedia(PINNED_QUERY), window.matchMedia(CALM_QUERY)];
  for (const query of queries) query.addEventListener("change", onChange);
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
}

function pinnedNow(): boolean {
  return window.matchMedia(PINNED_QUERY).matches && !window.matchMedia(CALM_QUERY).matches;
}

// The server and the first client render both answer "static", so hydration matches; the pinned layout takes over after.
function pinnedOnServer(): boolean {
  return false;
}

export function Fold({ story }: { story: SampleTripStory }) {
  const pinned = useSyncExternalStore(subscribe, pinnedNow, pinnedOnServer);
  return pinned ? <FoldPinned story={story} /> : <FoldStatic story={story} />;
}
