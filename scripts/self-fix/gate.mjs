import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TESTSPRITE_CONTEXT = "TestSprite V3";
// A commit status names the user that posted it, not the app, so the bot's user id is the
// identity to pin. The branch rule pins TestSprite's app id (2756476) separately.
export const TESTSPRITE_BOT_ID = "258111874";
export const MAINTAINER_LOGIN = "ramakrishnanhulk20";
// The numeric id never changes, unlike a login, so a renamed or reused login cannot pass.
export const MAINTAINER_ID = 140826327;
export const DEFAULT_BRANCH = "main";
export const MAX_ATTEMPTS = 2;
export const DAILY_ATTEMPT_CAP = 6;
export const MAX_RUNS_READ = 50;
export const SELF_FIX_PREFIX = "self-fix: ";
export const WORKFLOW_FILE = "self-fix.yml";
export const FIX_JOB = "fix";

const API_ORIGIN = "https://api.github.com";
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Only branch names whose Vercel slug is certain: letters and digits joined by single
// "-" or "/". Anything else would make the preview address a guess.
const BRANCH = /^[A-Za-z0-9]+(?:[/-][A-Za-z0-9]+)*$/;
// A status event's run carries the default branch's head as its head_sha, so the workflow
// names each run after the commit TestSprite tested, and attempts are matched by that name.
const RUN_TITLE = /^self-fix ([0-9a-f]{40})$/;
const DIGITS = /^[1-9][0-9]{0,18}$/;
const DNS_LABEL_MAX = 63;
// GitHub stops listing a pull request's commits at 250.
const PR_COMMIT_LIST_LIMIT = 250;
const PAGE_SIZE = 100;
const MAX_RUN_LIST_PAGES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

class Uncountable extends Error {}

export function skip(reason) {
  return { proceed: false, reason };
}

export function checkEvent({ context, state, senderId, sha }) {
  if (context !== TESTSPRITE_CONTEXT) return "the status is not TestSprite V3";
  if (state !== "failure") return "the status is not a failure";
  if (senderId !== TESTSPRITE_BOT_ID) return "the status was not posted by TestSprite's bot";
  if (typeof sha !== "string" || !SHA.test(sha)) return "the commit id is not a full lowercase SHA";
  return null;
}

export function previewOrigin(branch) {
  if (typeof branch !== "string" || !BRANCH.test(branch)) return null;
  const label = `penny-git-${branch.toLowerCase().replaceAll("/", "-")}-rams-projects-86cea8eb`;
  if (label.length > DNS_LABEL_MAX) return null;
  return `https://${label}.vercel.app`;
}

export function pickPullRequest(pulls, sha) {
  if (!Array.isArray(pulls)) return { reason: "GitHub sent an unexpected list of pull requests" };
  // A full page could hide a second match on the next page, so "exactly one" is unproven.
  if (pulls.length >= PAGE_SIZE) return { reason: "too many pull requests contain this commit" };
  const heads = pulls.filter((pull) => pull?.state === "open" && pull?.head?.sha === sha);
  if (heads.length === 0) return { reason: "no open pull request has this commit as its head" };
  if (heads.length > 1) return { reason: "more than one open pull request has this commit as its head" };
  const number = heads[0].number;
  if (!Number.isSafeInteger(number) || number <= 0) return { reason: "GitHub sent an unexpected pull request number" };
  return { number };
}

export function checkPullRequest(pull, { sha, repository }) {
  if (pull?.state !== "open") return "the pull request is not open";
  if (pull?.head?.sha !== sha) return "the pull request head has moved since TestSprite tested it";
  const baseRepo = pull?.base?.repo;
  const headRepo = pull?.head?.repo;
  if (baseRepo?.full_name !== repository) return "the pull request does not target this repository";
  if (headRepo?.full_name !== repository || headRepo?.id !== baseRepo?.id) {
    return "the pull request branch lives in a fork";
  }
  if (pull?.head?.ref === DEFAULT_BRANCH || pull?.head?.ref === baseRepo?.default_branch) {
    return "the pull request's branch is the default branch";
  }
  if (pull?.user?.login !== MAINTAINER_LOGIN || pull?.user?.id !== MAINTAINER_ID) {
    return "the pull request author is not the maintainer";
  }
  return null;
}

export function countSelfFixCommits(commits) {
  if (!Array.isArray(commits)) throw new Error("unexpected commit list");
  let count = 0;
  for (const entry of commits) {
    const message = entry?.commit?.message;
    if (typeof message !== "string") throw new Error("a commit has no readable message");
    if (message.startsWith(SELF_FIX_PREFIX)) count += 1;
  }
  return count;
}

export function utcDayStart(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function runCommit(run) {
  const match = RUN_TITLE.exec(typeof run?.display_title === "string" ? run.display_title : "");
  return match ? match[1] : null;
}

/**
 * Returns the start time (NaN when unknown) of every fix job in one run's jobs answer that
 * was not skipped. A skipped job still carries a started_at time, so the conclusion is
 * what tells a job that never ran from one that did. Queued and running fix jobs count.
 * @param {{ total_count: number, jobs: object[] }} answer GET /actions/runs/{id}/jobs?filter=all
 * @param {number} [fromAttempt] ignore jobs from this run attempt onward (the run asking)
 */
export function startedFixJobs(answer, fromAttempt = Infinity) {
  if (!answer || !Array.isArray(answer.jobs) || !Number.isSafeInteger(answer.total_count)) {
    throw new Error("unexpected jobs answer");
  }
  if (answer.total_count > answer.jobs.length) throw new Uncountable("a run has too many jobs to read in one page");
  return answer.jobs
    .filter((job) => job?.name === FIX_JOB && job?.conclusion !== "skipped")
    .filter((job) => !(Number.isSafeInteger(job?.run_attempt) && job.run_attempt >= fromAttempt))
    .map((job) => Date.parse(typeof job?.started_at === "string" ? job.started_at : ""));
}

async function listRuns(api, repository, since) {
  const runs = [];
  for (let page = 1; page <= MAX_RUN_LIST_PAGES; page += 1) {
    const query = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page), created: `>=${since}` });
    const answer = await api(`/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?${query}`);
    if (!answer || !Array.isArray(answer.workflow_runs) || !Number.isSafeInteger(answer.total_count)) {
      throw new Error("unexpected run list");
    }
    runs.push(...answer.workflow_runs);
    if (answer.workflow_runs.length < PAGE_SIZE) {
      if (runs.length < answer.total_count) throw new Uncountable("the run list ended before its own count");
      return runs;
    }
  }
  throw new Uncountable("too many runs of this workflow to count attempts");
}

/**
 * Counts self-fix attempts: runs of this workflow whose fix job started, read from each
 * run's jobs. Runs every job of which was skipped are never read. At most MAX_RUNS_READ
 * runs are read; more than that, or a list that cannot be read whole, cannot be counted.
 * @returns {Promise<{ forPullRequest: number, today: number }>}
 */
export async function countAttempts({ api, repository, prCommits, since, now, currentRun }) {
  const todayStart = utcDayStart(now);
  const startedToday = (time) => Number.isNaN(time) || time >= todayStart;
  const runs = await listRuns(api, repository, new Date(since - DAY_MS).toISOString().slice(0, 10));

  const candidates = [];
  for (const run of runs) {
    if (run?.conclusion === "skipped") continue;
    if (!Number.isSafeInteger(run?.id)) throw new Error("a run has no readable id");
    const commit = runCommit(run);
    // A run whose title names no commit cannot be ruled out, so it counts for this pull request.
    const forPullRequest = commit === null || prCommits.has(commit);
    const runStart = Date.parse(run.run_started_at ?? run.created_at);
    if (!forPullRequest && !startedToday(runStart)) continue;
    candidates.push({ run, forPullRequest });
  }
  if (candidates.length > MAX_RUNS_READ) throw new Uncountable("too many self-fix runs to read their jobs");

  let forPullRequest = 0;
  let today = 0;
  for (const candidate of candidates) {
    const fromAttempt = currentRun && candidate.run.id === currentRun.id ? currentRun.attempt : Infinity;
    const jobs = await api(`/repos/${repository}/actions/runs/${candidate.run.id}/jobs?filter=all&per_page=${PAGE_SIZE}`);
    const starts = startedFixJobs(jobs, fromAttempt);
    if (candidate.forPullRequest) forPullRequest += starts.length;
    today += starts.filter(startedToday).length;
  }
  return { forPullRequest, today };
}

async function listPullCommits(api, repository, number) {
  const commits = [];
  for (let page = 1; page <= Math.ceil(PR_COMMIT_LIST_LIMIT / PAGE_SIZE); page += 1) {
    const batch = await api(`/repos/${repository}/pulls/${number}/commits?per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("unexpected commit list");
    commits.push(...batch);
    if (batch.length < PAGE_SIZE) return commits;
  }
  return commits;
}

function readCurrentRun(env) {
  if (!DIGITS.test(env.GITHUB_RUN_ID ?? "") || !DIGITS.test(env.GITHUB_RUN_ATTEMPT ?? "")) return null;
  return { id: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

/**
 * Decides whether the self-fix may act on this status event. Every check fails closed:
 * an unexpected value or any API error means skip.
 * @param {{ env: Record<string, string | undefined>, api: (path: string) => Promise<unknown>, now: Date }} input
 */
export async function decide({ env, api, now }) {
  const sha = env.EVENT_SHA;
  const eventReason = checkEvent({
    context: env.EVENT_CONTEXT,
    state: env.EVENT_STATE,
    senderId: env.EVENT_SENDER_ID,
    sha,
  });
  if (eventReason) return skip(eventReason);
  const statusCreatedAt = Date.parse(env.EVENT_CREATED_AT ?? "");
  if (Number.isNaN(statusCreatedAt)) return skip("the status time could not be read");
  const repository = env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) return skip("the repository name is unexpected");

  try {
    const picked = pickPullRequest(await api(`/repos/${repository}/commits/${sha}/pulls?per_page=${PAGE_SIZE}`), sha);
    if (picked.reason) return skip(picked.reason);

    // The list above can lag; read the pull request itself for its current head.
    const pull = await api(`/repos/${repository}/pulls/${picked.number}`);
    const pullReason = checkPullRequest(pull, { sha, repository });
    if (pullReason) return skip(pullReason);
    const branch = pull.head.ref;
    const origin = previewOrigin(branch);
    if (!origin) return skip("the preview address for this branch name cannot be predicted");
    const openedAt = Date.parse(pull.created_at);
    if (Number.isNaN(openedAt)) return skip("the pull request's opening time could not be read");

    const commits = await listPullCommits(api, repository, picked.number);
    if (commits.length >= PR_COMMIT_LIST_LIMIT) return skip("the pull request has too many commits to count self-fix attempts");
    const head = commits.find((entry) => entry?.sha === sha);
    const headCommittedAt = Date.parse(head?.commit?.committer?.date ?? "");
    if (Number.isNaN(headCommittedAt)) return skip("the head commit's time could not be read");
    const selfFixCommits = countSelfFixCommits(commits);

    const attempts = await countAttempts({
      api,
      repository,
      prCommits: new Set(commits.map((entry) => entry?.sha).filter((value) => typeof value === "string")),
      since: Math.min(openedAt, utcDayStart(now)),
      now,
      currentRun: readCurrentRun(env),
    });
    // A self-fix commit proves an attempt even if its run has aged out of the list.
    const used = Math.max(attempts.forPullRequest, selfFixCommits);
    if (used >= MAX_ATTEMPTS) return skip("this pull request already had two self-fix attempts");
    if (attempts.today >= DAILY_ATTEMPT_CAP) return skip("six self-fix attempts already started today");

    return {
      proceed: true,
      pr: picked.number,
      branch,
      sha,
      attempt: used + 1,
      previewOrigin: origin,
      headCommittedAt: new Date(headCommittedAt).toISOString(),
      statusCreatedAt: new Date(statusCreatedAt).toISOString(),
    };
  } catch (error) {
    return skip(error instanceof Uncountable ? error.message : "a GitHub API call failed");
  }
}

export function formatOutputs(decision) {
  if (!decision.proceed) return "proceed=false\n";
  return [
    "proceed=true",
    `pr=${decision.pr}`,
    `branch=${decision.branch}`,
    `sha=${decision.sha}`,
    `attempt=${decision.attempt}`,
    `preview_origin=${decision.previewOrigin}`,
    `head_committed_at=${decision.headCommittedAt}`,
    `status_created_at=${decision.statusCreatedAt}`,
    "",
  ].join("\n");
}

export function githubApi(token) {
  return async (path) => {
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) throw new Error("refusing to send the token anywhere but the GitHub API");
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "penny-self-fix-gate",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub API answered ${response.status}`);
    return response.json();
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const decision = token
    ? await decide({ env: process.env, api: githubApi(token), now: new Date() })
    : skip("no GitHub token was provided");
  appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(decision));
  if (decision.proceed) {
    console.log(`proceeding: pull request #${decision.pr}, self-fix attempt ${decision.attempt}`);
  } else {
    console.log(`skipped: ${decision.reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
