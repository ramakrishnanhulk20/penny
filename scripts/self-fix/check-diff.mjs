import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_CHANGED_LINES = 200;
export const MAX_PATCH_BYTES = 200_000;
export const MAX_LISTED_PATHS = 30;

export const RULES = {
  "empty-patch": "The agent proposed no change.",
  malformed: "The patch could not be read with certainty, so it was refused.",
  "path-not-allowed": "Only files under packages/web/src or packages/core/src may change.",
  "path-denied":
    "The patch touches a file the self-fix may never change: a test, a config, a package or lock file, an agent instruction file, a security module, anything in a node_modules folder, or a file or folder whose name starts with a dot, such as .env, .git or .claude.",
  "file-type": "Only .ts, .tsx and .css files may change.",
  "new-endpoint":
    "The patch adds a new file under the app's routes, or a route handler, middleware, proxy or instrumentation file anywhere, which could open a new way into the server.",
  "shadows-denied":
    "The patch adds a file that could be loaded in place of a security module: the same name with another extension, or a folder with that name.",
  deletion: "The patch deletes a file.",
  rename: "The patch renames or copies a file.",
  "mode-change": "The patch changes a file mode or adds a file that is not a plain file.",
  binary: "The patch adds or changes a binary file.",
  "too-large": `The patch changes more than ${MAX_CHANGED_LINES} lines or is larger than ${MAX_PATCH_BYTES.toLocaleString("en-US")} bytes.`,
  "secret-pattern": "An added line or a file path looks like a secret or an encoded secret.",
  "hidden-characters":
    "An added line holds an invisible or text-direction character, which can make code read differently from how it runs.",
  "process-env":
    "An added line names the process or global object, the server's env module or database settings, or a way to run text as code (eval, Function, require, import.meta).",
  "git-disagrees": "Git reads the patch differently from the checker.",
};

const ALLOWED_ROOTS = ["packages/web/src/", "packages/core/src/"];
const DENIED_FILES = new Set([
  "packages/web/src/lib/group-token.ts",
  "packages/web/src/lib/groups.ts",
  "packages/web/src/lib/rate-limit.ts",
  "packages/web/src/lib/http.ts",
  "packages/web/src/lib/env.ts",
  "packages/web/src/lib/text.ts",
  "packages/web/src/lib/api-schemas.ts",
]);
const DENIED_DIRS = ["packages/web/src/db/"];
// An import names a module without its extension, and the bundler tries .js before .ts, so a
// new groups.js or groups/index.ts would be loaded in place of groups.ts. Compared in lower
// case, and up to the first dot, so groups.d.ts and Groups.tsx count as the same name.
const PROTECTED_MODULES = new Set(
  [...DENIED_FILES, ...DENIED_DIRS.map((dir) => dir.slice(0, -1))].map((path) => withoutExtensions(path.toLowerCase())),
);
// Names compared in lower case so a case variant on a case-insensitive disk cannot slip by.
const DENIED_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "claude.md",
  "claude.local.md",
  "agents.md",
]);
// Node resolves a bare import from the nearest node_modules folder up the tree, so a folder
// of that name under src would replace a real package. Dot names cover .git, .github,
// .claude, .env files and the .gitignore that could un-ignore such a folder.
const DENIED_SEGMENTS = new Set(["__tests__", "node_modules"]);
const ALLOWED_EXTENSIONS = [".ts", ".tsx", ".css"];
// Next.js turns a file with one of these names into server code that answers requests.
const ENDPOINT_NAMES = new Set(["route", "middleware", "proxy", "instrumentation", "instrumentation-client"]);
// Next.js serves far more than route.ts from the app folder (pages, layouts, sitemaps, metadata
// images, each of which runs server code), and a list of those names would miss the next one.
// So no new file may appear there at all; edits to files already there stay allowed. The older
// pages folder is served the same way (pages/api/x.ts is an endpoint), so it counts too.
const APP_ROUTES_ROOTS = ["packages/web/src/app/", "packages/web/src/pages/"];
const SAFE_PATH = /^[A-Za-z0-9._@()[\]-]+(?:\/[A-Za-z0-9._@()[\]-]+)*$/;

class Refusal extends Error {
  constructor(rule) {
    super(rule);
    this.rule = rule;
  }
}

/**
 * Parses a `git diff` patch into one entry per file. Throws a Refusal for anything the
 * checker does not positively understand: renames, copies, deletions, mode changes,
 * binary content, unknown header lines, quoted or ambiguous paths, or hunks whose line
 * counts do not match their headers.
 */
export function parsePatch(text) {
  if (text.includes("\0")) throw new Refusal("binary");
  if (text.includes("\r")) throw new Refusal("malformed");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]);
    if (!header) throw new Refusal("malformed");
    const file = { path: header[2], isNew: false, added: [], addedCount: 0, removedCount: 0 };
    i += 1;

    while (i < lines.length && !lines[i].startsWith("--- ") && !lines[i].startsWith("diff --git ")) {
      const line = lines[i];
      const newFile = /^new file mode ([0-7]{6})$/.exec(line);
      const index = /^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: ([0-7]{6}))?$/.exec(line);
      if (newFile) {
        if (newFile[1] !== "100644") throw new Refusal("mode-change");
        file.isNew = true;
      } else if (index) {
        if (index[1] !== undefined && index[1] !== "100644") throw new Refusal("mode-change");
      } else if (line.startsWith("deleted file mode ")) {
        throw new Refusal("deletion");
      } else if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
        throw new Refusal("mode-change");
      } else if (/^(similarity index|rename from|rename to|copy from|copy to) /.test(line)) {
        throw new Refusal("rename");
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        throw new Refusal("binary");
      } else {
        throw new Refusal("malformed");
      }
      i += 1;
    }

    if (header[1] !== header[2]) throw new Refusal("malformed");
    const expectedOld = file.isNew ? "--- /dev/null" : `--- a/${file.path}`;
    if (lines[i] !== expectedOld || lines[i + 1] !== `+++ b/${file.path}`) throw new Refusal("malformed");
    i += 2;

    let hunks = 0;
    while (i < lines.length && lines[i].startsWith("@@ ")) {
      const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
      if (!counts) throw new Refusal("malformed");
      let oldLeft = counts[1] === undefined ? 1 : Number(counts[1]);
      let newLeft = counts[2] === undefined ? 1 : Number(counts[2]);
      i += 1;
      while (oldLeft > 0 || newLeft > 0) {
        if (i >= lines.length) throw new Refusal("malformed");
        const line = lines[i];
        const mark = line[0];
        // git apply reads a fully empty line inside a hunk as an empty context line.
        if (mark === " " || line === "") {
          oldLeft -= 1;
          newLeft -= 1;
        } else if (mark === "-") {
          oldLeft -= 1;
          file.removedCount += 1;
        } else if (mark === "+") {
          newLeft -= 1;
          file.addedCount += 1;
          file.added.push(line.slice(1));
        } else if (mark !== "\\") {
          throw new Refusal("malformed");
        }
        if (oldLeft < 0 || newLeft < 0) throw new Refusal("malformed");
        i += 1;
      }
      if (i < lines.length && lines[i].startsWith("\\")) i += 1;
      hunks += 1;
    }
    if (hunks === 0) throw new Refusal("malformed");
    files.push(file);
  }
  return files;
}

export function isAllowedPath(path) {
  if (!SAFE_PATH.test(path)) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return ALLOWED_ROOTS.some((root) => path.startsWith(root));
}

export function isDeniedPath(path) {
  if (DENIED_FILES.has(path)) return true;
  if (DENIED_DIRS.some((dir) => path.startsWith(dir))) return true;
  const segments = path.toLowerCase().split("/");
  const base = segments.at(-1);
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment) || segment.startsWith("."))) return true;
  if (DENIED_BASENAMES.has(base)) return true;
  return /\.(test|spec|config)\./.test(base);
}

export function hasAllowedFileType(path) {
  return ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function isEndpointFile(path) {
  return ENDPOINT_NAMES.has(path.split("/").at(-1).toLowerCase().split(".")[0]);
}

/** True for any path under a folder Next.js serves as routes, compared in lower case like the other path rules. */
export function isInAppRoutes(path) {
  const lower = path.toLowerCase();
  return APP_ROUTES_ROOTS.some((root) => lower.startsWith(root));
}

function withoutExtensions(path) {
  const slash = path.lastIndexOf("/");
  return path.slice(0, slash + 1) + path.slice(slash + 1).split(".")[0];
}

/**
 * True when the path, or any folder on it, has a protected module's name once extensions
 * are dropped: `lib/groups.tsx`, `lib/group-token.js`, `lib/groups/index.ts`, `src/db.ts`.
 * Does not cover a module reached through a different import path, such as a new alias.
 */
export function shadowsProtectedModule(path) {
  const segments = path.toLowerCase().split("/");
  return segments.some((segment, i) => PROTECTED_MODULES.has(withoutExtensions([...segments.slice(0, i), segment].join("/"))));
}

const SECRET_MARKERS = [
  /(^|[^A-Za-z0-9])sk-/,
  /(^|[^A-Za-z0-9])gh[pousr]_/,
  /github_pat_/,
  /-----BEGIN/,
  /CLAUDE_CODE_OAUTH_TOKEN/,
  /TESTSPRITE_API_KEY/,
  /[0-9a-fA-F]{40,}/,
];
const BASE64_RUN = /[A-Za-z0-9+/_-]{40,}/g;

/**
 * Covers: the token prefixes of OpenAI-style and Anthropic keys, GitHub tokens, PEM keys,
 * this workflow's secret names, any 40+ character hex run, and any 40+ character base64
 * or base64url run that mixes upper case, lower case and digits, which is how an encoded
 * token looks. Does not cover a secret split across lines or strings, or one encoded in
 * a scheme that avoids those shapes.
 */
export function looksLikeSecret(line) {
  if (SECRET_MARKERS.some((pattern) => pattern.test(line))) return true;
  for (const [run] of line.matchAll(BASE64_RUN)) {
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}

/**
 * Covers every Unicode format character (category Cf), which includes the bidirectional
 * controls U+202A to U+202E and U+2066 to U+2069, the zero-width U+200B to U+200F, U+FEFF
 * and the soft hyphen U+00AD, plus the line and paragraph separators U+2028 and U+2029,
 * which end a JavaScript comment without starting a visible new line. Does not cover
 * characters that are visible but look alike, such as a Cyrillic letter in a word.
 */
export function hasHiddenCharacters(line) {
  return /[\p{Cf}\p{Zl}\p{Zp}]/u.test(line);
}

const SERVER_SECRET_SIGNS = [
  /process/,
  /globalThis/,
  /serverEnv/,
  /DATABASE_URL/,
  /connectionString/,
  /import\s*\.\s*meta/,
  /eval\s*\(/,
  /Function\s*\(/,
  /require\s*\(/,
  // The audit's follow-up bypasses: the bare global object, a Function reached through any
  // constructor, a computed dynamic import, the database driver's own options, server actions.
  /\bglobal\s*[[.]/,
  /constructor/,
  /\bimport\s*\(/,
  /\$client/,
  /["'`]use server["'`]/,
  // Any quoted module path whose last part is env: "@/lib/env", "./env", "../lib/env.ts".
  /["'`][^"'`]*\/env(?:\.[^"'`/]*)?["'`]/i,
];

/**
 * Covers any line that names the process object or the global object (so an alias made on
 * this line and used on the next is caught where it is made), the env module and its
 * serverEnv helper, the database URL and connection string, import.meta, and eval, Function
 * and require calls, with or without spaces before the bracket. Matches text anywhere in the
 * line, so it also refuses comments and copy that contain these words. Does not cover the
 * global object reached under another name (`global`, `[].constructor.constructor`), a
 * dynamic `import()` of a built-up path, identifier escapes such as `globalThis`, or
 * the database client's own settings read through `withDb`.
 */
export function readsEnvironment(line) {
  return SERVER_SECRET_SIGNS.some((pattern) => pattern.test(line));
}

/**
 * @returns {{ ok: true, files: { path: string, isNew: boolean, added: number, removed: number }[], changedLines: number }
 *   | { ok: false, rule: string }}
 */
export function checkPatch(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_BYTES) return { ok: false, rule: "too-large" };
  let files;
  try {
    files = parsePatch(text);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, rule: error.rule };
    throw error;
  }
  if (files.length === 0) return { ok: false, rule: "empty-patch" };

  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path)) return { ok: false, rule: "malformed" };
    seen.add(file.path);
    if (!isAllowedPath(file.path)) return { ok: false, rule: "path-not-allowed" };
    if (isDeniedPath(file.path)) return { ok: false, rule: "path-denied" };
    if (file.isNew && shadowsProtectedModule(file.path)) return { ok: false, rule: "shadows-denied" };
    if (file.isNew && (isInAppRoutes(file.path) || isEndpointFile(file.path))) return { ok: false, rule: "new-endpoint" };
    if (!hasAllowedFileType(file.path)) return { ok: false, rule: "file-type" };
    // A path is pushed and posted in the comment just like an added line.
    if (looksLikeSecret(file.path)) return { ok: false, rule: "secret-pattern" };
  }

  const changedLines = files.reduce((sum, file) => sum + file.addedCount + file.removedCount, 0);
  if (changedLines > MAX_CHANGED_LINES) return { ok: false, rule: "too-large" };

  for (const file of files) {
    for (const line of file.added) {
      if (hasHiddenCharacters(line)) return { ok: false, rule: "hidden-characters" };
      if (looksLikeSecret(line)) return { ok: false, rule: "secret-pattern" };
      if (readsEnvironment(line)) return { ok: false, rule: "process-env" };
    }
  }

  return {
    ok: true,
    files: files.map((file) => ({ path: file.path, isNew: file.isNew, added: file.addedCount, removed: file.removedCount })),
    changedLines,
  };
}

export function parseNumstat(output) {
  const records = output.split("\0").filter((record) => record !== "");
  return records.map((record) => {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(record);
    if (!match) return null;
    return { path: match[3], added: Number(match[1]), removed: Number(match[2]) };
  });
}

// The patch is applied by git, so the checker's reading must match git's own reading of
// the same bytes: same files, same added and removed counts.
export function agreesWithGit(files, numstat) {
  if (numstat.length !== files.length || numstat.some((entry) => entry === null)) return false;
  const byPath = new Map(numstat.map((entry) => [entry.path, entry]));
  if (byPath.size !== files.length) return false;
  return files.every((file) => {
    const entry = byPath.get(file.path);
    return entry !== undefined && entry.added === file.added && entry.removed === file.removed;
  });
}

export function commentFor(result) {
  if (result.ok) {
    const shown = result.files.slice(0, MAX_LISTED_PATHS).map((file) => `- \`${file.path}\`${file.isNew ? " (new)" : ""}`);
    const hidden = result.files.length - shown.length;
    if (hidden > 0) shown.push(`- and ${hidden} more ${hidden === 1 ? "file" : "files"}`);
    const list = shown.join("\n");
    return `The self-fix changed these files to make the failing TestSprite tests pass:\n\n${list}\n\nTestSprite will test the new preview. A person merges.\n`;
  }
  return `The self-fix checker refused this attempt, so nothing was pushed.\n\nRule: \`${result.rule}\`. ${RULES[result.rule]}\n`;
}

export function isKnownRule(rule) {
  return typeof rule === "string" && Object.hasOwn(RULES, rule);
}

function gitNumstat(patchPath) {
  const absolute = resolve(patchPath);
  try {
    // Run beside the patch, outside any checkout: inside a repository subfolder git apply
    // skips paths outside that folder, which would hide files from this count.
    const output = execFileSync("git", ["apply", "--numstat", "-z", absolute], {
      cwd: dirname(absolute),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    return parseNumstat(output);
  } catch {
    return null;
  }
}

// The fix job checks the patch first and never uploads a refused one, so the push job
// receives only the rule's name. That name crossed a job boundary, so it must be one of
// the known rules before any text is built from it.
function writeRefusal(rule) {
  if (!isKnownRule(rule)) {
    console.log("refused: the rule name is not one the checker knows");
    process.exitCode = 1;
    return;
  }
  if (process.env.COMMENT_FILE) writeFileSync(process.env.COMMENT_FILE, commentFor({ ok: false, rule }));
  console.log(`refused: ${rule}`);
}

function main() {
  if (process.argv[2] === "--refused") return writeRefusal(process.argv[3]);
  const patchPath = process.argv[2];
  if (!patchPath) {
    console.log("usage: node check-diff.mjs <patch-file> | --refused <rule>");
    process.exit(2);
  }
  const bytes = readFileSync(patchPath);
  const text = bytes.toString("utf8");
  // Invalid UTF-8 would be read one way here and another way by git.
  let result = Buffer.from(text, "utf8").equals(bytes) ? checkPatch(text) : { ok: false, rule: "binary" };
  if (result.ok) {
    const numstat = gitNumstat(patchPath);
    if (numstat === null || !agreesWithGit(result.files, numstat)) result = { ok: false, rule: "git-disagrees" };
  }

  if (process.env.COMMENT_FILE) writeFileSync(process.env.COMMENT_FILE, commentFor(result));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `ok=${result.ok}\nrule=${result.ok ? "" : result.rule}\n`);
  }
  if (result.ok) {
    console.log(`passed: ${result.files.length} files, ${result.changedLines} changed lines`);
  } else {
    console.log(`refused: ${result.rule}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
