import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  absolutePathReplacementExpressions,
  generatedLogSanitizationCallback,
} from "../src/anonymization/path-sanitization";
import { makeTempDir } from "./git-fixtures";

// Anonymization runs inside git-filter-repo: generated `.log/`/`.chat-log/`
// blobs go through the generated Python callback, all other files through
// the `--replace-text` rules. Both are exercised here with a real python3.

const REPO = path.resolve("/Users/alice/study/repo");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** Runs a Python script with `input` on stdin and returns stdout or the error. */
function runPython(script: string, input: string): { out?: string; err?: string } {
  const file = path.join(makeTempDir("fr-test-py-"), "harness.py");
  fs.writeFileSync(file, script);
  const res = spawnSync("python3", ["-I", file], { input, encoding: "utf8" });
  return res.status === 0 ? { out: res.stdout } : { err: res.stderr || String(res.error) };
}

/** Runs the generated filter-repo file-info callback on `input` as a `.log/` blob. */
function sanitizeGeneratedLog(repoRoot: string, input: string) {
  const body = generatedLogSanitizationCallback(repoRoot)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return runPython(`
import sys
class Value:
    original = sys.stdin.buffer.read()
    def get_contents_by_identifier(self, blob_id):
        return self.original
    def insert_file_with_contents(self, contents):
        sys.stdout.buffer.write(contents)
        return b"new"
def callback(filename, mode, blob_id, value):
${body}
value = Value()
result = callback(b".log/claude.log", b"100644", b"old", value)
if result[2] == b"old":
    sys.stdout.buffer.write(value.original)
`, input);
}

/** Applies `--replace-text` rules the way git-filter-repo does (literal or `regex:` lines). */
function applyReplaceText(rules: string[], input: string) {
  return runPython(`
import re, sys, json
rules = json.loads(${JSON.stringify(JSON.stringify(rules))})
data = sys.stdin.buffer.read()
for rule in rules:
    search, _, replacement = rule.partition("==>")
    if search.startswith("regex:"):
        data = re.sub(search[6:].encode(), replacement.encode(), data)
    else:
        data = data.replace(search.encode(), replacement.encode())
sys.stdout.buffer.write(data)
`, input);
}

/** Asserts each [input, expected] pair through the generated-log callback. */
function assertGeneratedLog(cases: Array<[string, string]>, repoRoot = REPO) {
  for (const [input, expected] of cases) {
    const res = sanitizeGeneratedLog(repoRoot, input);
    assert.equal(res.err, undefined, res.err);
    assert.equal(res.out, expected, input);
  }
}

test("generated logs: absolute paths in every form are replaced", { skip: !hasPython }, () => {
  assertGeneratedLog([
    ["open /Users/alice/secret.txt now", "open <ABSOLUTE_PATH> now"],
    // Known limitation: punctuation directly after a path is swallowed with it.
    ["see /tmp/x.", "see <ABSOLUTE_PATH>"],
    ["path=C:\\Users\\alice\\x.ts", "path=<ABSOLUTE_PATH>"],
    ["\"/Users/alice/My Docs/a.txt\"", "\"<ABSOLUTE_PATH>\""],
    ["'C:/Users/alice/My Docs/a.txt'", "'<ABSOLUTE_PATH>'"],
    ["{\"file_path\":\"/Users/alice/a.ts\"}", "{\"file_path\":\"<ABSOLUTE_PATH>\"}"],
  ]);
});

test("generated logs: file URIs become one clean placeholder", { skip: !hasPython }, () => {
  assertGeneratedLog([
    ["uri file:///Users/alice/x.ts end", "uri file:///<ABSOLUTE_PATH> end"],
    [`uri ${pathToFileURL(REPO).href}/src/app.ts`, "uri file:///<REPO_ROOT>/src/app.ts"],
  ]);
});

test("generated logs: repo root matches the drive-letter spellings VS Code uses", { skip: !hasPython || process.platform !== "win32" }, () => {
  // On Windows REPO is e.g. `E:\Users\alice\study\repo`; VS Code writes `e:` and `e%3A`.
  const lowerUri = pathToFileURL(REPO).href.replace(/^file:\/\/\/([A-Z]):/, (_, d: string) => `file:///${d.toLowerCase()}:`);
  const lowerPath = REPO[0].toLowerCase() + REPO.slice(1);
  assertGeneratedLog([
    [`uri ${lowerUri}/src/app.ts`, "uri file:///<REPO_ROOT>/src/app.ts"],
    [`uri ${lowerUri.replace(/^(file:\/\/\/[a-z]):/, "$1%3A")}/src/app.ts`, "uri file:///<REPO_ROOT>/src/app.ts"],
    [`edit ${lowerPath}\\src\\app.ts`, "edit <REPO_ROOT>\\src\\app.ts"],
  ]);
});

test("generated logs: repo paths keep their relative part and usernames are removed", { skip: !hasPython }, () => {
  assertGeneratedLog([
    [`edit ${REPO}/src/app.ts`, "edit <REPO_ROOT>/src/app.ts"],
    [`cwd: ${REPO}`, "cwd: <REPO_ROOT>"],
    ["Logged in as alice-gh, ok", "Logged in as <COPILOT_USER>, ok"],
    ["Got Copilot token for alice-gh", "Got Copilot token for <COPILOT_USER>"],
    ["{\"accountLabel\": \"alice-gh\"}", "{\"accountLabel\": \"<COPILOT_USER>\"}"],
  ]);
});

test("generated logs: relative paths, fractions, URLs and markup stay intact", { skip: !hasPython }, () => {
  assertGeneratedLog([
    "src/app.ts and ./x and ../y",
    "ratio 1/2",
    "see https://example.com/docs/page",
    "<div>text</div>",
  ].map((input) => [input, input]));
});

test("generated logs: repo roots with non-ASCII characters work", { skip: !hasPython }, () => {
  const repo = path.resolve("/Users/jürgen/studie/repo");
  assertGeneratedLog([[`edit ${repo}/a.ts`, "edit <REPO_ROOT>/a.ts"]], repo);
});

test("replace-text rules: repoOnly rewrites only the repo root, none rewrites nothing", { skip: !hasPython }, () => {
  assert.deepEqual(absolutePathReplacementExpressions(REPO, "none"), []);
  const input = `const root = "${REPO}/src"; // see /etc/hosts`;
  const res = applyReplaceText(absolutePathReplacementExpressions(REPO, "repoOnly"), input);
  assert.equal(res.err, undefined, res.err);
  assert.equal(res.out, "const root = \"<REPO_ROOT>/src\"; // see /etc/hosts");
});

test("replace-text rules: 'all' rewrites absolute paths but keeps URLs in source code", { skip: !hasPython }, () => {
  const rules = absolutePathReplacementExpressions(REPO, "all");
  const res = applyReplaceText(
    rules,
    "const p = \"/Users/alice/a.ts\";\nfetch(\"https://example.com/api\"); // see docs\n"
  );
  assert.equal(res.err, undefined, res.err);
  assert.equal(
    res.out,
    "const p = \"<ABSOLUTE_PATH>\";\nfetch(\"https://example.com/api\"); // see docs\n"
  );
});
