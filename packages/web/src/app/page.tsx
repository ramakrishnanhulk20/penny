import { Hero } from "@/components/cinema/hero";
import { Nav } from "@/components/cinema/nav";
import { SmoothScroll } from "@/components/cinema/smooth-scroll";

export default function Home() {
  return (
    <>
      <SmoothScroll />
      <main className="cinema">
        <Nav />
        <Hero />
      </main>
    </>
  );
}
