"use client";

import { listCurrencies } from "@penny/core";
import { motion } from "motion/react";
import Link from "next/link";
import { ArrowIcon } from "./arrow-icon";
import styles from "./cinema.module.css";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const CURRENCY_COUNT = listCurrencies().length;

export function MetaRow() {
  const cell = (index: number) => ({
    className: styles.metaCell,
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, ease: EASE_OUT, delay: 1.15 + index * 0.08 },
  });

  return (
    <dl className={styles.metaRow}>
      <motion.div {...cell(0)}>
        <dt>Splits</dt>
        <dd>To the last cent</dd>
      </motion.div>
      <motion.div {...cell(1)}>
        <dt>Settles up</dt>
        <dd>In the fewest payments</dd>
      </motion.div>
      <motion.div {...cell(2)}>
        <dt>Currencies</dt>
        <dd>{CURRENCY_COUNT}, with ECB reference rates</dd>
      </motion.div>
      <motion.div {...cell(3)}>
        <dt>Tested</dt>
        <dd>
          <Link href="/checks" className={styles.metaLink} data-testid="home-checks-link">
            How Penny is tested
          </Link>
          <ArrowIcon />
        </dd>
      </motion.div>
    </dl>
  );
}
