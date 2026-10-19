import { ChecksScreen } from "./checks-screen";

export default function ChecksPage() {
  return (
    <main>
      <h1>How Penny is tested</h1>
      <p>
        {
          "Every change to Penny ships through a pull request. TestSprite runs the test suite against that pull request's own preview, and GitHub refuses to merge it until the check passes."
        }
      </p>
      <ChecksScreen />
    </main>
  );
}
