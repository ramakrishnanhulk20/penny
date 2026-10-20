"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { FieldError } from "@/components/field-error";
import { FALLBACK_MESSAGE } from "@/lib/client/messages";
import { startSampleTrip } from "@/lib/client/sample-trip";
import { ArrowIcon } from "./arrow-icon";
import styles from "./cinema.module.css";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export function HeroActions() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // A second press can land before React re-renders the disabled button, so the guard lives outside render.
  const inFlight = useRef(false);

  async function trySampleTrip() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    const result = await startSampleTrip();
    if (result.ok) {
      try {
        window.sessionStorage.setItem("penny:created", "1");
      } catch {
        // Storage can be switched off in the browser. The group still opens, just without the created banner.
      }
      // A full page load, as after "Create group", so the group page reads its token from a fresh address. The button
      // stays disabled while the browser leaves.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load wanted, see above
      window.location.assign("/g#" + result.data.token);
      return;
    }
    inFlight.current = false;
    setPending(false);
    setError(FALLBACK_MESSAGE);
  }

  return (
    <div className={styles.actions}>
      <motion.div
        className={styles.actionRow}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: EASE_OUT, delay: 1.1 }}
      >
        <Link href="/new" className={styles.primary} data-testid="home-start">
          Start a group
          <ArrowIcon />
        </Link>
        <button
          type="button"
          className={styles.ghost}
          onClick={trySampleTrip}
          disabled={pending}
          aria-describedby={error === undefined ? undefined : "home-sample-trip-error"}
          data-testid="home-sample-trip"
        >
          Try a sample trip
        </button>
      </motion.div>
      {pending && (
        <p role="status" className={styles.status}>
          <span className={styles.statusDot} aria-hidden="true" />
          Making your sample trip...
        </p>
      )}
      <div className={styles.actionError}>
        <FieldError id="home-sample-trip-error" message={error} />
      </div>
    </div>
  );
}
