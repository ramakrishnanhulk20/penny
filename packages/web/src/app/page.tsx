"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { FieldError } from "@/components/field-error";
import { FALLBACK_MESSAGE } from "@/lib/client/messages";
import { startSampleTrip } from "@/lib/client/sample-trip";

export default function Home() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // A second press can land before React re-renders the disabled button, so the guard lives outside render.
  const inFlight = useRef(false);

  async function trySampleTrip() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    const result = await startSampleTrip();
    if (result.ok) {
      try {
        window.sessionStorage.setItem("penny:created", "1");
      } catch {
        // Storage can be switched off in the browser. The group still opens, just without the created banner.
      }
      // A full page load, as after "Create group", so the group page reads its token from a fresh address. The button
      // stays disabled while the browser leaves.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load wanted, see above
      window.location.assign("/g#" + result.data.token);
      return;
    }
    inFlight.current = false;
    setPending(false);
    setError(FALLBACK_MESSAGE);
  }

  return (
    <main>
      <h1>Split shared costs to the penny.</h1>
      <p>Add what everyone paid. Penny works out the fewest payments to settle up, exact to the last cent.</p>
      <div>
        <Link href="/new" className="button" data-testid="home-start">
          Start a group
        </Link>
      </div>
      <div>
        <button
          type="button"
          onClick={trySampleTrip}
          disabled={pending}
          aria-describedby={error === undefined ? undefined : "home-sample-trip-error"}
          data-testid="home-sample-trip"
        >
          Try a sample trip
        </button>
        {pending && <p role="status">Making your sample trip...</p>}
        <FieldError id="home-sample-trip-error" message={error} />
      </div>
      <p>
        <Link href="/checks" data-testid="home-checks-link">
          How Penny is tested
        </Link>
      </p>
    </main>
  );
}
