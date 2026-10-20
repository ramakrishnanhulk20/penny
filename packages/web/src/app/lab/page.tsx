import type { Metadata } from "next";
import styles from "@/components/cinema/cinema.module.css";
import { Hero } from "@/components/cinema/hero";
import { Nav } from "@/components/cinema/nav";
import { SmoothScroll } from "@/components/cinema/smooth-scroll";

export const metadata: Metadata = { title: "Lab", robots: { index: false, follow: false } };

export default function LabPage() {
  return (
    <>
      <SmoothScroll />
      <main className="cinema">
        <Nav />
        <Hero />
        <section className={styles.labNext}>
          Next on this page: the fold, where seven receipts become three payments.
        </section>
      </main>
    </>
  );
}
