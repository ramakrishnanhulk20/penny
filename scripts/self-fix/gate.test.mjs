// Not covered here: the real GitHub API, the status event payload GitHub sends, and the
// workflow's job-level filter. These tests drive gate.mjs with fake API answers only.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkEvent,
  countSelfFixCommits,
  decide,
  formatOutputs,
  githubApi,
  previewOrigin,
  runCommit,
  startedFixJobs,
} from "./gate.mjs";

const SHA = "0eeb9362c0327a4a717e7ba26ffe20ca7747717e";
const EARLIER_SHA = "95542cf39d62b2c274747fb99895f7e47f93138a";
const OTHER_PR_SHA = "a7324e235cff24fffbbf06c8a0d4c1668967b55b";
const REPO = "ramakrishnanhulk20/penny";
const REPO_ID = 1425247968;
const NOW = new Date("2026-10-19T15:00:00Z");
const CURRENT_RUN = 900;

function env(overrides = {}) {
  return {
    EVENT_CONTEXT: "TestSprite V3",
    EVENT_STATE: "failure",
    EVENT_SENDER_ID: "258111874",
    EVENT_SHA: SHA,
    EVENT_CREATED_AT: "2026-10-19T12:05:00Z",
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: String(CURRENT_RUN),
    GITHUB_RUN_ATTEMPT: "1",
    ...overrides,
  };
}

function pull({ head = {}, ...overrides } = {}) {
  return {
    number: 12,
    state: "open",
    created_at: "2026-10-18T20:00:00Z",
    head: { sha: SHA, ref: "rates", repo: { id: REPO_ID, full_name: REPO }, ...head },
    base: { repo: { id: REPO_ID, full_name: REPO, default_branch: "main" } },
    user: { login: "ramakrishnanhulk20", id: 140826327 },
    ...overrides,
  };
}

function commit(message, sha = EARLIER_SHA, date = "2026-10-19T10:30:00Z") {
  return { sha, commit: { message, committer: { date } } };
}

const HEAD = commit("rates: ECB prefill", SHA, "2026-10-19T11:58:00Z");

function workflowRun({ id, sha = SHA, conclusion = "failure", startedAt = "2026-10-19T09:00:00Z", title }) {
  return {
    id,
    conclusion,
    display_title: title ?? `self-fix ${sha}`,
    run_started_at: startedAt,
    created_at: startedAt,
  };
}

function jobs(fixConclusion, { attempt = 1, startedAt = "2026-10-19T09:05:00Z", extraFix = [] } = {}) {
  const list = [
    { name: "gate", conclusion: "success", status: "completed", run_attempt: attempt, started_at: startedAt },
    { name: "failures", conclusion: "success", status: "completed", run_attempt: attempt, started_at: startedAt },
    {
      name: "fix",
      conclusion: fixConclusion,
      status: fixConclusion === null ? "in_progress" : "completed",
      run_attempt: attempt,
      started_at: startedAt,
    },
    ...extraFix,
  ];
  return { total_count: list.length, jobs: list };
}

const SKIPPED_GATE_JOBS = {
  total_count: 4,
  jobs: [
    { name: "gate", conclusion: "success", status: "completed", run_attempt: 1, started_at: "2026-10-19T09:00:00Z" },
    { name: "failures", conclusion: "skipped", status: "completed", run_attempt: 1, started_at: "2026-10-19T09:01:00Z" },
    { name: "fix", conclusion: "skipped", status: "completed", run_attempt: 1, started_at: "2026-10-19T09:01:00Z" },
    { name: "push", conclusion: "skipped", status: "completed", run_attempt: 1, started_at: "2026-10-19T09:01:00Z" },
  ],
};

function fakeApi({ pulls = [pull()], pr = pull(), commits = [HEAD], runs = [], jobsById = {}, runTotal, failOn } = {}) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (failOn && path.includes(failOn)) throw new Error("GitHub API answered 502");
    const url = new URL(path, "https://api.github.com");
    const page = Number(url.searchParams.get("page") ?? "1");
    if (url.pathname === `/repos/${REPO}/commits/${SHA}/pulls`) return pulls;
    if (url.pathname === `/repos/${REPO}/pulls/12/commits`) return commits.slice((page - 1) * 100, page * 100);
    if (url.pathname === `/repos/${REPO}/pulls/12`) return pr;
    if (url.pathname === `/repos/${REPO}/actions/workflows/self-fix.yml/runs`) {
      return { total_count: runTotal ?? runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) };
    }
    const jobsPath = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (jobsPath) {
      const answer = jobsById[jobsPath[1]];
      if (!answer) throw new Error(`no jobs for run ${jobsPath[1]}`);
      return answer;
    }
    throw new Error(`unexpected path ${path}`);
  };
  api.calls = calls;
  return api;
}

async function reasonFor(overrides) {
  const decision = await decide({ env: env(overrides.env), api: fakeApi(overrides), now: NOW });
  assert.equal(decision.proceed, false);
  return decision.reason;
}

function jobReads(api) {
  return api.calls.filter((path) => path.includes("/actions/runs/"));
}

test("proceeds for a maintainer's failing pull request and passes on the failure window", async () => {
  const decision = await decide({ env: env(), api: fakeApi(), now: NOW });
  assert.deepEqual(decision, {
    proceed: true,
    pr: 12,
    branch: "rates",
    sha: SHA,
    attempt: 1,
    previewOrigin: "https://penny-git-rates-rams-projects-86cea8eb.vercel.app",
    headCommittedAt: "2026-10-19T11:58:00.000Z",
    statusCreatedAt: "2026-10-19T12:05:00.000Z",
  });
  assert.equal(
    formatOutputs(decision),
    [
      "proceed=true",
      "pr=12",
      "branch=rates",
      `sha=${SHA}`,
      "attempt=1",
      "preview_origin=https://penny-git-rates-rams-projects-86cea8eb.vercel.app",
      "head_committed_at=2026-10-19T11:58:00.000Z",
      "status_created_at=2026-10-19T12:05:00.000Z",
      "",
    ].join("\n"),
  );
});

test("one earlier attempt on this pull request makes this attempt 2, even if it failed", async () => {
  const runs = [workflowRun({ id: 1, sha: EARLIER_SHA, conclusion: "failure" })];
  const decision = await decide({
    env: env(),
    api: fakeApi({ commits: [commit("rates: start"), HEAD], runs, jobsById: { 1: jobs("failure") } }),
    now: NOW,
  });
  assert.equal(decision.proceed, true);
  assert.equal(decision.attempt, 2);
});

test("a self-fix commit counts as an attempt even when its run is no longer listed", async () => {
  const commits = [commit("self-fix: attempt 1 for the TestSprite failure on 1234567"), HEAD];
  const decision = await decide({ env: env(), api: fakeApi({ commits }), now: NOW });
  assert.equal(decision.attempt, 2);
});

test("reviewer's case: ten failed runs today that each started a fix job reach the daily cap", async () => {
  const runs = Array.from({ length: 10 }, (_, n) => workflowRun({ id: 100 + n, sha: OTHER_PR_SHA, conclusion: "failure" }));
  const jobsById = Object.fromEntries(runs.map((run) => [run.id, jobs("failure")]));
  assert.equal(await reasonFor({ runs, jobsById }), "six self-fix attempts already started today");
});

test("a run whose gate skipped does not count, and an all-skipped run is never read", async () => {
  const runs = [
    workflowRun({ id: 1, sha: EARLIER_SHA, conclusion: "success" }),
    workflowRun({ id: 2, sha: EARLIER_SHA, conclusion: "skipped" }),
    ...Array.from({ length: 5 }, (_, n) => workflowRun({ id: 10 + n, sha: OTHER_PR_SHA, conclusion: "success" })),
  ];
  const jobsById = { 1: SKIPPED_GATE_JOBS, 2: SKIPPED_GATE_JOBS };
  for (let n = 0; n < 5; n += 1) jobsById[10 + n] = jobs("success");
  const api = fakeApi({ commits: [commit("rates: start"), HEAD], runs, jobsById });
  const decision = await decide({ env: env(), api, now: NOW });
  assert.equal(decision.proceed, true);
  assert.equal(decision.attempt, 1);
  assert.ok(!jobReads(api).some((path) => path.includes("/runs/2/")));
});

test("two attempts on this pull request's commits stop a third, including one from yesterday", async () => {
  const runs = [
    workflowRun({ id: 1, sha: EARLIER_SHA, startedAt: "2026-10-18T22:00:00Z" }),
    workflowRun({ id: 2, sha: SHA, conclusion: "success" }),
  ];
  const jobsById = { 1: jobs("failure", { startedAt: "2026-10-18T22:05:00Z" }), 2: jobs("success") };
  const reason = await reasonFor({ commits: [commit("rates: start"), HEAD], runs, jobsById });
  assert.equal(reason, "this pull request already had two self-fix attempts");
});

test("yesterday's attempts on other pull requests are not read and do not count", async () => {
  const runs = Array.from({ length: 8 }, (_, n) =>
    workflowRun({ id: 200 + n, sha: OTHER_PR_SHA, startedAt: "2026-10-18T20:00:00Z" }),
  );
  const api = fakeApi({ runs });
  const decision = await decide({ env: env(), api, now: NOW });
  assert.equal(decision.proceed, true);
  assert.equal(jobReads(api).length, 0);
});

test("a fix job that is still running counts as an attempt", async () => {
  const runs = Array.from({ length: 6 }, (_, n) => workflowRun({ id: 300 + n, sha: OTHER_PR_SHA, conclusion: null }));
  const jobsById = Object.fromEntries(runs.map((run) => [run.id, jobs(null)]));
  assert.equal(await reasonFor({ runs, jobsById }), "six self-fix attempts already started today");
});

test("the asking run's own fix job is not counted, but an earlier attempt of it is", async () => {
  const runs = [workflowRun({ id: CURRENT_RUN, sha: SHA, conclusion: null })];
  const own = { 1: jobs(null, { attempt: 1 }) };
  const first = await decide({ env: env(), api: fakeApi({ runs, jobsById: { [CURRENT_RUN]: own[1] } }), now: NOW });
  assert.equal(first.attempt, 1);
  const rerun = await decide({
    env: env({ GITHUB_RUN_ATTEMPT: "2" }),
    api: fakeApi({ runs, jobsById: { [CURRENT_RUN]: jobs("failure", { attempt: 1 }) } }),
    now: NOW,
  });
  assert.equal(rerun.attempt, 2);
});

test("every re-run of a run that started a fix job is its own attempt", async () => {
  const runs = [workflowRun({ id: 5, sha: EARLIER_SHA })];
  const secondFix = { name: "fix", conclusion: "failure", status: "completed", run_attempt: 2, started_at: "2026-10-19T09:30:00Z" };
  const jobsById = { 5: jobs("failure", { extraFix: [secondFix] }) };
  const reason = await reasonFor({ commits: [commit("rates: start"), HEAD], runs, jobsById });
  assert.equal(reason, "this pull request already had two self-fix attempts");
});

test("a non-skipped run whose title names no commit counts for this pull request", async () => {
  const runs = [workflowRun({ id: 7, title: "self-fix" }), workflowRun({ id: 8, title: "Something else" })];
  const jobsById = { 7: jobs("failure"), 8: jobs("failure") };
  assert.equal(await reasonFor({ runs, jobsById }), "this pull request already had two self-fix attempts");
});

test("more than fifty runs to read means the attempts cannot be counted", async () => {
  const runs = Array.from({ length: 51 }, (_, n) => workflowRun({ id: 400 + n, sha: OTHER_PR_SHA, conclusion: "success" }));
  assert.equal(await reasonFor({ runs }), "too many self-fix runs to read their jobs");
});

test("a run list that cannot be read whole means the attempts cannot be counted", async () => {
  const runs = [workflowRun({ id: 1, conclusion: "skipped" })];
  assert.equal(await reasonFor({ runs, runTotal: 40 }), "the run list ended before its own count");
  const many = Array.from({ length: 300 }, (_, n) => workflowRun({ id: 1000 + n, conclusion: "skipped" }));
  assert.equal(await reasonFor({ runs: many, runTotal: 301 }), "too many runs of this workflow to count attempts");
});

test("a jobs answer longer than one page means the attempts cannot be counted", async () => {
  const runs = [workflowRun({ id: 1, sha: OTHER_PR_SHA })];
  const jobsById = { 1: { total_count: 150, jobs: jobs("failure").jobs } };
  assert.equal(await reasonFor({ runs, jobsById }), "a run has too many jobs to read in one page");
});

test("asks for runs from the day before the earlier of the pull request's opening and today", async () => {
  const api = fakeApi();
  await decide({ env: env(), api, now: NOW });
  const runsCall = new URL(api.calls.find((path) => path.includes("/workflows/")), "https://api.github.com");
  assert.equal(runsCall.searchParams.get("created"), ">=2026-10-17");
  const recent = fakeApi({ pr: pull({ created_at: "2026-10-19T14:00:00Z" }) });
  await decide({ env: env(), api: recent, now: NOW });
  const recentCall = new URL(recent.calls.find((path) => path.includes("/workflows/")), "https://api.github.com");
  assert.equal(recentCall.searchParams.get("created"), ">=2026-10-18");
});

test("skips a status that is not TestSprite V3, without calling GitHub", async () => {
  for (const context of ["Vercel", "testsprite v3", "TestSprite V3 ", ""]) {
    const api = fakeApi();
    const decision = await decide({ env: env({ EVENT_CONTEXT: context }), api, now: NOW });
    assert.equal(decision.reason, "the status is not TestSprite V3");
    assert.equal(api.calls.length, 0);
  }
});

test("skips a status that is not a failure", async () => {
  for (const state of ["pending", "success", "error", "FAILURE"]) {
    assert.equal(await reasonFor({ env: { EVENT_STATE: state } }), "the status is not a failure");
  }
});

test("skips a status posted by anyone but TestSprite's bot", async () => {
  for (const sender of ["35613825", "140826327", "", "258111874 "]) {
    assert.equal(await reasonFor({ env: { EVENT_SENDER_ID: sender } }), "the status was not posted by TestSprite's bot");
  }
});

test("skips a commit id that is not a full lowercase SHA", async () => {
  for (const sha of ["0eeb936", SHA.toUpperCase(), `${SHA}0`, `${SHA.slice(0, 39)};`]) {
    assert.equal(await reasonFor({ env: { EVENT_SHA: sha } }), "the commit id is not a full lowercase SHA");
  }
});

test("skips when the status time cannot be read", async () => {
  for (const time of [undefined, "", "yesterday"]) {
    assert.equal(await reasonFor({ env: { EVENT_CREATED_AT: time } }), "the status time could not be read");
  }
});

test("skips an unexpected repository name", async () => {
  assert.equal(await reasonFor({ env: { GITHUB_REPOSITORY: "evil.example/../x" } }), "the repository name is unexpected");
});

test("skips when no open pull request has this commit as its head", async () => {
  const reason = "no open pull request has this commit as its head";
  assert.equal(await reasonFor({ pulls: [] }), reason);
  assert.equal(await reasonFor({ pulls: [pull({ state: "closed" })] }), reason);
  assert.equal(await reasonFor({ pulls: [pull({ head: { sha: EARLIER_SHA } })] }), reason);
});

test("skips when more than one open pull request has this commit as its head", async () => {
  const pulls = [pull(), pull({ number: 13 })];
  assert.equal(await reasonFor({ pulls }), "more than one open pull request has this commit as its head");
});

test("skips when a full page of pull requests could hide another match", async () => {
  const pulls = Array.from({ length: 100 }, (_, n) => pull({ number: n + 1, state: "closed" }));
  assert.equal(await reasonFor({ pulls }), "too many pull requests contain this commit");
});

test("skips when the pull request head has moved since TestSprite tested it", async () => {
  const reason = await reasonFor({ pr: pull({ head: { sha: EARLIER_SHA } }) });
  assert.equal(reason, "the pull request head has moved since TestSprite tested it");
});

test("skips when the pull request closed after the event", async () => {
  assert.equal(await reasonFor({ pr: pull({ state: "closed" }) }), "the pull request is not open");
});

test("skips a pull request that targets another repository", async () => {
  const pr = pull({ base: { repo: { id: 1, full_name: "someone/else", default_branch: "main" } } });
  assert.equal(await reasonFor({ pr }), "the pull request does not target this repository");
});

test("skips a pull request whose branch lives in a fork", async () => {
  const reason = "the pull request branch lives in a fork";
  assert.equal(await reasonFor({ pr: pull({ head: { repo: { id: 999, full_name: "attacker/penny" } } }) }), reason);
  assert.equal(await reasonFor({ pr: pull({ head: { repo: null } }) }), reason);
  assert.equal(await reasonFor({ pr: pull({ head: { repo: { id: 999, full_name: REPO } } }) }), reason);
});

test("skips a pull request whose branch is the default branch", async () => {
  const reason = "the pull request's branch is the default branch";
  assert.equal(await reasonFor({ pr: pull({ head: { ref: "main" } }) }), reason);
  const trunk = pull({ head: { ref: "trunk" }, base: { repo: { id: REPO_ID, full_name: REPO, default_branch: "trunk" } } });
  assert.equal(await reasonFor({ pr: trunk }), reason);
});

test("skips a pull request by anyone but the maintainer", async () => {
  for (const login of ["attacker", "Ramakrishnanhulk20", "ramakrishnanhulk20[bot]"]) {
    const reason = await reasonFor({ pr: pull({ user: { login, id: 140826327 } }) });
    assert.equal(reason, "the pull request author is not the maintainer");
  }
  const renamed = await reasonFor({ pr: pull({ user: { login: "ramakrishnanhulk20", id: 999 } }) });
  assert.equal(renamed, "the pull request author is not the maintainer");
});

test("skips a branch whose preview address cannot be predicted", async () => {
  for (const ref of ["feature_x", "fix..it", "a//b", "-rates", "x".repeat(31), "rates\nproceed=true"]) {
    const reason = await reasonFor({ pr: pull({ head: { ref } }) });
    assert.equal(reason, "the preview address for this branch name cannot be predicted");
  }
});

test("skips when the pull request's opening time cannot be read", async () => {
  assert.equal(await reasonFor({ pr: pull({ created_at: null }) }), "the pull request's opening time could not be read");
});

test("skips when the head commit's time cannot be read", async () => {
  assert.equal(await reasonFor({ commits: [commit("rates: start")] }), "the head commit's time could not be read");
  const undated = { sha: SHA, commit: { message: "x", committer: {} } };
  assert.equal(await reasonFor({ commits: [undated] }), "the head commit's time could not be read");
});

test("skips when the pull request has too many commits to count", async () => {
  const commits = [...Array.from({ length: 249 }, (_, n) => commit(`change ${n}`)), HEAD];
  assert.equal(await reasonFor({ commits }), "the pull request has too many commits to count self-fix attempts");
});

test("skips on any GitHub API error", async () => {
  const runs = [workflowRun({ id: 1, sha: OTHER_PR_SHA })];
  for (const failOn of ["/commits/", "/pulls/12/commits", "/pulls/12", "/actions/workflows/", "/actions/runs/1/jobs"]) {
    assert.equal(await reasonFor({ failOn, runs, jobsById: { 1: jobs("failure") } }), "a GitHub API call failed");
  }
});

test("skips when GitHub sends a commit without a readable message", async () => {
  assert.equal(await reasonFor({ commits: [{ sha: "x", commit: {} }, HEAD] }), "a GitHub API call failed");
});

test("fix jobs count unless skipped, whatever their start time says", () => {
  assert.equal(startedFixJobs(SKIPPED_GATE_JOBS).length, 0);
  assert.equal(startedFixJobs(jobs("cancelled")).length, 1);
  assert.equal(startedFixJobs(jobs("failure", { attempt: 2 }), 2).length, 0);
  assert.throws(() => startedFixJobs({ jobs: [] }));
});

test("a run's tested commit is read only from a well-formed title", () => {
  assert.equal(runCommit({ display_title: `self-fix ${SHA}` }), SHA);
  for (const title of [`self-fix ${SHA.toUpperCase()}`, `self-fix ${SHA} `, "self-fix", undefined]) {
    assert.equal(runCommit({ display_title: title }), null);
  }
});

test("self-fix commits are counted by their message prefix only", () => {
  const commits = [commit("self-fix: attempt 1"), commit("Self-fix: attempt 1"), commit("fix: self-fix: x")];
  assert.equal(countSelfFixCommits(commits), 1);
});

test("a TestSprite failure from the bot on a full SHA passes the event check", () => {
  assert.equal(checkEvent({ context: "TestSprite V3", state: "failure", senderId: "258111874", sha: SHA }), null);
});

test("preview origins follow Vercel's branch alias for simple branch names", () => {
  assert.equal(previewOrigin("rates"), "https://penny-git-rates-rams-projects-86cea8eb.vercel.app");
  assert.equal(previewOrigin("Fix/Payments"), "https://penny-git-fix-payments-rams-projects-86cea8eb.vercel.app");
  assert.equal(previewOrigin("x".repeat(30)), `https://penny-git-${"x".repeat(30)}-rams-projects-86cea8eb.vercel.app`);
  assert.equal(previewOrigin("x".repeat(31)), null);
});

test("a skip writes only proceed=false to the job outputs", () => {
  assert.equal(formatOutputs({ proceed: false, reason: "anything" }), "proceed=false\n");
});

test("the API client never sends the token to another host", async () => {
  const api = githubApi("token-value");
  await assert.rejects(api("https://evil.example/repos"), /anywhere but the GitHub API/);
  await assert.rejects(api("//evil.example/repos"), /anywhere but the GitHub API/);
});
