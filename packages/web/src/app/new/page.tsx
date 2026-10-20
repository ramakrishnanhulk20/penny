import { Nav } from "@/components/cinema/nav";
import { CreateGroupForm } from "./create-group-form";

export default function StartGroupPage() {
  return (
    <main className="cinema app">
      <Nav />
      <div className="new-layout">
        <h1 className="poster-title">Start a group</h1>
        <p className="lede">
          Name it, pick the currency balances are shown in, and add everyone who shares the costs. No accounts: the
          group opens by its link.
        </p>
        <CreateGroupForm />
      </div>
    </main>
  );
}
