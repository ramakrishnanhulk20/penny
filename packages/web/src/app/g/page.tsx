import type { Metadata } from "next";
import { Nav } from "@/components/cinema/nav";
import { GroupScreen } from "./group-screen";

// Backs up the X-Robots-Tag header from next.config.ts: a group page is never indexed (threat model C4).
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function GroupPage() {
  return (
    <main className="cinema app">
      <Nav />
      <GroupScreen />
    </main>
  );
}
