# Penny threat model

Written 19 Oct 2026 at the architecture gate, before any code, from a plain description of the system. Produced by an independent review pass using the threat-model prompt from Monad Foundation's "Writing secure code with LLMs". Section C is the definition of done: the build is complete only when every invariant in C can be shown to hold.

---

## A) App-class risk profile

In security terms Penny is five systems at once:

1. **A multi-tenant data store with a link as the only key.** Every group lives in one Postgres database, and the group token is the whole access check.
2. **A small money ledger.** It turns typed decimals, currency codes and exchange rates into integer balances and a payment plan that people act on.
3. **A place that shows user-written text to other people.** Group, member and expense text goes to everyone holding the link. Pull request titles and links from GitHub go to every visitor of `/checks`.
4. **A caller of fixed upstream APIs.** `/api/fx` calls api.frankfurter.dev with user-influenced parameters. `/api/checks` calls GitHub with a server-side credential.
5. **A CI pipeline that runs pull request code** and feeds text derived from those PRs to an AI coding agent that holds secrets and can push code. In security terms this is "a service that runs user-influenced commands", and it is the highest-risk part of the system.

**A1. Broken object-level authorization (applies; the top app risk).** The token proves you may touch group X. It says nothing about the ids inside the request: `expenseId`, `paidBy`, each split part's `memberId`, payment `from` and `to`, the member to remove. If a handler loads an expense or member by id alone, anyone holding any group link (anyone can make one in one click) can edit another group's data. The same applies if the group page's server render reads data through a different path than the API.

**A2. Weak or leaking link tokens (applies).** A token is weak if it comes from `Math.random`, a timestamp or a row id. A token leaks through the Referer header, analytics or error tracking that record URLs, search engines indexing a posted link, chat-app preview bots, and hosting logs. With no revocation, one leak is permanent. The group read endpoint is also where someone would try to guess tokens.

**A3. Injection (applies in two places).** SQL: every body field reaches Postgres. Shell: the app runs no shell, but the self-fix workflow does, and an event value pasted into a `run:` step with `${{ }}` turns a branch name, PR title or failure text into a command. Prototype pollution applies narrowly if a member id from JSON is used as a key on a plain object.

**A4. Stored cross-site scripting and display spoofing (applies).** Group names, member names and descriptions are rendered for every member; PR titles, branch names, check text and report URLs are rendered on public `/checks`. React escapes text, so the risk sits where escaping does not happen: raw HTML, markdown, a stored or upstream value inside an `href` (a `javascript:` URL), page metadata. Script on this origin is serious because the token sits in the address bar. Spoofing comes from bidi-override, zero-width and lookalike characters ("Bob" and "Bоb").

**A5. Prompt injection into an agent with tools (applies; the top CI risk).** TestSprite's failure details (DOM snapshot text, test source, root-cause guess) go to Claude Code, which has file tools, possibly a shell, secrets nearby and the right to push. The DOM snapshot is whatever the preview rendered, which reflects the PR's code and the preview database. The repository files the agent reads also come from the PR.

**A6. Poisoned pipeline execution and secret theft (applies).** The job runs with repository secrets and checks out the PR's head. Claude Code loads project settings, hooks and MCP servers from that checkout, and any install, build or test step runs scripts the PR controls. At stake: the Claude OAuth token, the TestSprite API key, and a write-capable `GITHUB_TOKEN`. The Vercel build of a PR also runs with Preview environment variables and a database branch.

**A7. Server-side request forgery (partly applies).** No endpoint fetches a user-supplied URL. Four paths remain: string-built `/api/fx` URLs where crafted codes add parameters or change the path; a redirect from the FX host followed by our function; absolute URLs built from `Host` or `X-Forwarded-Host`, possibly carrying the GitHub token; GitHub pagination links followed with the token attached.

**A8. Money parsing and arithmetic (applies).** Binary floats (1.005 x 100 = 100.4999...); inputs such as `1e3`, `-5`, `0x10`, ` 12`, full-width digits, `1,5`, `NaN`; more decimals than the currency allows; overflow past 2^53 or past Postgres bigint after multiplying by shares or rates; rounding each part separately so parts stop adding up; the browser preview and the server using different parsers or minor-unit tables.

**A9. Business logic and state (applies).** A payment with a currency but no rate; a base-currency change that strands stored rates; removing a member who still owes money; editing a deleted expense; two friends editing the same expense at once; a member twice in one split, all-zero shares, exact parts that do not sum; paying yourself; a reused `clientId` replaying a request; events replayed out of order; the expenses table and the events table disagreeing.

**A10. Mass assignment (applies).** If a PATCH body is spread into an update, a caller can set `token`, `group_id`, `id` or `created_at`, moving an expense into another group or replacing a link.

**A11. Resource exhaustion and cost abuse (applies).** Group creation needs no credential; members, parts, expenses and events per group are unbounded and every read replays the log; the exact settle-up search grows exponentially with the number of people owed; `/api/fx` and `/api/checks` fan out to upstreams (GitHub's hourly quota, frankfurter blocking us); each PR creates a database branch; each failing PR spends paid Claude usage; on serverless hosting, in-memory caches and rate limits do not hold across instances.

**A12. Information disclosure (applies).** Error bodies (SQL, connection strings, upstream responses), `/api/health` detail, public GitHub Actions logs (failure details, agent transcripts, transformed secrets), TestSprite reports linked from `/checks`, Vercel build logs.

**A13. Supply chain (applies).** npm dependencies; third-party GitHub Actions; the TestSprite CLI and Claude Code installed at run time in jobs that hold secrets. A moved tag or a hijacked package runs with those secrets.

**A14. Trusting upstream data (applies).** A hostile or wrong FX rate is prefilled for a user who may not check it. The green badge on `/checks` means whatever our code decides a GitHub check means, and a check name alone proves nothing.

**A15. Cross-site request forgery (does not apply as designed).** No cookies or ambient credentials; a forged request must carry the token, and anyone with the token can call the API directly. This changes the moment a cookie or session is added.

**A16. Account and session attacks (do not apply).** No accounts, passwords, sessions or resets. The flip side: no identity. "Who are you" is a local choice, so any link holder can act as any member. By design; listed under non-goals.

**A17. File upload, path traversal, XML, deserialization (do not apply).** JSON bodies only. Revisit if receipt photos or CSV export (formula injection) are added.

**A18. Clickjacking and open redirects (mostly do not apply).** Framing a group page needs its token, which already gives full access; no endpoint takes a redirect target. A `frame-ancestors` rule is still cheap.

---

## B) Threat model

### Trust boundaries
- **TB1 Browser to server:** every route handler, the group page server render, any server action. Path, query, headers and body are untrusted. TestSprite's runners cross here with no extra rights.
- **TB2 Group to group:** inside the server the token is the wall between tenants; every id in a request crosses it.
- **TB3 FX upstream to server:** the api.frankfurter.dev response, its DNS, any redirect.
- **TB4 GitHub API to server to public page:** PR and check data flowing into `/checks`.
- **TB5 Database to server:** stored values read back, written earlier by any link holder, TestSprite or an anonymous visitor.
- **TB6 Pull request to build and preview:** PR code runs in the Vercel build and preview runtime with Preview variables and a database branch.
- **TB7 Production database to preview database:** whatever the branch copies.
- **TB8 Pull request and preview to CI:** the `check_run` event, the PR checkout and TestSprite's failure details enter a job that holds secrets.
- **TB9 AI agent to repository:** the agent's diff is pushed, Vercel redeploys it, a human merges to production.
- **TB10 Package registries and Action repositories to CI and build.**
- **TB11 Local storage to page script:** the "who are you" choice. Low risk.

### Attacker-controlled inputs
**Direct:** path `groupToken`, `expenseId`; query `from`, `to` and any extra parameter; group creation `name`, `baseCurrency`, `members[]`; group PATCH fields plus any extra field; expense `clientId`, `description`, `amount`, `currency`, `rateToBase`, `paidBy`, `split.mode`, `split.parts[]` plus extras; payment `clientId`, `from`, `to`, `amount`, `currency`; headers `Host`, `X-Forwarded-For`, `X-Forwarded-Host`, `Content-Type`, `Content-Length`, `Origin`, `Referer`, `User-Agent`, `Accept-Language`, framework-internal headers such as `x-middleware-subrequest`; request rate, concurrency, retries, edit ordering; the member id in the visitor's own local storage.

**Indirect:** stored values read back; api.frankfurter.dev status, body, rates, echoed pair, redirects, latency, size, DNS; GitHub PR fields (title, number, head branch, author, head repo), check runs (name, app id, conclusion, output text, `details_url`, `html_url`), commit SHAs, commit statuses (`context` and `target_url` are free text), deployments, pagination headers, rate-limit errors; pull request contents (code, `package.json` scripts and dependencies, lockfile, migrations, tests, `CLAUDE.md`, `.claude/` settings and hooks, `.mcp.json`, commit messages, PR title and body, branch name); the `check_run` event payload; the PR head at checkout time (it can move after the failing run); TestSprite failure details; the agent's output (diff, files, anything printed to the public log); preview database contents; package and Action versions resolved at run time.

### Privileged position and assets
Every group in production (an outsider reaches only the groups whose link they hold); database credentials per environment, including the migration role; preview database branches; the GitHub read token and its quota; outbound network from Vercel functions and our standing with api.frankfurter.dev and GitHub; paid capacity (Vercel, Neon, TestSprite credits, the Claude subscription); CI secrets (Claude OAuth token, TestSprite API key, write-capable `GITHUB_TOKEN`); the power to push a commit that deploys to a public URL and looks ready to merge; trust signals (the required check and `/checks`); the app's origin, where script can read a token from the address bar.

### Attacker goals
- **G1. Take the maintainer's CI secrets, or ship code he did not write.** Open a PR (no permission needed on a public repo), make a test fail, let the self-fix job check out the PR and run the agent with secrets present; PR-supplied hooks or install scripts run, or planted text instructs the agent; the secret goes to the public log, the network or a pushed file, or the "fix" carries a backdoor a human merges because the check is green. Crosses TB6, TB8, TB9.
- **G2. Read or change groups that are not theirs.** Foreign ids inside a request made with their own token (A1); token guessing; tokens collected from Referer, analytics, search indexes or reports; a PR whose preview dumps a preview database copied from production. Crosses TB1, TB2, TB7.
- **G3. Make a ledger lie inside a group they can open.** Shift money through rounding, negative or duplicated parts, a hostile rate, a base-currency switch, removing a debtor, or a payment in another currency; or publicly break the promise that parts always add up. Crosses TB1, TB5.
- **G4. Fake the green badge.** A PR job named `TestSprite V3` satisfies a check required by name and shows "passed" on `/checks`; or free-text check output parsed into "0 failed". Crosses TB4, TB8.
- **G5. Run up cost or take the app down.** Mass group creation, giant groups, event floods; a settle-up that triggers the exponential search; `/api/fx` as a free proxy; cache-busting `/api/checks`; many failing PRs burning Claude usage. Crosses TB1, TB3, TB4, TB8.

---

## C) Defensive-programming standards (the definition of done)

### Tenancy and the link
- **C1.** A request can read or change only the rows of the one group its token names. Every id in the request (`expenseId`, `paidBy`, each part's `memberId`, payment `from` and `to`, the member to remove, `clientId`) must belong to that group, or the response is the same 404 an unknown token gets and nothing changes. Shown by: with group A's token, editing, deleting or referencing any id from group B returns 404 and B is unchanged.
- **C2.** Exactly one function turns a token into a group, and every entry point uses it (route handlers, the group page render, any server action). The token is checked against one exact format (length and alphabet) before any database call; anything else is a 404.
- **C3.** A token cannot be guessed or derived: at least 128 bits from a cryptographically secure generator, unrelated to ids, time or names. The database stores only a hash, so reading the database alone yields no working link. Internal ids never act as permission. A group's first token comes from the server's generator. Every later one is made by the browser at "Reset link" (16 bytes from `crypto.getRandomValues`, written as 22 base64url characters), passes the same exact format check as every token, and only its hash is stored; the server never sends it back. The server cannot judge the browser's randomness: a link holder who sends a weak token weakens only the link of a group they can already empty, which is the first non-goal. A new token equal to the current one, or to another group's link, is refused.
- **C4.** The token reaches no one except the browser holding the link and our server. Group pages send `Referrer-Policy: no-referrer`, load no third-party scripts and are `noindex`; titles and link-preview metadata hold no group data; analytics and error reporting strip the token; the token never appears in another group's response, in `/checks`, or in an error.
- **C5.** GET never changes state. Responses carrying group data are marked so no shared cache stores them.
- **C6.** Every write endpoint accepts one exact schema and rejects unknown fields. No body can write id, token, group or creation time. Every string and array has a stated maximum length.

### Money
- **C7.** Every stored amount is exactly the integer number of minor units the user typed. Input that does not denote exactly one such integer is rejected, never rounded: signs, exponents, hex, thousands separators, whitespace, non-ASCII digits, NaN, Infinity, more decimals than the currency has, zero, anything over the cap. One parser, shared by server and browser. No amount ever passes through a binary float.
- **C8.** A currency is valid only if it is in ISO 4217 with a defined minor unit (XAU, XXX, XTS and similar are rejected). One table supplies the minor unit for parsing, conversion and display. Display passes that digit count explicitly instead of trusting the browser's currency formatter, whose CLDR data differs from ISO 4217 for some currencies.
- **C9.** A rate is a positive exact decimal within stated bounds and precision, parsed by one parser, never a float. Required when the expense currency differs from the base, refused when they match. Conversion uses exact integer arithmetic and rounds once per expense by one named rule.
- **C10.** Splits always add up: the parts sum exactly to the amount in its own currency, and the base-currency parts sum exactly to the base-currency total. Remainder cents go by one deterministic rule.
- **C11.** A split is accepted only if unambiguous: known mode; shares are positive whole numbers under a cap; exact values parsed under C7 sum to the amount; each member at most once; every listed member and the payer are current members of this group.
- **C12.** A group's balances sum to exactly zero after every event, and applying the settle-up transfers leaves every member at exactly zero. The server checks both before returning a plan; a plan that fails is an error, not an answer.
- **C13.** A payment is accepted only with a positive amount (C7), two different current members, and an unambiguous base-currency value: it is in the base currency, or it carries a rate under C9.
- **C14.** Balances never mix currencies. A base-currency change never reinterprets stored rates against a new base: it is refused once the group has entries.
- **C15.** Removing a member never changes anyone else's balance. A member with a non-zero balance, or named in a live expense or payment, cannot be removed; removal otherwise hides the member and keeps their history in every sum.
- **C16.** A retried create never makes a second row. `clientId` is unique per group and kind by a database constraint; a repeat with the same body returns the original result; a repeat with a different body is refused; a `clientId` never returns another group's data. A retry whose row was since deleted or undone answers 404, like any id not in the group. When "Mark as paid" or "Undo" gets a 404, or a 409 other than a full group, the page loads the group again and says "This was already changed. Showing the latest."
- **C17.** No change silently overwrites someone else's. An edit or delete names the version it saw; a stale version is refused. A deleted expense cannot be edited.
- **C18.** The expense list and the balances always agree. Each change writes its event and its current-state rows in one transaction; event order is the database sequence, never a clock; balances equal a fresh replay of the event log, proven by a test after a random sequence of operations. No statement can update, delete or truncate events: database triggers refuse it, so even a bug cannot rewrite the log. The runtime connects as the database owner role that Neon's integration provides, so "the runtime cannot change the schema" is a named non-goal, not a guarantee.

### Upstream calls
- **C19.** `/api/fx` reaches only `https://api.frankfurter.dev/v1/latest` (ECB reference rates; the older frankfurter.app host now only redirects there, and redirects are refused), and only with two codes that pass C8. The URL is built by a URL library, never by concatenation; redirects are not followed; the call has a timeout and a response size cap; the returned rate is validated under C9 and must match the requested pair; any failure returns "no rate available", never a default; results are cached and the endpoint is rate limited.
- **C20.** No outbound URL is built from request headers or from a URL an upstream returned. The GitHub token is sent only to the GitHub API origin.
- **C21.** `/api/checks` takes no caller input that changes what it fetches. One shared cached result per time window across every instance; a bounded number of upstream calls per refresh; on GitHub error or rate limit the page keeps showing the last good read with its time and says so, never a new pass and never the upstream error text.
- **C22.** `/checks` shows "passed" only when the verdict was posted by TestSprite's GitHub App, on the PR's current head commit, as exactly `success`. TestSprite posts a commit status (context `TestSprite V3`), not a check run, and a status names the app's bot user rather than the app, so the page matches the bot's user id (258111874) while GitHub's branch rule pins TestSprite's app id (2756476). A same-named status from anyone else, a missing status, an unknown state or unparseable counts show "not passed" or "unknown"; unparseable counts are never shown as zero.
- **C23.** Every link on `/checks` is built from validated parts: the PR link is the integer PR number under this repository's fixed URL; the report link appears only if it parses as https on TestSprite's report origin. All GitHub text renders as plain text.
- **C24.** The GitHub token can do nothing an anonymous visitor to the public repository cannot: fine-grained, this repository only, read-only, present only in the Production environment, never in Preview and never in the browser bundle.

### Rendering, limits and errors
- **C25.** User and upstream text is only ever rendered as text: never as HTML or markdown, never inside `href`, `src`, `style`, `script` or page metadata. Names and descriptions refuse Unicode control and format characters (categories Cc and Cf), and any string that is not well-formed Unicode (`String.prototype.isWellFormed`, which catches every lone surrogate a JSON escape can carry), so such text gets a 400, never a 500 from the database and never a silent U+FFFD in place of what was sent. Member names are compared for duplicates after one Unicode normalization. A content security policy backs this up: scripts, styles, images, fonts and connections from Penny's own origin only, no plugins, `base-uri 'none'` and `frame-ancestors 'none'`. Inline scripts are allowed by the policy, because Next.js inlines its own bootstrap scripts and the pages are statically prerendered (nonces would force every page to render per request). React's escaping and the Cc/Cf refusal are the defence against injected script, and this is a named non-goal.
- **C26.** Limits hold across all instances and are checked before work begins: rate limits on group creation and writes, per client network and per group. The six limits, each counted per minute: group creation 60 per client network; sample trips 10 per client network; rate lookups on `/api/fx` 60 per client network; group writes 600 per client network and 120 per group; reads (the group read and `/api/checks`) 600 per client network. `/api/health` is not limited. A client network is stored only as its HMAC-SHA256 under a server-side key, so the limits table holds no address. Caps hold on members, expenses and events per group, on parts per expense, and on body size. Live caps: 20 members, 500 expenses, 500 payments. History caps, because deleted expenses, undone payments and the event log keep their rows for good: 2,000 expense rows (deleted ones included), 2,000 payment rows (undone ones included) and 10,000 events per group. All are counted under the group row lock before anything is written, and a write past any of them is refused with 409 `limit_reached`. A group at the event cap can still be read but no longer changed, its link reset excepted (a group must always be able to cut off a leaked link; resets stay under the per-group write limit). A retry that writes nothing is still answered. "Client network" is the address the platform supplies (IPv6 grouped by /64), never a forwarding header the client sent. The exact settle-up search runs only when the count of non-zero balances, taken inside the function that runs it, is at or under a fixed threshold; above it the greedy method runs. Every handler and database statement has a time limit.
- **C27.** Production has no test-only door: no seed, reset or bypass endpoint, flag or header. TestSprite's runners get exactly what an anonymous visitor gets. Each test creates its own groups and never depends on a fixed production group, because anyone can edit a group whose link appears in a public test file or report.
- **C28.** Errors reveal nothing: no stack trace, SQL, connection string, upstream body or token in any response. `/api/health` says up or down and nothing else. Every security check is enforced in the route handler itself, never only in middleware.

### Build, preview and CI
- **C29.** No code from a pull request ever runs where it can read production data or a production secret. Preview database branches hold the schema and synthetic fixtures only; the production database URL and the GitHub token are scoped to Production only; PRs from forks or outside contributors are not built until a maintainer approves. Shown by: a PR that adds a route returning the group count gets only the fixture count on its preview.
- **C30.** The production schema changes only through a migration a human merged to `main`. A preview build can migrate only its own branch.
- **C31.** The self-fix acts only when the PR's branch lives in this repository, its author is a maintainer, the triggering `TestSprite V3` commit status was posted by TestSprite's bot (user id 258111874, the same identity rule as C22) with state `failure`, the head branch is not the default branch, and that run's commit is still the PR's head. It works on exactly that commit. In any other case, or any doubt, it ends without acting.
- **C32.** Untrusted text never becomes code or instructions. No event value is pasted into a shell script (values pass as quoted environment variables). Failure details reach the agent as a data file, marked untrusted. The agent's instructions and settings come only from the workflow on the default branch; settings, hooks, MCP servers and instruction files inside the checked-out PR are not loaded.
- **C33.** Secrets stay apart. No step that runs repository code holds a secret. The TestSprite key exists only in the job that downloads failure details. The agent cannot read any secret, including its own token; its file tools are confined to the checkout; it has no shell, or a shell with no secret in its environment; it has no network beyond its own API; it never holds a push credential. Every job declares minimal `GITHUB_TOKEN` permissions.
- **C34.** The agent's output is checked like an input before it is pushed, by a separate job that runs no repository code and no AI: only files under allowed source paths may change (deny by default; never workflows, tests, migrations, package manifests, lockfiles, agent settings, instruction files, security docs, env files, or the modules that enforce this section); no secret or encoding of one in the diff or commit message; the diff is under a size cap; the workflow writes the commit itself with a fixed message format and pushes only as a fast-forward onto the tested commit, failing if the branch has moved.
- **C35.** At most two self-fix attempts per PR and a fixed number per day overall, counted where the PR author cannot change it; one run per PR at a time; if the count cannot be read, the job does not run.
- **C36.** A green check alone never gets code merged. The required `TestSprite V3` check is pinned to TestSprite's app as its source, so a same-named job cannot satisfy it. No self-fix commit reaches `main` without a human seeing it after the last push.
- **C37.** Nothing in CI or the build pulls in code by a name that can be moved: third-party Actions pinned to full commit SHAs; the TestSprite CLI and Claude Code installed at pinned versions; jobs holding a secret install without running install scripts; public job logs never print failure details, agent transcripts, or anything derived from a secret.

### Link reset
- **C38.** A lost reset answer never leaves a group without a working link. The browser makes the new token and keeps it in this tab's session storage before it sends the reset, so the answer carries no secret that could be lost. Sending the same reset again is safe: when the old token is already dead but the new token is the group's link, the answer is 200 with the group and nothing is written; any other new token with a dead token is a 404. The page sends the reset a second time on any failure or timeout, then tries the new token itself, and adopts it when it opens the group. Covers one lost answer, or both sends failing while the reset landed. If all three tries fail, the new link waits in that tab's session storage: when the page later meets a dead link, it tries up to five kept links before showing not-found, and adopts the first that opens the group named in its key. Not covered: a different tab or device, and a cleared session storage.

### The general standards, applied
1. **Primitives over lists.** Token: one strict decode then a hash lookup (covers guessing and malformed input; not a leaked link). Currency: an ISO 4217 table from a maintained source, never typed by hand (covers existence and minor unit; not live rate availability). Text: Unicode category checks Cc and Cf (covers every control, bidi and zero-width character; not lookalikes). Outbound hosts: WHATWG URL parse, then compare the origin to one constant (covers every host but the one we mean; not that host being compromised). Amounts: one grammar parsed into a big integer (covers malformed input; not a valid typo). Self-fix paths: the one place a list is right, an allow-list that denies by default.
2. **Normalize before you compare.** The token at creation and lookup (same encoding, same hash); currency codes everywhere as exactly three uppercase ASCII letters, never case-folded on one side only; amounts in browser and server through one shared module and table; member ids in one canonical form; member names under one Unicode normalization; check identity by app id everywhere (branch rule, `/checks`, self-fix trigger); commit SHAs as full 40-character lowercase hex; URLs through the WHATWG parser before any origin comparison; client network keys from one platform value with IPv6 masked to /64.
3. **Validate outputs like inputs.** The upstream FX rate through C9; GitHub strings as text and links rebuilt (C23); stored names rendered as text on every read; the settle-up plan checked against balances before it is returned (C12); the agent's diff checked before push (C34); failure details treated as hostile input to the agent (C32); API responses carry only what the client needs; logs never contain a token or a secret.
4. **Fail closed.** Parse error, unknown field, split mode or currency: a 4xx and nothing written. Unknown or missing check: not passed. Any mismatch in the self-fix's app, commit, author, branch or counter: exit without acting. FX failure: no rate offered. Timeouts, size caps and page limits on every outbound call; a database statement timeout and a request body cap; caps per group; a fixed threshold for the exact settle-up search; a daily cap on the self-fix. New environments start with no secrets until scoped; workflow token permissions start at none.
5. **Non-goals.** Penny does not defend against:
   - **Anyone who holds a group's link.** They can do everything a member can, including deleting every expense. "Who did what" is self-reported, because "who are you" is a local choice, not proof.
   - **Lookalike names**, such as a Cyrillic letter inside "Bob".
   - **Whether a payment really happened.** Recording a payment is a claim; Penny moves no money.
   - **Rate accuracy.** The suggested rate is the ECB daily reference rate, not what a bank charged. The rate the user enters is the one that counts.
   - **A compromised GitHub, Vercel, Neon, TestSprite or Anthropic**, including the authenticity of the webhooks between them, which Penny never sees.
   - **Whether TestSprite's verdict is right.** A green check means TestSprite's tests passed, nothing more.
   - **Privacy of pull request data on `/checks`.** It is already public on GitHub.
   - **Denial of service beyond what the hosting platform absorbs.**
   - **The runtime changing the schema.** The app connects as the database owner role that Neon's integration provides, so code running as the app could change the schema or drop the triggers that keep events append-only. The triggers stop a bug or a stray statement, not the owner.
   - **Inline script under the content security policy.** The policy allows inline scripts because Next.js inlines its own bootstrap scripts into prerendered pages. Injected markup is stopped by React's escaping and the Cc/Cf refusal, not by the policy.
   - **A malicious maintainer.**

---

## Open at the architecture gate

- **Where the link token lives** (A2, C4): in the URL path (and named as a non-goal: it lands in hosting logs and cannot be revoked), in the URL fragment sent as a request header (never reaches a server log or a Referer), and whether to add a "reset link" button. Ram's call.
- **Preview database contents** (C29): previews must branch from a schema-and-fixtures parent, never from production data. To verify Neon's integration supports this on day one.
- **Human sight of self-fix commits** (C36): GitHub does not let a PR's author approve their own PR, so the rule is met by Ram merging any PR that carries a self-fix commit himself.

## Unverified assumptions (checked before the code that depends on them)

- Whether Neon's Vercel integration copies production rows into preview branches, and whether schema-only branches are available on the free plan.
- Whether Vercel builds fork PRs without a maintainer's approval under this project's settings.
- Whether headless Claude Code loads a checkout's `.claude/settings.json` hooks and `.mcp.json`, and whether its Read tool can reach `/proc/self/environ`. C32 and C33 assume yes to both.
- CLDR versus ISO 4217 digit mismatches (IQD recalled from memory): confirm with one `Intl` call before any public page names one.
- Whether TestSprite's public report pages show preview or production page content, including group links.
