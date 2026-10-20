import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { checksSnapshot } from "@/db/schema";

export type Verdict = "passed" | "failed" | "blocked" | "running" | "not run" | "unknown";
export type PrCheck = {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  headSha: string;
  verdict: Verdict;
  passed: number | null;
  failed: number | null;
  blocked: number | null;
  total: number | null;
  reportUrl: string | null;
  prUrl: string;
};
export type ChecksSnapshot = {
  live: { sha: string | null; pr: number | null };
  prs: PrCheck[];
  fetchedAt: string;
  stale: boolean;
};

type Counts = Pick<PrCheck, "passed" | "failed" | "blocked" | "total">;
type VerdictCounts = Pick<PrCheck, "verdict" | "passed" | "failed" | "blocked" | "total">;
type TestSpriteResult = VerdictCounts & Pick<PrCheck, "reportUrl">;

const GITHUB_API_ORIGIN = "https://api.github.com";
const REPO = "ramakrishnanhulk20/penny";
const REPORT_ORIGIN = "https://www.testsprite.com";
const STATUS_CONTEXT = "TestSprite V3";
// testsprite[bot], the user that TestSprite's GitHub App (id 2756476) posts statuses as. Anyone with push access can
// post a status with the same context name, so the creator id is the identity, never the name (threat model C22).
const TESTSPRITE_BOT_ID = 258111874;
// ramakrishnanhulk20, the account that owns the repository. Only pull requests it opened are listed, so a stranger's
// title never reaches the page and a stranger's twelve new pull requests cannot push the owner's out of view. The id,
// never the login, because a login can be renamed and taken over; an id cannot.
const OWNER_ID = 140826327;
// Read before the owner filter, so stranger pull requests in between still leave the owner's newest twelve in view.
const PULLS_PER_PAGE = 50;
const PR_LIMIT = 12;
// Statuses come newest first, so the first page holds the newest TestSprite one; later pages are never fetched.
const STATUSES_PER_PAGE = 100;
const CALL_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REFRESH_EVERY_MS = 15 * 60 * 1000;
const SNAPSHOT_ID = 1;
// Any fixed number works as long as nothing else in this database locks it; this is "penny" in ASCII.
const REFRESH_LOCK_KEY = 0x70656e6e79;
const SHA_FORMAT = /^[0-9a-f]{40}$/;
// GitHub caps a pull request title at 256 characters; the cap holds even if a response says otherwise.
const TITLE_MAX = 256;
const REPORT_URL_MAX = 2048;
// One Unicode category test, as in lib/text.ts: Cc and Cf cover every control, bidi override and zero-width
// character a title could use to disguise itself. It does not catch lookalike letters.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

const NO_COUNTS: Counts = { passed: null, failed: null, blocked: null, total: null };
const UNKNOWN: VerdictCounts = { verdict: "unknown", ...NO_COUNTS };

// Plain ASCII digits only (no u flag, so \d is [0-9]), at most six of them, and the exact wording TestSprite writes.
// The separator is U+00B7, a middle dot.
const QUEUED = /^(\d{1,6}) tests? queued$/;
const ALL_PASSED = /^All (\d{1,6}) tests? passed$/;
const SOME_PASSED = /^(\d{1,6})\/(\d{1,6}) passed(?: · (\d{1,6}) failed)?(?: · (\d{1,6}) blocked)?$/;

type Description =
  | { readonly kind: "queued"; readonly total: number }
  | { readonly kind: "result"; readonly passed: number; readonly failed: number; readonly blocked: number; readonly total: number };

function readDescription(text: string): Description | null {
  const queued = QUEUED.exec(text);
  if (queued !== null) {
    const total = Number(queued[1]);
    return total > 0 ? { kind: "queued", total } : null;
  }
  const all = ALL_PASSED.exec(text);
  if (all !== null) {
    const total = Number(all[1]);
    return total > 0 ? { kind: "result", passed: total, failed: 0, blocked: 0, total } : null;
  }
  const some = SOME_PASSED.exec(text);
  if (some !== null) {
    const passed = Number(some[1]);
    const total = Number(some[2]);
    const failed = Number(some[3] ?? "0");
    const blocked = Number(some[4] ?? "0");
    // A missing "failed" or "blocked" is read as 0 only because the parts must then add up to the total. Counts that
    // do not add up mean the wording was misread, and a misread count is never shown.
    if (total > 0 && passed + failed + blocked === total) return { kind: "result", passed, failed, blocked, total };
  }
  return null;
}

/**
 * Turns one TestSprite commit status into a verdict and its counts.
 * "passed" needs state `success` and a result that reports no failed test and at least one passed. A `success` where
 * no test passed and some were blocked is "blocked": TestSprite marked it green, but nothing was shown to work.
 * `failure` or `error` is "failed", and
 * `pending` is "running", each only with a description in a known shape. Anything else, a description in no known
 * shape, or one that contradicts its state (a success that lists failures, a failure where every test passed) is
 * "unknown" with every count null, never 0. The caller decides "not run" and checks who created the status.
 */
export function parseVerdict(
  state: string,
  description: string,
): Pick<PrCheck, "verdict" | "passed" | "failed" | "blocked" | "total"> {
  const read = readDescription(description);
  if (read === null) return UNKNOWN;
  const counts: Counts =
    read.kind === "result"
      ? { passed: read.passed, failed: read.failed, blocked: read.blocked, total: read.total }
      : { ...NO_COUNTS, total: read.total };
  switch (state) {
    case "success":
      if (read.kind !== "result" || read.failed !== 0) return UNKNOWN;
      if (read.passed === 0 && read.blocked > 0) return { verdict: "blocked", ...counts };
      return { verdict: "passed", ...counts };
    case "failure":
    case "error":
      return read.kind === "result" && read.passed === read.total ? UNKNOWN : { verdict: "failed", ...counts };
    case "pending":
      return { verdict: "running", ...counts };
    default:
      return UNKNOWN;
  }
}

/**
 * The TestSprite report link, or null. Accepts only a string that the WHATWG URL parser reads as https on
 * www.testsprite.com, default port, with no user or password. One origin comparison covers the scheme, every other
 * host (lookalikes such as www.testsprite.com.example included) and every port; it does not judge the path.
 * Returns the parser's own serialisation, so what is checked is exactly what is linked.
 */
export function safeReportUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > REPORT_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== REPORT_ORIGIN || url.username !== "" || url.password !== "") return null;
  return url.href;
}

function prUrlFor(number: number): string {
  return `https://github.com/${REPO}/pull/${number}`;
}

// Upstream text cannot be refused the way a typed name can, so the disguising characters are dropped instead. A lone
// surrogate (a JSON escape can carry one) becomes U+FFFD first: Postgres refuses it in jsonb, which would fail the save.
function plainTitle(raw: string): string {
  return [...raw.toWellFormed().replace(CONTROL_OR_FORMAT, "").normalize("NFC").trim()].slice(0, TITLE_MAX).join("");
}

function runningCommit(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return sha !== undefined && SHA_FORMAT.test(sha) ? sha : null;
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("checks: response refused");
  }
  // Counted as the bytes arrive, after any decompression, so a small compressed body cannot unpack past the cap.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("checks: response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function getJson(fetchImpl: typeof fetch, url: URL, token: string | null): Promise<unknown> {
  // Every URL here is built from fixed parts, but the check sits next to the header so the token can never be
  // attached for another origin (threat model C20).
  if (url.origin !== GITHUB_API_ORIGIN) throw new Error("checks: refused origin");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "penny-checks",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url.href, {
    headers,
    // Following a redirect would send the request, token included, to a URL GitHub chose. It fails the read instead.
    redirect: "error",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    cache: "no-store",
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("checks: GitHub did not answer 200");
  }
  return JSON.parse(await readCapped(response));
}

function pullListUrl(): URL {
  const url = new URL(`/repos/${REPO}/pulls`, GITHUB_API_ORIGIN);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "created");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(PULLS_PER_PAGE));
  return url;
}

// sha has already passed SHA_FORMAT, so the path is fixed text plus 40 hex digits.
function statusesUrl(sha: string): URL {
  const url = new URL(`/repos/${REPO}/commits/${sha}/statuses`, GITHUB_API_ORIGIN);
  url.searchParams.set("per_page", String(STATUSES_PER_PAGE));
  return url;
}

const pullListSchema = z.array(
  z.object({
    number: z.int().positive(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    merged_at: z.string().nullable(),
    merge_commit_sha: z.string().nullable(),
    head: z.object({ sha: z.string().regex(SHA_FORMAT) }),
    // GitHub sends null for an account that has since been deleted; such a pull request is never the owner's.
    user: z.object({ id: z.int() }).nullable(),
  }),
);

type Pull = z.infer<typeof pullListSchema>[number];

const statusSchema = z.object({
  id: z.int(),
  state: z.string(),
  description: z.string().nullable(),
  target_url: z.string().nullable(),
  context: z.string(),
  created_at: z.iso.datetime(),
  creator: z.object({ id: z.int() }).nullable(),
});

type Status = z.infer<typeof statusSchema>;

function isNewer(a: Status, b: Status): boolean {
  const at = Date.parse(a.created_at);
  const bt = Date.parse(b.created_at);
  return at === bt ? a.id > b.id : at > bt;
}

function testSpriteResult(statuses: unknown): TestSpriteResult {
  if (!Array.isArray(statuses)) return { ...UNKNOWN, reportUrl: null };
  let newest: Status | null = null;
  for (const item of statuses.slice(0, STATUSES_PER_PAGE)) {
    if (typeof item !== "object" || item === null || !("context" in item) || item.context !== STATUS_CONTEXT) continue;
    const status = statusSchema.safeParse(item);
    // An unreadable TestSprite status could be the newest one, and skipping it could bring an older pass forward.
    if (!status.success) return { ...UNKNOWN, reportUrl: null };
    if (newest === null || isNewer(status.data, newest)) newest = status.data;
  }
  if (newest === null) return { verdict: "not run", ...NO_COUNTS, reportUrl: null };
  if (newest.creator?.id !== TESTSPRITE_BOT_ID) return { ...UNKNOWN, reportUrl: null };
  return { ...parseVerdict(newest.state, newest.description ?? ""), reportUrl: safeReportUrl(newest.target_url) };
}

function prState(pull: Pull): PrCheck["state"] {
  if (pull.state === "open") return "open";
  return pull.merged_at === null ? "closed" : "merged";
}

/**
 * Reads the 50 newest pull requests of the Penny repository, keeps the ones the owner's account opened, and reads the
 * TestSprite verdict on the head commit of the 12 newest of those, live from the GitHub API, in at most 13 calls. The
 * running commit comes from VERCEL_GIT_COMMIT_SHA and its pull request from the owner's merged PR whose merge commit it
 * is. The token, when given, is sent to api.github.com only.
 * Throws when any call fails, times out after 5 s, answers anything but 200, redirects, sends more than 1 MB or sends
 * a pull request list in an unexpected shape. Pagination links are never followed.
 */
export async function fetchSnapshot(fetchImpl: typeof fetch, token: string | null): Promise<ChecksSnapshot> {
  const pulls = pullListSchema
    .parse(await getJson(fetchImpl, pullListUrl(), token))
    .filter((pull) => pull.user?.id === OWNER_ID)
    .sort((a, b) => b.number - a.number)
    .slice(0, PR_LIMIT);
  const statuses = await Promise.all(pulls.map((pull) => getJson(fetchImpl, statusesUrl(pull.head.sha), token)));
  const prs = pulls.map(
    (pull, index): PrCheck => ({
      number: pull.number,
      title: plainTitle(pull.title),
      state: prState(pull),
      headSha: pull.head.sha,
      ...testSpriteResult(statuses[index]),
      prUrl: prUrlFor(pull.number),
    }),
  );
  const sha = runningCommit();
  const livePull = sha === null ? undefined : pulls.find((pull) => pull.merged_at !== null && pull.merge_commit_sha === sha);
  return { live: { sha, pr: livePull?.number ?? null }, prs, fetchedAt: new Date().toISOString(), stale: false };
}

const countSchema = z.int().nonnegative().nullable();

const storedSnapshotSchema = z.object({
  live: z.object({ sha: z.string().regex(SHA_FORMAT).nullable(), pr: z.int().positive().nullable() }),
  prs: z
    .array(
      z.object({
        number: z.int().positive(),
        title: z.string(),
        state: z.enum(["open", "merged", "closed"]),
        headSha: z.string().regex(SHA_FORMAT),
        verdict: z.enum(["passed", "failed", "blocked", "running", "not run", "unknown"]),
        passed: countSchema,
        failed: countSchema,
        blocked: countSchema,
        total: countSchema,
        reportUrl: z.string().nullable(),
        prUrl: z.string(),
      }),
    )
    .max(PR_LIMIT),
  fetchedAt: z.iso.datetime(),
  stale: z.boolean(),
});

// A stored row is read back as untrusted: its shape is checked and every link and title is rebuilt by the same
// functions that made them, so an old or altered row cannot put a different link on the page.
function readStoredPayload(payload: unknown): ChecksSnapshot | null {
  const parsed = storedSnapshotSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    prs: parsed.data.prs.map((pr) => ({
      ...pr,
      title: plainTitle(pr.title),
      reportUrl: safeReportUrl(pr.reportUrl),
      prUrl: prUrlFor(pr.number),
    })),
  };
}

// Stored when a refresh fails before there has ever been a good read, so the next try still waits out the window. It
// fails storedSnapshotSchema like any unreadable payload, so it is never served.
const NO_GOOD_READ = { noGoodRead: true };

// `snapshot` is null when the row holds no good read (the placeholder, or a payload that fails its checks); its time
// still paces the next refresh.
type Stored = { readonly snapshot: ChecksSnapshot | null; readonly triedAt: Date };

async function loadStored(db: Db): Promise<Stored | null> {
  const [row] = await db.select().from(checksSnapshot).where(eq(checksSnapshot.id, SNAPSHOT_ID));
  if (row === undefined) return null;
  return { snapshot: readStoredPayload(row.payload), triedAt: row.fetchedAt };
}

// A row stamped in the future (a server with a fast clock) counts as due, so a bad clock cannot freeze the page.
function isFresh(triedAt: Date, now: Date): boolean {
  const age = now.getTime() - triedAt.getTime();
  return age >= 0 && age < REFRESH_EVERY_MS;
}

const lockAnswer = z.object({ rows: z.tuple([z.object({ locked: z.boolean() })]) });

async function takeRefreshLock(tx: Db): Promise<boolean> {
  const answer = lockAnswer.safeParse(
    await tx.execute(sql`select pg_try_advisory_xact_lock(${REFRESH_LOCK_KEY}::bigint) as locked`),
  );
  return answer.success && answer.data.rows[0].locked;
}

async function saveSnapshot(tx: Db, payload: ChecksSnapshot | typeof NO_GOOD_READ, now: Date): Promise<void> {
  await tx
    .insert(checksSnapshot)
    .values({ id: SNAPSHOT_ID, payload, fetchedAt: now })
    .onConflictDoUpdate({ target: checksSnapshot.id, set: { payload, fetchedAt: now } });
}

// The row is shared by every deployment on this database, so just after a deploy it still names the commit the
// previous deployment read. This instance knows its own commit; until the next refresh its pull request is unknown.
function forThisDeployment(snapshot: ChecksSnapshot): ChecksSnapshot {
  const sha = runningCommit();
  return snapshot.live.sha === sha ? snapshot : { ...snapshot, live: { sha, pr: null } };
}

/**
 * The one shared snapshot, refreshed through `refresh` at most once per 15 minutes across every instance.
 * A stored row younger than 15 minutes is served as it is. Otherwise one transaction takes
 * pg_try_advisory_xact_lock: the instance that gets it refreshes and stores the result, stamped with `now`; an
 * instance that does not serves the stored row. When the refresh throws, the last good read is served and stored
 * with stale: true and its original fetchedAt, and the try still counts, so GitHub is not asked again for 15 minutes.
 * With no good read yet, a failed refresh stores a placeholder stamped with `now`, which paces the next try the same
 * way and is never served.
 * Throws when there has never been a good read, or when the database fails.
 */
export async function readSnapshot(
  db: Db,
  now: Date,
  refresh: () => Promise<ChecksSnapshot>,
): Promise<ChecksSnapshot> {
  const stored = await loadStored(db);
  if (stored !== null && isFresh(stored.triedAt, now)) {
    if (stored.snapshot === null) throw new Error("checks: no good read yet");
    return forThisDeployment(stored.snapshot);
  }

  const refreshed = await db.transaction(async (tx) => {
    // The lock ends with this transaction, so a refresh that crashes cannot hold it.
    if (!(await takeRefreshLock(tx))) return null;
    // Another instance may have finished a refresh between the read above and taking the lock.
    const current = await loadStored(tx);
    if (current !== null && isFresh(current.triedAt, now)) return current.snapshot;
    let next: ChecksSnapshot;
    try {
      next = { ...(await refresh()), fetchedAt: now.toISOString(), stale: false };
    } catch {
      if (current === null || current.snapshot === null) {
        await saveSnapshot(tx, NO_GOOD_READ, now);
        return null;
      }
      next = { ...current.snapshot, stale: true };
    }
    await saveSnapshot(tx, next, now);
    return next;
  });

  const snapshot = refreshed ?? stored?.snapshot ?? null;
  if (snapshot === null) throw new Error("checks: no good read yet");
  return forThisDeployment(snapshot);
}
