import { RootProvider } from "fumadocs-ui/provider/next";
import { IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import "fumadocs-ui/style.css";
import "./docs-theme.css";

// The docs have their own root layout because the site's globals.css restyles bare elements (main, header, h1, p,
// button) and that breaks the Fumadocs layout. The font calls match the site's, so both share one set of font files.
const sans = Instrument_Sans({ subsets: ["latin"], weight: "variable", axes: ["wdth"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export default function DocsRootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      <body>
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
