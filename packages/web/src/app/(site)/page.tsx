import { Fold } from "@/components/cinema/fold";
import { Footer } from "@/components/cinema/footer";
import { Hero } from "@/components/cinema/hero";
import { Nav } from "@/components/cinema/nav";
import { SmoothScroll } from "@/components/cinema/smooth-scroll";
import { sampleTripStory } from "@/lib/sample-trip-story";

export default function Home() {
  return (
    <>
      <SmoothScroll />
      <main className="cinema">
        <Nav />
        <Hero />
        <Fold story={sampleTripStory()} />
        <Footer />
      </main>
    </>
  );
}
