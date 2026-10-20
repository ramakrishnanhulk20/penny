import { pathToFileURL } from "node:url";

export const STATUS_CONTEXT = "maintainer-review";
export const REVIEWED_LABEL = "reviewed";
export const MAINTAINER_LOGIN = "ramakrishnanhulk20";
// The numeric id never changes, unlike a login, so a renamed or reused login cannot pass.
export const MAINTAINER_ID = 140826327;
export const ROBOT_LOGIN = "github-actions[bot]";
export const ROBOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
export const SELF_FIX_PREFIX = "self-fix: ";

export const NO_ROBOT = Object.freeze({ state: "success", description: "No robot commits on this pull request" });
export const REVIEWED = Object.freeze({ state: "success", description: "Reviewed by Ram after the last robot commit" });
export const WAITING = Object.freeze({
  state: "pending",
  description: "Waiting for Ram to review the robot's fix (add the reviewed label)",
});

const API_ORIGIN = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_NUMBER = /^[1-9][0-9]{0,9}$/;
const SHA = /^[0-9a-f]{40}$/;
const PAGE_SIZE = 100;
// GitHub stops listing a pull request's commits at 250 without saying so, so a list of 250
// cannot prove it holds the newest commit.
export const PR_COMMIT_LIST_LIMIT = 250;
const MAX_COMMIT_PAGES = Math.ceil(PR_COMMIT_LIST_LIMIT / PAGE_SIZE);
const MAX_EVENT_PAGES = 10;
const MAX_LABEL_PAGES = 2;

// Only full ISO 8601 times with a zone. Date.parse reads a zoneless time as local time, so
// a commit time and an event time would not be compared on the same clock.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class Refusal extends Error {}

function instant(value, what) {
  const time = typeof value === "string" && ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) throw new Refusal(`${what} could not be read`);
  return time;
}

// GitHub treats logins and email addresses without regard to case, so both sides are
// lowercased. Matching more commits as robot commits can only ask for more reviews.
function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

export function isRobotCommit(entry) {
  const message = entry?.commit?.message;
  if (typeof message !== "string") throw new Refusal("a commit has no readable message");
  const authorEmail = entry.commit.author?.email;
  if (typeof authorEmail !== "string") throw new Refusal("a commit has no readable author email");
  return (
    lower(entry.author?.login) === ROBOT_LOGIN ||
    lower(entry.committer?.login) === ROBOT_LOGIN ||
    lower(authorEmail) === ROBOT_EMAIL ||
    message.startsWith(SELF_FIX_PREFIX)
  );
}

function isMaintainer(actor) {
  return actor?.login === MAINTAINER_LOGIN && actor?.id === MAINTAINER_ID;
}

/**
 * Decides the maintainer-review status from a pull request's commits, issue events and
 * current labels, exactly as GitHub's REST API returns them. Throws a Refusal on any shape
 * it cannot read, so the caller posts nothing rather than a guess.
 * @param {{ commits: object[], events: object[], labels: object[] }} input
 * @returns {{ state: "success" | "pending", description: string }}
 */
export function decide({ commits, events, labels }) {
  if (!Array.isArray(commits) || !Array.isArray(events) || !Array.isArray(labels)) {
    throw new Refusal("GitHub sent an unexpected list");
  }

  let lastRobotCommit = -Infinity;
  for (const entry of commits) {
    if (isRobotCommit(entry)) {
      lastRobotCommit = Math.max(lastRobotCommit, instant(entry.commit.committer?.date, "a robot commit's time"));
    }
  }
  if (lastRobotCommit === -Infinity) return NO_ROBOT;

  for (const label of labels) {
    if (typeof label?.name !== "string") throw new Refusal("a label has no readable name");
  }
  // Deleting a label from the repository leaves no unlabeled event behind, so the label's
  // presence right now is checked on its own.
  if (!labels.some((label) => label.name === REVIEWED_LABEL)) return WAITING;

  let review = null;
  const removals = [];
  for (const event of events) {
    if (typeof event?.event !== "string") throw new Refusal("an event has no readable type");
    if (event.event !== "labeled" && event.event !== "unlabeled") continue;
    if (typeof event.label?.name !== "string") throw new Refusal("a label event has no readable label");
    if (event.label.name !== REVIEWED_LABEL) continue;
    const at = instant(event.created_at, "a label event's time");
    if (event.event === "unlabeled") {
      removals.push(at);
    } else if (isMaintainer(event.actor) && at > lastRobotCommit && (review === null || at > review)) {
      review = at;
    }
  }
  if (review === null) return WAITING;
  // Event times have one-second resolution, so a removal in the same second as the review
  // counts as coming after it. Adding the label again recovers.
  if (removals.some((at) => at >= review)) return WAITING;
  return REVIEWED;
}

export function githubApi(token, fetchFn = globalThis.fetch) {
  return async (path, { method = "GET", body } = {}) => {
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) throw new Refusal("refusing to send the token anywhere but the GitHub API");
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "penny-review-gate",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Refusal("a GitHub API call failed");
    }
    if (!response.ok) throw new Refusal(`GitHub API answered ${response.status}`);
    if (method !== "GET") return null;
    try {
      return await response.json();
    } catch {
      throw new Refusal("GitHub sent an answer that is not JSON");
    }
  };
}

async function listPages(api, path, maxPages, what) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await api(`${path}?per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(batch)) throw new Refusal(`GitHub sent an unexpected ${what}`);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  throw new Refusal(`the ${what} is too long to read in full`);
}

function readEnv(env) {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const pr = env.PR_NUMBER ?? "";
  const sha = env.HEAD_SHA ?? "";
  const token = env.GITHUB_TOKEN ?? "";
  if (!REPOSITORY.test(repository)) throw new Refusal("the repository name is unexpected");
  if (!PR_NUMBER.test(pr)) throw new Refusal("the pull request number is unexpected");
  if (!SHA.test(sha)) throw new Refusal("the head commit id is not a full lowercase SHA");
  if (token === "") throw new Refusal("no GitHub token was provided");
  return { repository, pr, sha, token };
}

/**
 * Reads the pull request's commits, issue events and labels, decides, and posts the
 * maintainer-review status on the head commit. Fails closed: on any bad input, API error or
 * unreadable answer it posts nothing and returns 1, and re-running the job recovers.
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, log?: Pick<Console, "log" | "error"> }} [options]
 * @returns {Promise<0 | 1>} the process exit code
 */
export async function main({ env = process.env, fetch: fetchFn = globalThis.fetch, log = console } = {}) {
  try {
    const { repository, pr, sha, token } = readEnv(env);
    const api = githubApi(token, fetchFn);
    const commits = await listPages(api, `/repos/${repository}/pulls/${pr}/commits`, MAX_COMMIT_PAGES, "commit list");
    if (commits.length >= PR_COMMIT_LIST_LIMIT) {
      throw new Refusal("the pull request has too many commits for GitHub to list them all");
    }
    // A list that lags behind the event could miss the newest robot commit and pass.
    if (!commits.some((entry) => entry?.sha === sha)) throw new Refusal("the commit list does not include the head commit");
    const events = await listPages(api, `/repos/${repository}/issues/${pr}/events`, MAX_EVENT_PAGES, "event list");
    const labels = await listPages(api, `/repos/${repository}/issues/${pr}/labels`, MAX_LABEL_PAGES, "label list");
    const decision = decide({ commits, events, labels });
    await api(`/repos/${repository}/statuses/${sha}`, {
      method: "POST",
      body: { state: decision.state, context: STATUS_CONTEXT, description: decision.description },
    });
    log.log(`${decision.state}: ${decision.description}`);
    return 0;
  } catch (error) {
    log.error(`no status posted: ${error instanceof Refusal ? error.message : "an unexpected error stopped the gate"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
