"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { CoinMark } from "./coin-mark";
import styles from "./cinema.module.css";

export function Nav() {
  const headerRef = useRef<HTMLElement>(null);

  // The attribute is written straight onto the element so a scroll never re-renders React.
  useEffect(() => {
    const header = headerRef.current;
    if (header === null) return;
    const update = () => {
      header.dataset.scrolled = window.scrollY > 24 ? "true" : "false";
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header ref={headerRef} className={styles.nav} data-scrolled="false">
      <Link href="/checks" className={styles.navLink} data-testid="nav-checks">
        Checks
      </Link>
      <Link href="/" className={styles.brand} aria-label="Penny home">
        <CoinMark size={18} />
        Penny
      </Link>
      <a
        href="https://github.com/ramakrishnanhulk20/penny"
        rel="noreferrer"
        className={`${styles.navLink} ${styles.navGithub}`}
      >
        GitHub
      </a>
    </header>
  );
}
