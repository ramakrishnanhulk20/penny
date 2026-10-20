"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { useEffect } from "react";

gsap.registerPlugin(ScrollTrigger);

export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    // Lenis moves the page itself, so ScrollTrigger has to be told every time it does.
    const syncTriggers = () => ScrollTrigger.update();
    const tick = (time: number) => lenis.raf(time * 1000);
    lenis.on("scroll", syncTriggers);
    gsap.ticker.add(tick);
    // With lag smoothing on, a slow frame makes GSAP skip ahead and the pinned scene jumps.
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      lenis.off("scroll", syncTriggers);
      lenis.destroy();
    };
  }, []);

  return null;
}
