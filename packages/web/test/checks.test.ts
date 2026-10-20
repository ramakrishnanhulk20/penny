// Not covered: the real GitHub API (every call here goes to a fake fetch); a 5 s timeout actually firing (only that
// every call carries a timeout signal); two real Postgres sessions racing for the advisory lock, because PGlite runs a
// single session where an advisory lock is always granted again, so another instance holding it is played by a
// stand-in lock answer; Neon itself; and the /checks page in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/checks/route";
import { type Db, setDbForTests } from "@/db/client";
import { checksSnapshot } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { type ChecksSnapshot, fetchSnapshot, parseVerdict, readSnapshot, safeReportUrl } from "@/lib/checks";

// connection() only works inside a live Next request; here it only needs to let the handler continue.
vi.mock("next/server", () => ({ connection: async () => undefined }));

const BOT_ID = 258111874;
const REPORT = "https://www.testsprite.com/dashboard-v3/o/org-1/projects/project-1/execution/run-1";
const LIST_URL =
  "https://api.github.com/repos/ramakrishnanhulk20/penny/pulls?state=all&sort=created&direction=desc&per_page=12";
const NO_COUNTS = { passed: null, failed: null, blocked: null, total: null };

function sha(digit: string): string {
  return digit.repeat(40);
}

function statusesUrl(head: string): string {
  return `https://api.github.com/repos/ramakrishnanhulk20/penny/commits/${head}/statuses?per_page=100`;
}

function pull(number: number, state: "open" | "closed", mergedInto: string | null, head: string) {
  return {
    number,
    title: `Change ${number}`,
    state,
    merged_at: mergedInto === null ? null : "2026-10-19T09:30:00Z",
    merge_commit_sha: mergedInto,
    head: { sha: head },
    html_url: "https://evil.example/not-github",
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    state: "success",
    description: "All 12 tests passed",
    target_url: REPORT,
    context: "TestSprite V3",
    created_at: "2026-10-19T09:27:13Z",
    creator: { login: "testsprite[bot]", id: BOT_ID, type: "Bot" },
    ...overrides,
  };
}

type Call = { readonly url: string; readonly init: RequestInit | undefined };

// Answers fixed bodies by exact URL, 404 for anything else, and puts next-page links on every answer to tempt a
// client into following them.
function fakeGitHub(bodies: ReadonlyMap<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (!bodies.has(url)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(bodies.get(url)), {
      status: 200,
      headers: {
        "content-type": "application/json",
        link: '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://evil.example/steal>; rel="last"',
      },
    });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

// One merged, one open and one closed pull request, newest first, as GitHub lists them.
function threePulls(): Map<string, unknown> {
  return new Map<string, unknown>([
    [LIST_URL, [pull(3, "open", null, sha("a")), pull(2, "closed", sha("d"), sha("b")), pull(1, "closed", null, sha("c"))]],
    [statusesUrl(sha("a")), [status({ state: "pending", description: "12 tests queued" })]],
    [statusesUrl(sha("b")), [status()]],
    [statusesUrl(sha("c")), [status({ context: "Vercel", description: "Deployment has completed" })]],
  ]);
}

beforeEach(() => {
  // A machine that happens to set these must not change what the tests see.
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
  vi.stubEnv("GITHUB_READ_TOKEN", "");
});

afterEach(() => {
  setDbForTests(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseVerdict", () => {
  it.each([
    ["pending", "12 tests queued", { verdict: "running", ...NO_COUNTS, total: 12 }],
    ["success", "All 12 tests passed", { verdict: "passed", passed: 12, failed: 0, blocked: 0, total: 12 }],
    ["failure", "23/28 passed · 5 failed", { verdict: "failed", passed: 23, failed: 5, blocked: 0, total: 28 }],
    ["error", "23/28 passed · 5 failed", { verdict: "failed", passed: 23, failed: 5, blocked: 0, total: 28 }],
    ["success", "40/41 passed · 1 blocked", { verdict: "passed", passed: 40, failed: 0, blocked: 1, total: 41 }],
    ["failure", "40/41 passed · 1 blocked", { verdict: "failed", passed: 40, failed: 0, blocked: 1, total: 41 }],
  ])("reads state %s with %j", (state, description, expected) => {
    expect(parseVerdict(state, description)).toEqual(expected);
  });

  it.each([
    ["success", ""],
    ["failure", ""],
    ["pending", ""],
    ["success", "All tests passed!"],
    ["success", "<img src=x onerror=alert(1)>"],
    ["success", "0 failed"],
    ["success", " All 12 tests passed"],
    ["success", "All 0 tests passed"],
    ["success", "All 1e3 tests passed"],
    ["success", "All １２ tests passed"],
    ["success", "23/28 passed - 5 failed"],
    ["failure", "23/28 passed · 6 failed"],
    ["success", "23/28 passed · 5 failed"],
    ["success", "12 tests queued"],
    ["failure", "All 12 tests passed"],
    ["neutral", "All 12 tests passed"],
  ])("reads state %s with %j as unknown, with every count null and never 0", (state, description) => {
    expect(parseVerdict(state, description)).toEqual({ verdict: "unknown", ...NO_COUNTS });
  });
});

describe("safeReportUrl", () => {
  it("accepts an https link on www.testsprite.com", () => {
    expect(safeReportUrl(REPORT)).toBe(REPORT);
  });

  it.each([
    "http://www.testsprite.com/dashboard-v3/run",
    "https://evil.example/dashboard-v3/run",
    "https://testsprite.com/dashboard-v3/run",
    "javascript:alert(document.cookie)",
    "JavaScript://www.testsprite.com/%0aalert(1)",
    "https://www.testsprite.com.evil.example/dashboard-v3/run",
    "https://www.testsprite.com@evil.example/dashboard-v3/run",
    "https://www.tеstsprite.com/dashboard-v3/run",
    "https://www.testsprite.com:8443/dashboard-v3/run",
    "https://user:pass@www.testsprite.com/dashboard-v3/run",
    "//www.testsprite.com/dashboard-v3/run",
    "",
  ])("refuses %j", (raw) => {
    expect(safeReportUrl(raw)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    for (const raw of [null, undefined, 42, {}, new URL(REPORT)]) expect(safeReportUrl(raw)).toBeNull();
  });
});

describe("fetchSnapshot", () => {
  it("builds every URL from fixed parts, sends the token to api.github.com only, and never follows a Link header", async () => {
    const github = fakeGitHub(threePulls());

    await fetchSnapshot(github.fetchImpl, "read-only-token");

    expect(github.calls.map((call) => call.url)).toEqual([
      LIST_URL,
      statusesUrl(sha("a")),
      statusesUrl(sha("b")),
      statusesUrl(sha("c")),
    ]);
    for (const call of github.calls) {
      expect(new URL(call.url).origin).toBe("https://api.github.com");
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer read-only-token");
    }

    const anonymous = fakeGitHub(threePulls());
    await fetchSnapshot(anonymous.fetchImpl, null);
    for (const call of anonymous.calls) expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
  });

  it("makes at most 13 calls, for the 12 newest pull requests, even when GitHub sends more", async () => {
    const pulls = Array.from({ length: 15 }, (_, index) => pull(index + 1, "open", null, (index + 1).toString(16).padStart(40, "0")));
    const github = fakeGitHub(new Map<string, unknown>([[LIST_URL, pulls], ...pulls.map((p) => [statusesUrl(p.head.sha), []] as const)]));

    const snapshot = await fetchSnapshot(github.fetchImpl, null);

    expect(github.calls).toHaveLength(13);
    expect(snapshot.prs.map((pr) => pr.number)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it("maps merged, open and closed, builds each link from the number, and names the live commit's pull request", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sha("d"));
    const bodies = threePulls();
    const [newest, ...rest] = bodies.get(LIST_URL) as ReturnType<typeof pull>[];
    bodies.set(LIST_URL, [{ ...newest, title: "Fix ‮gnp.exe login​" }, ...rest]);

    const snapshot = await fetchSnapshot(fakeGitHub(bodies).fetchImpl, null);

    expect(snapshot.live).toEqual({ sha: sha("d"), pr: 2 });
    expect(snapshot.stale).toBe(false);
    expect(snapshot.prs.map((pr) => [pr.number, pr.state, pr.prUrl])).toEqual([
      [3, "open", "https://github.com/ramakrishnanhulk20/penny/pull/3"],
      [2, "merged", "https://github.com/ramakrishnanhulk20/penny/pull/2"],
      [1, "closed", "https://github.com/ramakrishnanhulk20/penny/pull/1"],
    ]);
    expect(snapshot.prs[0]).toMatchObject({ title: "Fix gnp.exe login", verdict: "running", reportUrl: REPORT });
    expect(snapshot.prs[1]).toMatchObject({ verdict: "passed", passed: 12, total: 12, reportUrl: REPORT });
    expect(snapshot.prs[2]).toMatchObject({ verdict: "not run", ...NO_COUNTS, reportUrl: null });
  });

  it("does not show passed for a same-named status from another creator", async () => {
    const impostor = { login: "someone", id: 1, type: "User" };
    const bodies = threePulls();
    bodies.set(statusesUrl(sha("b")), [
      status({ id: 12, creator: impostor, created_at: "2026-10-19T10:00:00Z", target_url: `${REPORT}-forged` }),
      status({ id: 11, state: "failure", description: "23/28 passed · 5 failed", created_at: "2026-10-19T09:00:00Z" }),
    ]);
    bodies.set(statusesUrl(sha("c")), [
      status({ id: 21, creator: impostor, created_at: "2026-10-19T08:00:00Z" }),
      status({ id: 22, state: "failure", description: "23/28 passed · 5 failed", created_at: "2026-10-19T09:00:00Z" }),
    ]);

    const snapshot = await fetchSnapshot(fakeGitHub(bodies).fetchImpl, null);

    expect(snapshot.prs[1]).toMatchObject({ verdict: "unknown", ...NO_COUNTS, reportUrl: null });
    expect(snapshot.prs[2]).toMatchObject({ verdict: "failed", passed: 23, failed: 5, total: 28 });
  });

  it("fails the whole read on an answer other than 200 or a body over 1 MB", async () => {
    const refused = fakeGitHub(new Map());
    await expect(fetchSnapshot(refused.fetchImpl, null)).rejects.toThrow();
    expect(refused.calls).toHaveLength(1);

    const huge = (async () => new Response(`[${" ".repeat(1024 * 1024)}]`, { status: 200 })) as typeof fetch;
    await expect(fetchSnapshot(huge, null)).rejects.toThrow("too large");
  });
});

describe("readSnapshot", () => {
  const T0 = new Date("2026-10-19T17:42:00.000Z");
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  function sample(): ChecksSnapshot {
    return {
      live: { sha: null, pr: null },
      prs: [
        {
          number: 2,
          title: "Mark as paid, payments list, undo",
          state: "merged",
          headSha: sha("b"),
          verdict: "passed",
          passed: 12,
          failed: 0,
          blocked: 0,
          total: 12,
          reportUrl: REPORT,
          prUrl: "https://github.com/ramakrishnanhulk20/penny/pull/2",
        },
      ],
      fetchedAt: "2000-01-01T00:00:00.000Z",
      stale: false,
    };
  }

  const gitHubDown = async (): Promise<ChecksSnapshot> => {
    throw new Error("GitHub answered 403 for token github_pat_secret");
  };

  // Plays a second instance holding the refresh lock: inside every transaction the lock query answers false.
  function lockHeldElsewhere(db: Db): Db {
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: (tx: Db) => Promise<unknown>) =>
          target.transaction((tx) =>
            run(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name === "execute") return async () => ({ rows: [{ locked: false }] });
                  return Reflect.get(inner, name, innerReceiver);
                },
              }),
            ),
          );
      },
    });
  }

  it("refreshes only when the stored read is older than 15 minutes", async () => {
    const db = await createTestDb();
    const refresh = vi.fn(async () => sample());

    const first = await readSnapshot(db, T0, refresh);
    expect(first).toEqual({ ...sample(), fetchedAt: T0.toISOString() });
    expect(await readSnapshot(db, at(14 * 60 + 59), refresh)).toEqual(first);
    expect(refresh).toHaveBeenCalledTimes(1);

    const second = await readSnapshot(db, at(15 * 60 + 1), refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(second.fetchedAt).toBe(at(15 * 60 + 1).toISOString());
  });

  it("serves the last good read marked stale when a refresh fails, and waits out the window before trying again", async () => {
    const db = await createTestDb();
    const good = await readSnapshot(db, T0, async () => sample());
    const failing = vi.fn(gitHubDown);

    const stale = await readSnapshot(db, at(16 * 60), failing);
    expect(stale).toEqual({ ...good, stale: true });
    expect(await readSnapshot(db, at(30 * 60), failing)).toEqual(stale);
    expect(failing).toHaveBeenCalledTimes(1);

    await readSnapshot(db, at(31 * 60 + 1), failing);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(await readSnapshot(db, at(47 * 60), async () => sample())).toEqual({
      ...sample(),
      fetchedAt: at(47 * 60).toISOString(),
    });
  });

  it("has nothing to serve when the very first read fails", async () => {
    const db = await createTestDb();
    await expect(readSnapshot(db, T0, gitHubDown)).rejects.toThrow();
  });

  it("waits out the window after a failed very first read too, and serves nothing until a good one", async () => {
    const db = await createTestDb();
    const failing = vi.fn(gitHubDown);

    await expect(readSnapshot(db, T0, failing)).rejects.toThrow();
    await expect(readSnapshot(db, at(14 * 60 + 59), failing)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);

    await expect(readSnapshot(db, at(15 * 60), failing)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(await readSnapshot(db, at(30 * 60), async () => sample())).toEqual({
      ...sample(),
      fetchedAt: at(30 * 60).toISOString(),
    });
  });

  it("refreshes once when two reads arrive together (on PGlite)", async () => {
    const db = await createTestDb();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      return sample();
    });

    const first = readSnapshot(db, T0, refresh);
    const second = readSnapshot(db, T0, refresh);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("serves the stored read without refreshing while another instance holds the refresh lock", async () => {
    const db = await createTestDb();
    const good = await readSnapshot(db, T0, async () => sample());
    const refresh = vi.fn(async () => sample());

    expect(await readSnapshot(lockHeldElsewhere(db), at(16 * 60), refresh)).toEqual(good);
    expect(refresh).not.toHaveBeenCalled();
    await expect(readSnapshot(lockHeldElsewhere(await createTestDb()), T0, refresh)).rejects.toThrow();
  });

  it("stores and serves a title that held a lone surrogate as well-formed text", async () => {
    const db = await createTestDb();
    const bodies = threePulls();
    const [newest, ...rest] = bodies.get(LIST_URL) as ReturnType<typeof pull>[];
    bodies.set(LIST_URL, [{ ...newest, title: "Fix \ud800 login" }, ...rest]);
    const refresh = () => fetchSnapshot(fakeGitHub(bodies).fetchImpl, null);

    const served = await readSnapshot(db, T0, refresh);
    const [row] = await db.select().from(checksSnapshot);
    const again = await readSnapshot(db, at(60), refresh);

    expect(served.prs[0].title).toBe("Fix � login");
    expect((row.payload as ChecksSnapshot).prs[0].title).toBe("Fix � login");
    expect(again.prs[0].title).toBe("Fix � login");
  });

  it("names this deployment's commit, with no pull request, when the stored read was made for another one", async () => {
    const db = await createTestDb();
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sha("d"));
    const read = await readSnapshot(db, T0, async () => ({ ...sample(), live: { sha: sha("d"), pr: 2 } }));
    expect(read.live).toEqual({ sha: sha("d"), pr: 2 });

    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sha("e"));
    expect((await readSnapshot(db, at(60), gitHubDown)).live).toEqual({ sha: sha("e"), pr: null });
  });
});

describe("GET /api/checks", () => {
  it("answers 503 with no detail before any good read, asks GitHub once in that window, then 200 once it answers", async () => {
    setDbForTests(await createTestDb());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T17:42:00.000Z"));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("connect ETIMEDOUT api.github.com with github_pat_secret");
    });

    for (let i = 0; i < 2; i += 1) {
      const down = await GET(new Request("http://localhost/api/checks"));
      expect(down.status).toBe(503);
      expect(await down.text()).toBe('{"error":{"code":"unavailable"}}');
      expect(down.headers.get("Cache-Control")).toBe("no-store");
    }
    // The failed refresh stops at the pull request list, so that one call is its whole set.
    expect(calls).toEqual([LIST_URL]);

    vi.setSystemTime(new Date("2026-10-19T17:57:00.000Z"));
    vi.stubGlobal("fetch", fakeGitHub(threePulls()).fetchImpl);
    const up = await GET(new Request("http://localhost/api/checks"));
    expect(up.status).toBe(200);
    const body = (await up.json()) as ChecksSnapshot;
    expect(body.prs.map((pr) => [pr.number, pr.state, pr.verdict])).toEqual([
      [3, "open", "running"],
      [2, "merged", "passed"],
      [1, "closed", "not run"],
    ]);
    expect(body.stale).toBe(false);
  });
});
