// Not covered here: the real GitHub API, the pull_request event payload, the workflow file
// and the branch rule that makes the status required. These tests drive review-gate.mjs with
// fake API answers only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_ROBOT, REVIEWED, Refusal, WAITING, decide, githubApi, isRobotCommit, main } from "./review-gate.mjs";

const HEAD_SHA = "0eeb9362c0327a4a717e7ba26ffe20ca7747717e";
const ROBOT_SHA = "95542cf39d62b2c274747fb99895f7e47f93138a";
const EARLIER_SHA = "a7324e235cff24fffbbf06c8a0d4c1668967b55b";
const REPO = "ramakrishnanhulk20/penny";
const PR = "12";
const RAM = { login: "ramakrishnanhulk20", id: 140826327 };
const ROBOT_TIME = "2026-10-20T10:00:00Z";

function humanCommit({ sha = HEAD_SHA, message = "rates: ECB prefill", date = "2026-10-20T09:00:00Z" } = {}) {
  return {
    sha,
    author: RAM,
    committer: RAM,
    commit: {
      message,
      author: { name: "Ram", email: "ramakrishnanhulk20@gmail.com", date },
      committer: { name: "Ram", email: "ramakrishnanhulk20@gmail.com", date },
    },
  };
}

function robotCommit({ sha = ROBOT_SHA, date = ROBOT_TIME } = {}) {
  const bot = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com", date };
  return {
    sha,
    author: { login: "github-actions[bot]", id: 41898282 },
    committer: { login: "github-actions[bot]", id: 41898282 },
    commit: { message: "self-fix: attempt 1 for the TestSprite failure on 0eeb936", author: bot, committer: bot },
  };
}

function labelEvent(event, createdAt, { actor = RAM, name = "reviewed" } = {}) {
  return { id: Date.parse(createdAt), event, actor, created_at: createdAt, label: { name, color: "0e8a16" } };
}

const REVIEWED_LABELS = [{ name: "reviewed" }];

test("a pull request with no robot commits passes, whatever its labels", () => {
  assert.deepEqual(decide({ commits: [humanCommit()], events: [], labels: [] }), NO_ROBOT);
  assert.equal(NO_ROBOT.state, "success");
  assert.equal(NO_ROBOT.description, "No robot commits on this pull request");
});

test("a robot commit with no reviewed label waits for Ram", () => {
  const decision = decide({ commits: [humanCommit(), robotCommit()], events: [], labels: [] });
  assert.deepEqual(decision, WAITING);
  assert.equal(WAITING.state, "pending");
  assert.equal(WAITING.description, "Waiting for Ram to review the robot's fix (add the reviewed label)");
});

test("Ram's label from before the last robot commit does not count", () => {
  const events = [labelEvent("labeled", "2026-10-20T09:30:00Z")];
  assert.deepEqual(decide({ commits: [humanCommit(), robotCommit()], events, labels: REVIEWED_LABELS }), WAITING);
});

test("Ram's label in the same second as the last robot commit does not count", () => {
  const events = [labelEvent("labeled", ROBOT_TIME)];
  assert.deepEqual(decide({ commits: [robotCommit()], events, labels: REVIEWED_LABELS }), WAITING);
});

test("Ram's label after the last robot commit passes", () => {
  const events = [labelEvent("labeled", "2026-10-20T10:05:00Z")];
  const decision = decide({ commits: [humanCommit(), robotCommit()], events, labels: REVIEWED_LABELS });
  assert.deepEqual(decision, REVIEWED);
  assert.equal(REVIEWED.state, "success");
  assert.equal(REVIEWED.description, "Reviewed by Ram after the last robot commit");
});

test("the newest robot commit is the one the label must follow", () => {
  const commits = [robotCommit({ date: "2026-10-20T08:00:00Z" }), robotCommit({ sha: HEAD_SHA, date: ROBOT_TIME })];
  const events = [labelEvent("labeled", "2026-10-20T09:00:00Z")];
  // GitHub's list order is not a promise about commit times, so both orders are checked.
  for (const order of [commits, [...commits].reverse()]) {
    assert.deepEqual(decide({ commits: order, events, labels: REVIEWED_LABELS }), WAITING);
  }
});

test("a label after the last robot commit by anyone but Ram does not count", () => {
  const others = [
    { login: "someone-else", id: 5 },
    { login: "ramakrishnanhulk20", id: 5 },
    { login: "someone-else", id: 140826327 },
    { login: "github-actions[bot]", id: 41898282 },
    { login: "RamaKrishnanHulk20", id: 140826327 },
    null,
  ];
  for (const actor of others) {
    const events = [labelEvent("labeled", "2026-10-20T10:05:00Z", { actor })];
    assert.deepEqual(decide({ commits: [robotCommit()], events, labels: REVIEWED_LABELS }), WAITING, JSON.stringify(actor));
  }
});

test("a label added after the last robot commit and then removed does not count", () => {
  const events = [labelEvent("labeled", "2026-10-20T10:05:00Z"), labelEvent("unlabeled", "2026-10-20T10:06:00Z")];
  assert.deepEqual(decide({ commits: [robotCommit()], events, labels: [] }), WAITING);
});

test("a removal after Ram's label counts even if the label is back from someone else", () => {
  const events = [
    labelEvent("labeled", "2026-10-20T10:05:00Z"),
    labelEvent("unlabeled", "2026-10-20T10:06:00Z", { actor: { login: "someone-else", id: 5 } }),
    labelEvent("labeled", "2026-10-20T10:07:00Z", { actor: { login: "someone-else", id: 5 } }),
  ];
  assert.deepEqual(decide({ commits: [robotCommit()], events, labels: REVIEWED_LABELS }), WAITING);
});

test("a removal in the same second as Ram's label counts as after it", () => {
  const events = [labelEvent("labeled", "2026-10-20T10:05:00Z"), labelEvent("unlabeled", "2026-10-20T10:05:00Z")];
  assert.deepEqual(decide({ commits: [robotCommit()], events, labels: REVIEWED_LABELS }), WAITING);
});

test("Ram adding the label again after a removal passes", () => {
  const events = [
    labelEvent("labeled", "2026-10-20T10:05:00Z"),
    labelEvent("unlabeled", "2026-10-20T10:06:00Z"),
    labelEvent("labeled", "2026-10-20T10:07:00Z"),
  ];
  assert.deepEqual(decide({ commits: [robotCommit()], events, labels: REVIEWED_LABELS }), REVIEWED);
});

test("a label event for another label, or for a label no longer on the pull request, never passes", () => {
  const otherLabel = [labelEvent("labeled", "2026-10-20T10:05:00Z", { name: "Reviewed" })];
  assert.deepEqual(decide({ commits: [robotCommit()], events: otherLabel, labels: REVIEWED_LABELS }), WAITING);
  const deletedLabel = [labelEvent("labeled", "2026-10-20T10:05:00Z")];
  assert.deepEqual(decide({ commits: [robotCommit()], events: deletedLabel, labels: [{ name: "bug" }] }), WAITING);
});

test("a robot commit is found by its message prefix alone", () => {
  const commits = [humanCommit({ message: "self-fix: attempt 1 for the TestSprite failure on 0eeb936" })];
  assert.equal(isRobotCommit(commits[0]), true);
  assert.deepEqual(decide({ commits, events: [], labels: [] }), WAITING);
  for (const message of ["Self-fix: attempt 1", "fix: self-fix: x", "self-fix:attempt"]) {
    assert.equal(isRobotCommit(humanCommit({ message })), false, message);
  }
});

test("a robot commit is found by its author login, committer login or author email alone", () => {
  const byAuthor = { ...humanCommit(), author: { login: "github-actions[bot]", id: 41898282 } };
  const byCommitter = { ...humanCommit(), committer: { login: "github-actions[bot]", id: 41898282 } };
  const plain = humanCommit();
  const byEmail = {
    ...plain,
    author: null,
    committer: null,
    commit: { ...plain.commit, author: { ...plain.commit.author, email: "41898282+GitHub-Actions[bot]@users.noreply.github.com" } },
  };
  for (const entry of [byAuthor, byCommitter, byEmail]) assert.equal(isRobotCommit(entry), true);
  assert.equal(isRobotCommit({ ...plain, author: null, committer: null }), false);
});

test("anything GitHub sends that cannot be read is refused, never guessed", () => {
  const robot = robotCommit();
  const undated = { ...robot, commit: { ...robot.commit, committer: { ...robot.commit.committer, date: "2026-10-20 10:00:00" } } };
  const cases = [
    { commits: null, events: [], labels: [] },
    { commits: [{ sha: HEAD_SHA, commit: {} }], events: [], labels: [] },
    { commits: [{ ...robot, commit: { ...robot.commit, author: null } }], events: [], labels: [] },
    { commits: [undated], events: [], labels: [] },
    { commits: [robot], events: [], labels: [{}] },
    { commits: [robot], events: [{}], labels: REVIEWED_LABELS },
    { commits: [robot], events: [{ event: "labeled", created_at: "2026-10-20T10:05:00Z" }], labels: REVIEWED_LABELS },
    { commits: [robot], events: [labelEvent("labeled", "2026-10-20T10:05:00")], labels: REVIEWED_LABELS },
  ];
  for (const input of cases) assert.throws(() => decide(input), Refusal);
});

const ENV = { GITHUB_REPOSITORY: REPO, PR_NUMBER: PR, HEAD_SHA, GITHUB_TOKEN: "token-value" };
const AFTER_ROBOT = "2026-10-20T10:05:00Z";

function pageOf(list, url) {
  const page = Number(url.searchParams.get("page") ?? "1");
  const size = Number(url.searchParams.get("per_page") ?? "30");
  return list.slice((page - 1) * size, page * size);
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

// Serves the three lists the way GitHub does, including its silent cut at 250 commits.
function fakeFetch({
  commits = [humanCommit({ sha: EARLIER_SHA }), robotCommit({ sha: HEAD_SHA })],
  events = [],
  labels = [],
  failOn,
  answers = {},
  postStatus = 201,
} = {}) {
  const calls = [];
  const fetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      page: url.searchParams.get("page"),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      authorization: init.headers?.Authorization,
      redirect: init.redirect,
    });
    if (failOn && url.pathname.endsWith(failOn)) return json(502, { message: "Bad Gateway" });
    for (const [suffix, answer] of Object.entries(answers)) {
      if (url.pathname.endsWith(suffix)) return answer();
    }
    if (method === "GET" && url.pathname === `/repos/${REPO}/pulls/${PR}/commits`) return json(200, pageOf(commits.slice(0, 250), url));
    if (method === "GET" && url.pathname === `/repos/${REPO}/issues/${PR}/events`) return json(200, pageOf(events, url));
    if (method === "GET" && url.pathname === `/repos/${REPO}/issues/${PR}/labels`) return json(200, pageOf(labels, url));
    if (method === "POST" && url.pathname === `/repos/${REPO}/statuses/${HEAD_SHA}`) return json(postStatus, {});
    return json(404, { message: "Not Found" });
  };
  fetchFn.calls = calls;
  fetchFn.posts = () => calls.filter((call) => call.method !== "GET");
  return fetchFn;
}

function quietLog() {
  const lines = [];
  const keep = (line) => lines.push(line);
  return { lines, log: keep, error: keep };
}

async function run(fetchOptions, env = ENV) {
  const fetchFn = fakeFetch(fetchOptions);
  const log = quietLog();
  const code = await main({ env, fetch: fetchFn, log });
  return { code, fetchFn, lines: log.lines };
}

test("main posts the decision as the maintainer-review status on the head commit", async () => {
  const { code, fetchFn } = await run({ events: [labelEvent("labeled", AFTER_ROBOT)], labels: REVIEWED_LABELS });
  assert.equal(code, 0);
  assert.deepEqual(fetchFn.posts(), [
    {
      method: "POST",
      path: `/repos/${REPO}/statuses/${HEAD_SHA}`,
      page: null,
      body: { state: "success", context: "maintainer-review", description: "Reviewed by Ram after the last robot commit" },
      authorization: "Bearer token-value",
      redirect: "error",
    },
  ]);
});

test("main posts pending for a robot commit with no label, and success for a pull request without one", async () => {
  const waiting = await run({});
  assert.equal(waiting.code, 0);
  assert.deepEqual(waiting.fetchFn.posts()[0].body, { context: "maintainer-review", ...WAITING });
  const plain = await run({ commits: [humanCommit()] });
  assert.equal(plain.code, 0);
  assert.deepEqual(plain.fetchFn.posts()[0].body, { context: "maintainer-review", ...NO_ROBOT });
});

test("main reads every page of the events before deciding", async () => {
  const noise = Array.from({ length: 150 }, (_, n) => ({ id: n, event: "referenced", created_at: "2026-10-20T09:00:00Z" }));
  const { code, fetchFn } = await run({ events: [...noise, labelEvent("labeled", AFTER_ROBOT)], labels: REVIEWED_LABELS });
  assert.equal(code, 0);
  assert.equal(fetchFn.posts()[0].body.description, REVIEWED.description);
  assert.deepEqual(
    fetchFn.calls.filter((call) => call.path.endsWith("/events")).map((call) => call.page),
    ["1", "2"],
  );
});

test("a pull request with 251 commits is refused and nothing is posted", async () => {
  const older = Array.from({ length: 250 }, (_, n) => humanCommit({ sha: n.toString(16).padStart(40, "0") }));
  const { code, fetchFn, lines } = await run({ commits: [...older, robotCommit({ sha: HEAD_SHA })] });
  assert.equal(code, 1);
  assert.deepEqual(fetchFn.posts(), []);
  assert.deepEqual(lines, ["no status posted: the pull request has too many commits for GitHub to list them all"]);
});

test("an event list longer than ten pages is refused and nothing is posted", async () => {
  const events = Array.from({ length: 1000 }, (_, n) => ({ id: n, event: "referenced", created_at: "2026-10-20T09:00:00Z" }));
  const { code, fetchFn, lines } = await run({ events, labels: REVIEWED_LABELS });
  assert.equal(code, 1);
  assert.deepEqual(fetchFn.posts(), []);
  assert.deepEqual(lines, ["no status posted: the event list is too long to read in full"]);
});

test("an API error on any read exits 1 without posting success", async () => {
  const events = [labelEvent("labeled", AFTER_ROBOT)];
  for (const failOn of ["/commits", "/events", "/labels"]) {
    const { code, fetchFn, lines } = await run({ events, labels: REVIEWED_LABELS, failOn });
    assert.equal(code, 1, failOn);
    assert.deepEqual(fetchFn.posts(), [], failOn);
    assert.deepEqual(lines, ["no status posted: GitHub API answered 502"], failOn);
  }
});

test("a network failure or an answer that is not JSON exits 1 without posting", async () => {
  const broken = [
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response("<html>", { status: 200 }),
    () => json(200, { message: "not a list" }),
  ];
  for (const answer of broken) {
    const { code, fetchFn } = await run({ labels: REVIEWED_LABELS, answers: { "/labels": answer } });
    assert.equal(code, 1);
    assert.deepEqual(fetchFn.posts(), []);
  }
});

test("an unreadable event or a commit list without the head commit exits 1 without posting", async () => {
  const unreadable = await run({ events: [{ id: 1 }], labels: REVIEWED_LABELS });
  assert.equal(unreadable.code, 1);
  assert.deepEqual(unreadable.fetchFn.posts(), []);
  const lagging = await run({ commits: [humanCommit({ sha: EARLIER_SHA })] });
  assert.equal(lagging.code, 1);
  assert.deepEqual(lagging.fetchFn.posts(), []);
  assert.deepEqual(lagging.lines, ["no status posted: the commit list does not include the head commit"]);
});

test("a failed status post exits 1", async () => {
  const { code, fetchFn } = await run({ postStatus: 500 });
  assert.equal(code, 1);
  assert.equal(fetchFn.posts().length, 1);
});

test("bad inputs from the workflow are refused before any API call", async () => {
  const bad = [
    { GITHUB_REPOSITORY: "penny" },
    { GITHUB_REPOSITORY: "ram/penny/../x" },
    { PR_NUMBER: "12; rm -rf /" },
    { PR_NUMBER: "012" },
    { PR_NUMBER: undefined },
    { HEAD_SHA: HEAD_SHA.toUpperCase() },
    { HEAD_SHA: HEAD_SHA.slice(0, 7) },
    { GITHUB_TOKEN: "" },
  ];
  for (const override of bad) {
    const { code, fetchFn } = await run({}, { ...ENV, ...override });
    assert.equal(code, 1, JSON.stringify(override));
    assert.equal(fetchFn.calls.length, 0, JSON.stringify(override));
  }
});

test("the API client never sends the token to another host", async () => {
  const fetchFn = fakeFetch();
  const api = githubApi("token-value", fetchFn);
  await assert.rejects(api("https://evil.example/repos"), /anywhere but the GitHub API/);
  await assert.rejects(api("//evil.example/repos"), /anywhere but the GitHub API/);
  assert.equal(fetchFn.calls.length, 0);
});
