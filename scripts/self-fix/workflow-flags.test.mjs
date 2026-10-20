// Not covered here: whether the flags do what the docs say, which the self-test workflow
// proves on a real runner, or flags set through environment variables or settings files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
// The self-test needs a line-by-line transcript to inspect, so only the output shape may differ.
const OUTPUT_ONLY = new Set(["--output-format", "--verbose"]);
const TAKES_VALUE = new Set(["--output-format"]);

// Splits a bash command into words the way bash would for this simple shape: quotes are
// removed, and the first unquoted redirection or operator ends the command.
function shellWords(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    if (word === null && /[<>|&;]/.test(c)) break;
    if (word === null && /\d/.test(c) && command[i + 1] === ">") break;
    word ??= "";
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      assert.notEqual(end, -1, "unclosed single quote");
      word += command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (command[j] !== '"') {
        assert.ok(j < command.length, "unclosed double quote");
        if (command[j] === "\\") j += 1;
        word += command[j];
        j += 1;
      }
      i = j;
    } else if (c === "\\") {
      i += 1;
      word += command[i];
    } else {
      word += c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

function claudeCommand(workflow) {
  const lines = workflow.split("\n");
  const starts = lines.flatMap((line, i) => (/^\s*node "\$CLAUDE_CLI"\s/.test(line) ? [i] : []));
  assert.equal(starts.length, 1, "the workflow should start Claude Code exactly once");
  let command = "";
  for (let i = starts[0]; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.endsWith("\\")) {
      command += line;
      break;
    }
    command += `${line.slice(0, -1)} `;
  }
  return shellWords(command);
}

function comparableFlags(words) {
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    const flag = words[i].split("=")[0];
    if (OUTPUT_ONLY.has(flag)) {
      if (TAKES_VALUE.has(words[i]) && !words[i].includes("=")) i += 1;
      continue;
    }
    kept.push(words[i]);
  }
  return kept;
}

const read = (name) => readFileSync(join(WORKFLOWS, name), "utf8");

test("the self-test runs Claude Code with exactly the real self-fix flags, apart from the output shape", () => {
  const fix = comparableFlags(claudeCommand(read("self-fix.yml")));
  const selftest = comparableFlags(claudeCommand(read("self-fix-selftest.yml")));
  assert.ok(fix.includes("--permission-mode") && fix.includes("--disallowedTools") && fix.length > 20, fix.join(" "));
  assert.deepEqual(selftest, fix);
});

test("the comparison notices a flag that is missing, added or changed", () => {
  const workflow = read("self-fix-selftest.yml");
  const real = comparableFlags(claudeCommand(read("self-fix.yml")));
  const edits = [
    workflow.replace(" --safe-mode \\\n", " \\\n"),
    workflow.replace("--max-turns 30", "--max-turns 31"),
    workflow.replace('"mcp__*"', '"mcp__*" Edit'),
    workflow.replace("--permission-prompts none \\\n", "--permission-prompts none \\\n            --dangerously-skip-permissions \\\n"),
  ];
  for (const edited of edits) {
    assert.notEqual(edited, workflow, "the edit should change the workflow text");
    assert.notDeepEqual(comparableFlags(claudeCommand(edited)), real);
  }
});

test("the word splitter keeps quoted JSON whole and stops at the first redirection", () => {
  assert.deepEqual(shellWords(`node "$CLAUDE_CLI" --mcp-config '{"mcpServers":{}}' "a b" c\\ d > out 2> err || status=$?`), [
    "node",
    "$CLAUDE_CLI",
    "--mcp-config",
    '{"mcpServers":{}}',
    "a b",
    "c d",
  ]);
  assert.deepEqual(shellWords("x 2> err"), ["x"]);
});
