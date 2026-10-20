"use client";

import { useEffect, useState } from "react";
import type { ChecksSnapshot, PrCheck } from "@/lib/checks";

type Loaded = { readonly status: "ready"; readonly snapshot: ChecksSnapshot } | { readonly status: "failed" };

// A shape check only: the server validated every field and built every link before sending them.
function isSnapshot(body: unknown): body is ChecksSnapshot {
  return (
    typeof body === "object" &&
    body !== null &&
    "live" in body &&
    typeof body.live === "object" &&
    body.live !== null &&
    "prs" in body &&
    Array.isArray(body.prs) &&
    "fetchedAt" in body &&
    typeof body.fetchedAt === "string"
  );
}

async function loadChecks(signal: AbortSignal): Promise<Loaded> {
  try {
    const response = await fetch("/api/checks", {
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) return { status: "failed" };
    const body: unknown = await response.json();
    return isSnapshot(body) ? { status: "ready", snapshot: body } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

function liveLine(live: ChecksSnapshot["live"]): string {
  if (live.sha === null) return "The running commit is not known.";
  const short = live.sha.slice(0, 7);
  return live.pr === null
    ? `This site runs commit ${short}.`
    : `This site runs commit ${short} from pull request #${live.pr}.`;
}

/** The TestSprite line under one pull request, from its verdict and counts alone. */
export function verdictLine(pr: PrCheck): string {
  const blocked = pr.blocked !== null && pr.blocked > 0 ? `, ${pr.blocked} blocked` : "";
  if (pr.verdict === "blocked" && pr.blocked !== null && pr.total !== null) {
    return `TestSprite: blocked, ${pr.blocked} of ${pr.total} could not run`;
  }
  if (pr.verdict === "passed" && pr.passed !== null && pr.total !== null) {
    return `TestSprite: passed, ${pr.passed} of ${pr.total}${blocked}`;
  }
  if (pr.verdict === "failed" && pr.passed !== null && pr.total !== null) {
    const failed = pr.failed !== null && pr.failed > 0 ? `, ${pr.failed} failed` : "";
    return `TestSprite: failed, ${pr.passed} of ${pr.total} passed${failed}${blocked}`;
  }
  return `TestSprite: ${pr.verdict}`;
}

function fetchedLine(snapshot: ChecksSnapshot): string {
  const at = new Date(snapshot.fetchedAt);
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const read = `Read from GitHub at ${time} UTC.`;
  return snapshot.stale ? `${read} GitHub did not answer; showing the last good read.` : read;
}

/** The live part of /checks: the running commit, the recent pull requests and their TestSprite verdicts. */
export function ChecksScreen() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadChecks(controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoaded(result);
    });
    return () => controller.abort();
  }, []);

  if (loaded === null) return <p>Reading the latest checks...</p>;
  if (loaded.status === "failed") return <p>Checks are not available right now.</p>;
  const { snapshot } = loaded;

  return (
    <>
      <section>
        <h2>Live right now</h2>
        <p data-testid="checks-live">{liveLine(snapshot.live)}</p>
      </section>

      <section>
        <h2>Recent pull requests</h2>
        <ul className="plain">
          {snapshot.prs.map((pr) => (
            <li key={pr.number} data-testid="checks-pr">
              <div>{`#${pr.number} ${pr.title}`}</div>
              <div>{pr.state}</div>
              <div>{verdictLine(pr)}</div>
              <div className="inline">
                <a href={pr.prUrl} rel="noreferrer">
                  Pull request
                </a>
                {pr.reportUrl !== null && (
                  <a href={pr.reportUrl} rel="noreferrer">
                    Test report
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p data-testid="checks-fetched">{fetchedLine(snapshot)}</p>
    </>
  );
}
