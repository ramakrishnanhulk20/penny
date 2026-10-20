"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import { Coin } from "./coin";
import styles from "./cinema.module.css";
import { Grain } from "./grain";
import { HeroActions } from "./hero-actions";
import { MetaRow } from "./meta-row";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const TITLE_LETTERS = ["P", "e", "n", "n", "y"];

export function Hero() {
  const sectionRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start start", "end start"] });
  const titleY = useTransform(scrollYProgress, [0, 1], ["0vh", "-8vh"]);
  const titleOpacity = useTransform(scrollYProgress, [0, 1], [1, 0.35]);

  return (
    <>
      <section ref={sectionRef} aria-labelledby="hero-title" className={styles.hero}>
        <div className={styles.stage}>
          <div ref={frameRef} className={styles.frame}>
            <Coin sectionRef={sectionRef} frameRef={frameRef} />
            <Grain />
            <div className={styles.scrim} />
            <div className={styles.copy}>
              <motion.h1
                id="hero-title"
                className={styles.headline}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: EASE_OUT, delay: 0.9 }}
              >
                Split shared costs to the penny.
              </motion.h1>
              <motion.p
                className={styles.lede}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: EASE_OUT, delay: 1.0 }}
              >
                Add what everyone paid. Penny works out the fewest payments to settle up, exact to the last cent.
              </motion.p>
            </div>
          </div>

          <motion.div aria-hidden="true" className={styles.title} style={{ y: titleY, opacity: titleOpacity }}>
            {TITLE_LETTERS.map((letter, index) => (
              <motion.span
                key={index}
                className={styles.titleLetter}
                initial={{ y: "0.55em", opacity: 0, filter: "blur(8px)" }}
                animate={{ y: "0em", opacity: 1, filter: "blur(0px)" }}
                transition={{ duration: 1.2, ease: EASE_OUT, delay: 0.35 + index * 0.07 }}
              >
                {letter}
              </motion.span>
            ))}
          </motion.div>
        </div>

        <HeroActions />
      </section>
      <MetaRow />
    </>
  );
}
