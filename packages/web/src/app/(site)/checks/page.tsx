import { Footer } from "@/components/cinema/footer";
import { Nav } from "@/components/cinema/nav";
import { ChecksScreen } from "./checks-screen";

export default function ChecksPage() {
  return (
    <main className="cinema app">
      <Nav />
      <h1 className="poster-title">How Penny is tested</h1>
      <div className="checks-intro">
        <p className="lede">
          {
            "Every change to Penny ships through a pull request. TestSprite runs the test suite against that pull request's own preview, and GitHub refuses to merge it until the check passes."
          }
        </p>
        <p className="lede">
          {
            "When TestSprite fails one of these pull requests, a locked-down job asks Claude Code for a fix, a script with no AI in it checks the change before it is pushed, and TestSprite tests the fix again. A person reads and merges every fixed pull request."
          }
        </p>
      </div>
      <ChecksScreen />
      <Footer />
    </main>
  );
}
