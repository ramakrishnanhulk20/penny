"use client";

import { useEffect, useId, useState } from "react";

const THEME_VARIABLES = {
  background: "#0B0A09",
  primaryColor: "#14110E",
  primaryTextColor: "#F2EEE8",
  primaryBorderColor: "#C8763E",
  lineColor: "#C8763E",
  secondaryColor: "#14110E",
  tertiaryColor: "#14110E",
  fontFamily: "var(--font-sans)",
  fontSize: "15px",
};

type Drawn = { readonly chart: string; readonly svg: string | null };

/**
 * Draws a Mermaid diagram in the browser. Mermaid is downloaded only by pages that have a diagram. A chart that does
 * not parse, or a download that fails, shows the chart's source text instead of an empty box.
 */
export function Mermaid({ chart }: { readonly chart: string }) {
  // Mermaid puts the id on an element and into CSS selectors, so only letters, digits, dashes and underscores stay.
  const id = `mermaid-${useId().replace(/[^\w-]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      let svg: string | null = null;
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: THEME_VARIABLES });
        if (await mermaid.parse(chart, { suppressErrors: true })) svg = (await mermaid.render(id, chart)).svg;
      } catch {
        svg = null;
      }
      if (current) setDrawn({ chart, svg });
    })();
    return () => {
      current = false;
    };
  }, [chart, id]);

  if (drawn === null || drawn.chart !== chart) return <div className="docs-chart" aria-busy="true" />;
  if (drawn.svg === null) {
    return (
      <pre>
        <code>{chart}</code>
      </pre>
    );
  }
  // With securityLevel "strict" Mermaid encodes HTML in labels and turns off click handlers before it returns the SVG,
  // and the chart text comes from the docs files in this repo, never from a visitor.
  return <div className="docs-chart" dangerouslySetInnerHTML={{ __html: drawn.svg }} />;
}
