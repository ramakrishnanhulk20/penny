import type { Metadata } from "next";
import { Fold } from "@/components/cinema/fold";
import { Hero } from "@/components/cinema/hero";
import { Nav } from "@/components/cinema/nav";
import { SmoothScroll } from "@/components/cinema/smooth-scroll";
import { sampleTripStory } from "@/lib/sample-trip-story";

export const metadata: Metadata = { title: "Lab", robots: { index: false, follow: false } };

export default function LabPage() {
  return (
    <>
      <SmoothScroll />
      <main className="cinema">
        <Nav />
        <Hero />
        <Fold story={sampleTripStory()} />
        <div aria-hidden="true" style={{ height: "40vh" }} />
      </main>
    </>
  );
}
