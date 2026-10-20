"use client";

import { motion, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { useEffect, type RefObject } from "react";
import styles from "./cinema.module.css";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;
// The last space is a no-break space: a plain trailing space is dropped by SVG, which would close the seam up.
const RIM_TEXT = "EVERY CENT ACCOUNTED FOR · ".repeat(4).slice(0, -1) + "\u00A0";
const RING_LENGTH = 2714;
const RING_PATH = "M 500 68 A 432 432 0 1 1 500 932 A 432 432 0 1 1 500 68 Z";

type CoinProps = {
  readonly sectionRef: RefObject<HTMLElement | null>;
  readonly frameRef: RefObject<HTMLElement | null>;
};

export function Coin({ sectionRef, frameRef }: CoinProps) {
  const reduced = useReducedMotion() === true;

  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start start", "end start"] });
  const scrollY = useTransform(scrollYProgress, [0, 1], ["0vh", "16vh"]);
  const scrollRotate = useTransform(scrollYProgress, [0, 1], [0, 18]);

  const aimX = useMotionValue(0);
  const aimY = useMotionValue(0);
  const tiltX = useSpring(aimX, { stiffness: 60, damping: 18 });
  const tiltY = useSpring(aimY, { stiffness: 60, damping: 18 });

  useEffect(() => {
    const frame = frameRef.current;
    if (reduced || frame === null || !window.matchMedia("(pointer: fine)").matches) return;
    const aim = (event: PointerEvent) => {
      const box = frame.getBoundingClientRect();
      const across = (event.clientX - box.left) / box.width;
      const down = (event.clientY - box.top) / box.height;
      aimX.set((0.5 - down) * 10);
      aimY.set((across - 0.5) * 14);
    };
    const release = () => {
      aimX.set(0);
      aimY.set(0);
    };
    frame.addEventListener("pointermove", aim);
    frame.addEventListener("pointerleave", release);
    return () => {
      frame.removeEventListener("pointermove", aim);
      frame.removeEventListener("pointerleave", release);
    };
  }, [reduced, frameRef, aimX, aimY]);

  return (
    <div className={styles.coin}>
      <motion.div className={styles.coinLayer} style={{ rotateX: tiltX, rotateY: tiltY }}>
        <motion.div className={styles.coinLayer} style={{ y: scrollY, rotate: scrollRotate }}>
          <motion.div
            className={styles.coinLayer}
            initial={{ opacity: 0, scale: 1.08, rotate: -10 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            transition={{ duration: 1.8, ease: EASE_OUT, delay: 0.1 }}
          >
            {/* SWAP: the coin is drawn in SVG; a studio photo of a real copper coin can replace it later */}
            <svg viewBox="0 0 1000 1000" aria-hidden="true" className={styles.coinSvg}>
              <defs>
                <radialGradient id="coin-face" cx="38%" cy="32%" r="75%">
                  <stop offset="0%" stopColor="#F6C08D" />
                  <stop offset="18%" stopColor="#E39A62" />
                  <stop offset="46%" stopColor="#C8763E" />
                  <stop offset="78%" stopColor="#7A4220" />
                  <stop offset="100%" stopColor="#3A1E0E" />
                </radialGradient>
                <linearGradient id="coin-rim" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#F0B27C" />
                  <stop offset="35%" stopColor="#8A4A22" />
                  <stop offset="60%" stopColor="#E39A62" />
                  <stop offset="100%" stopColor="#4A2511" />
                </linearGradient>
                <linearGradient id="coin-sweep" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#FFECD6" stopOpacity="0" />
                  <stop offset="50%" stopColor="#FFECD6" stopOpacity="0.55" />
                  <stop offset="100%" stopColor="#FFECD6" stopOpacity="0" />
                </linearGradient>
                <filter id="coin-shadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="30" />
                </filter>
                <clipPath id="coin-disc">
                  <circle cx="500" cy="500" r="500" />
                </clipPath>
                <path id="coin-ring" d={RING_PATH} />
              </defs>

              <ellipse cx="460" cy="560" rx="500" ry="470" fill="rgba(0,0,0,0.6)" filter="url(#coin-shadow)" />

              <circle cx="500" cy="500" r="500" fill="url(#coin-rim)" />
              <circle
                cx="500"
                cy="500"
                r="489"
                fill="none"
                stroke="url(#coin-rim)"
                strokeWidth="22"
                strokeDasharray="4.2 4.33"
                strokeOpacity="0.9"
              />
              <circle cx="500" cy="500" r="452" fill="url(#coin-face)" />

              <circle cx="500" cy="500" r="410" fill="none" stroke="rgba(58,30,14,0.55)" strokeWidth="6" />
              <circle cx="500" cy="500" r="404" fill="none" stroke="rgba(246,192,141,0.35)" strokeWidth="2" />

              <g className={styles.rimText} fontSize="34">
                <text fill="rgba(246,192,141,0.25)" transform="translate(-1.5 -1.5)">
                  <textPath href="#coin-ring" textLength={RING_LENGTH} lengthAdjust="spacing">
                    {RIM_TEXT}
                  </textPath>
                </text>
                <text fill="rgba(58,30,14,0.55)">
                  <textPath href="#coin-ring" textLength={RING_LENGTH} lengthAdjust="spacing">
                    {RIM_TEXT}
                  </textPath>
                </text>
              </g>

              <g className={styles.coinNumeral} textAnchor="middle">
                <text x="500" y="600" fill="rgba(246,192,141,0.3)" transform="translate(-2 -2)">
                  1
                </text>
                <text x="500" y="600" fill="rgba(58,30,14,0.5)">
                  1
                </text>
              </g>
              <g className={styles.coinWord} textAnchor="middle">
                <text x="500" y="690" fill="rgba(246,192,141,0.3)" transform="translate(-2 -2)">
                  CENT
                </text>
                <text x="500" y="690" fill="rgba(58,30,14,0.5)">
                  CENT
                </text>
              </g>

              <g clipPath="url(#coin-disc)" className={styles.sweepClip}>
                <g transform="rotate(25 500 500)">
                  <rect x="-500" y="-200" width="900" height="1400" fill="url(#coin-sweep)" className={styles.sweep} />
                </g>
              </g>
            </svg>
          </motion.div>
        </motion.div>
      </motion.div>
    </div>
  );
}
