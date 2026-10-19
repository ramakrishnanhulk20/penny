import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Penny",
  description: "Split shared costs to the penny and settle up in the fewest payments.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
