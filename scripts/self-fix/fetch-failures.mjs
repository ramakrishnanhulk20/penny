import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PROJECT_ID = "36aab7fd-9032-4711-b317-8cb583221099";
export const OUT_DIR = "failures";
export const MAX_LIST_PAGES = 20;
// Bounds how much page text the agent is handed in one run.
export const MAX_BUNDLES = 10;
// A TestSprite execution finishes well inside this, so a run that started earlier than
// two hours before the failing status belongs to some other execution.
export const EVIDENCE_WINDOW_MS = 2 * 60 * 60 * 1000;
const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_OUTPUT = 20 * 1024 * 1024;

// Ids become CLI arguments and folder names, so they must not start with "-" or hold "/" or "..".
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PAGE_TOKEN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const PREVIEW = /^https:\/\/penny-git-[a-z0-9-]+-rams-projects-86cea8eb\.vercel\.app$/;

export class FetchError extends Error {}

export function originOf(value) {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function parseTestPage(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new FetchError("the test list was not valid JSON");
  }
  if (!data || !Array.isArray(data.items)) throw new FetchError("the test list had an unexpected shape");
  const ids = data.items.map((test) => test?.id).filter((id) => typeof id === "string" && ID.test(id));
  const token = data.nextToken;
  if (token === null || token === undefined || token === "") return { ids, next: null };
  if (typeof token !== "string" || !PAGE_TOKEN.test(token)) throw new FetchError("the test list page token was unexpected");
  return { ids, next: token };
}

/**
 * The times a run must start between to count as evidence for this failure: after the
 * tested commit was made, and within EVIDENCE_WINDOW_MS before the failing status.
 */
export function failureWindow(headCommittedAt, statusCreatedAt) {
  const after = Date.parse(typeof headCommittedAt === "string" ? headCommittedAt : "");
  const until = Date.parse(typeof statusCreatedAt === "string" ? statusCreatedAt : "");
  if (Number.isNaN(after) || Number.isNaN(until)) throw new FetchError("the failure window times could not be read");
  return { after, from: until - EVIDENCE_WINDOW_MS, until };
}

function isWindow(window) {
  return Boolean(window) && [window.after, window.from, window.until].every(Number.isFinite);
}

/**
 * Finds the run to fix for one test: among runs against this pull request's preview that
 * started inside the failure window, the newest one, taken only when that run failed. An
 * older failure on the same preview that a newer run already passed is history, not a bug
 * to fix now; a run outside the window tested some other commit.
 * @returns {string | null} the run id, or null when the test is not failing on the preview
 */
export function selectFailingRun(history, preview, window) {
  if (!history || !Array.isArray(history.runs)) throw new FetchError("the run history had an unexpected shape");
  const want = originOf(preview);
  if (!want) throw new FetchError("the preview address is not a URL");
  if (!isWindow(window)) throw new FetchError("no failure window was given");
  let newest = null;
  let newestAt = -Infinity;
  for (const run of history.runs) {
    // Both sides go through the same URL parser before the origins are compared.
    if (originOf(run?.targetUrl) !== want) continue;
    // A run that has not started yet has no start time; its creation time is earlier, so the
    // window check stays at least as strict.
    const at = Date.parse(typeof run?.startedAt === "string" ? run.startedAt : run?.createdAt);
    if (Number.isNaN(at)) continue;
    if (!(at > window.after && at >= window.from && at <= window.until)) continue;
    if (at > newestAt) {
      newest = run;
      newestAt = at;
    }
  }
  if (!newest || newest.status !== "failed") return null;
  return typeof newest.runId === "string" && ID.test(newest.runId) ? newest.runId : null;
}

/**
 * Lists the project's tests, finds each one failing on the preview, and downloads those
 * runs' failure bundles under outDir. Logs counts only: bundle text is untrusted page
 * content and the job log is public.
 * @param {{ runCli: (args: string[]) => Promise<{ code: number, stdout: string }>, preview: string, window: { after: number, from: number, until: number }, outDir?: string, log?: (line: string) => void }} input
 */
export async function collectFailures({ runCli, preview, window, outDir = OUT_DIR, log = console.log }) {
  if (typeof preview !== "string" || !PREVIEW.test(preview)) throw new FetchError("the preview address is unexpected");
  if (!isWindow(window)) throw new FetchError("no failure window was given");

  const testIds = new Set();
  let token = null;
  let pages = 0;
  do {
    if (pages === MAX_LIST_PAGES) throw new FetchError("the test list has too many pages");
    const args = ["test", "list", "--project", PROJECT_ID, "--output", "json"];
    if (token) args.push(`--starting-token=${token}`);
    const listed = await runCli(args);
    if (listed.code !== 0) throw new FetchError(`testsprite test list exited with code ${listed.code}`);
    const page = parseTestPage(listed.stdout);
    for (const id of page.ids) testIds.add(id);
    token = page.next;
    pages += 1;
  } while (token);

  const failing = [];
  let unreadable = 0;
  for (const testId of testIds) {
    const result = await runCli(["test", "result", testId, "--history", "--page-size", "10", "--output", "json"]);
    if (result.code !== 0) {
      unreadable += 1;
      continue;
    }
    let runId;
    try {
      runId = selectFailingRun(JSON.parse(result.stdout), preview, window);
    } catch {
      unreadable += 1;
      continue;
    }
    if (runId) failing.push({ testId, runId });
  }

  let fetched = 0;
  const chosen = failing.slice(0, MAX_BUNDLES);
  if (chosen.length > 0) mkdirSync(outDir, { recursive: true });
  for (const { testId, runId } of chosen) {
    const got = await runCli(["test", "artifact", "get", runId, "--failed-only", "--out", `${outDir}/${testId}`]);
    if (got.code === 0) fetched += 1;
  }

  log(`${testIds.size} tests listed, ${failing.length} failing on the preview, ${fetched} bundles fetched`);
  if (unreadable > 0) log(`${unreadable} tests had a run history that could not be read`);
  return { listed: testIds.size, failing: failing.length, fetched };
}

function runTestsprite(args) {
  return new Promise((resolve) => {
    execFile(
      "testsprite",
      args,
      { shell: false, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_OUTPUT, windowsHide: true },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout: String(stdout) });
        resolve({ code: typeof error.code === "number" ? error.code : 1, stdout: "" });
      },
    );
  });
}

async function main() {
  let found = false;
  try {
    const window = failureWindow(process.env.HEAD_COMMITTED_AT, process.env.STATUS_CREATED_AT);
    const { fetched } = await collectFailures({ runCli: runTestsprite, preview: process.env.PREVIEW_ORIGIN, window });
    found = fetched > 0;
  } catch (error) {
    // Only this file's own fixed messages are printed; never CLI or bundle text.
    console.log(`could not collect failures: ${error instanceof FetchError ? error.message : "unexpected error"}`);
    process.exitCode = 1;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `found=${found}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
