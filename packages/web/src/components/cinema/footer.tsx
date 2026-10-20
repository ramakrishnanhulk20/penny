import Link from "next/link";
import { CoinMark } from "./coin-mark";
import styles from "./cinema.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <span>
        <CoinMark size={16} />
        Penny · every change tested by TestSprite
      </span>
      <div className={styles.footerLinks}>
        {/* The docs have their own root layout and bundle; prefetching would download it on every page that shows this. */}
        <Link href="/docs" prefetch={false} className={styles.footerLink}>
          Docs
        </Link>
        <Link href="/checks" className={styles.footerLink}>
          How it is tested
        </Link>
        <a href="https://github.com/ramakrishnanhulk20/penny" rel="noreferrer" className={styles.footerLink}>
          GitHub
        </a>
      </div>
    </footer>
  );
}
