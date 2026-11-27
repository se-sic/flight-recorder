import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { GitOperationWatcher, parseReflogLine } from "../src/recording/git-operations";
import { git, makeRepo } from "./git-fixtures";

/** Writes `files` (relative path → content) into `repo` and commits them. */
function commitFiles(repo: string, message: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

/** Starts a watcher on `repo`, failing the test if git cannot be read. */
async function watch(repo: string): Promise<GitOperationWatcher> {
  const watcher = await GitOperationWatcher.create(repo);
  assert.ok(watcher);
  return watcher;
}

/** Relative paths of an operation, for readable assertions. */
function rel(repo: string, paths: string[]): string[] {
  return paths.map((p) => path.relative(repo, p).split(path.sep).join("/"));
}

test("parses reflog lines", () => {
  const entry = parseReflogLine(`${"a".repeat(40)} ${"b".repeat(40)} Test User <t@example.com> 1700000000 +0100\tpull: Fast-forward`);
  assert.deepEqual(entry, { oldSha: "a".repeat(40), newSha: "b".repeat(40), at: 1_700_000_000_000, message: "pull: Fast-forward" });
  assert.equal(parseReflogLine("garbage"), null);
});

test("commits are not operations, a hard reset is", async () => {
  const repo = makeRepo();
  commitFiles(repo, "one", { "a.txt": "1\n", "b.txt": "1\n" });
  const watcher = await watch(repo);

  commitFiles(repo, "two", { "a.txt": "2\n" });
  git(repo, "commit", "-q", "--amend", "-m", "two, amended");
  assert.deepEqual(await watcher.poll(), []);

  git(repo, "reset", "-q", "--hard", "HEAD~1");
  const [reset] = await watcher.poll();
  assert.equal(reset.kind, "operation");
  assert.match(reset.description, /^reset: moving to HEAD~1/);
  assert.deepEqual(rel(repo, reset.paths), ["a.txt"]);
  assert.deepEqual(await watcher.poll(), [], "each operation is reported once");
});

test("a mixed reset leaves the files alone and is no operation", async () => {
  const repo = makeRepo();
  commitFiles(repo, "one", { "a.txt": "1\n" });
  const watcher = await watch(repo);
  git(repo, "reset", "-q", "HEAD~1");
  assert.deepEqual(await watcher.poll(), []);
});

test("a merge reports the files it brought in, including deletions", async () => {
  const repo = makeRepo();
  commitFiles(repo, "base", { "keep.txt": "1\n", "gone.txt": "1\n" });
  git(repo, "checkout", "-q", "-b", "feature");
  fs.rmSync(path.join(repo, "gone.txt"));
  commitFiles(repo, "feature", { "new.txt": "new\n", "keep.txt": "2\n" });
  git(repo, "checkout", "-q", "main");
  const watcher = await watch(repo);

  git(repo, "merge", "-q", "--ff-only", "feature");
  const [merge] = await watcher.poll();
  assert.equal(merge.kind, "operation");
  assert.match(merge.description, /^merge feature: Fast-forward/);
  assert.deepEqual(rel(repo, merge.paths), ["gone.txt", "keep.txt", "new.txt"]);
});

test("switching branches is reported with its from and to", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "other");
  commitFiles(repo, "other", { "o.txt": "o\n" });
  git(repo, "checkout", "-q", "main");
  const watcher = await watch(repo);

  git(repo, "checkout", "-q", "other");
  const [first] = await watcher.poll();
  assert.equal(first.kind, "branch-switch");
  assert.equal(first.kind === "branch-switch" && `${first.from} -> ${first.to}`, "main -> other");
  assert.deepEqual(rel(repo, first.paths), ["o.txt"]);

  git(repo, "checkout", "-q", "-b", "fresh");
  const [second] = await watcher.poll();
  assert.equal(second.kind === "branch-switch" && `${second.from} -> ${second.to}`, "other -> fresh");
  assert.deepEqual(second.paths, [], "a new branch at the same commit changes no files");
});

test("a rebase is one operation", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "topic");
  commitFiles(repo, "t1", { "t.txt": "1\n" });
  commitFiles(repo, "t2", { "t.txt": "2\n" });
  git(repo, "checkout", "-q", "main");
  commitFiles(repo, "m", { "m.txt": "m\n" });
  git(repo, "checkout", "-q", "topic");
  const watcher = await watch(repo);

  git(repo, "rebase", "-q", "main");
  const operations = await watcher.poll();
  assert.equal(operations.length, 1, JSON.stringify(operations));
  assert.match(operations[0].description, /^rebase/);
  assert.deepEqual(rel(repo, operations[0].paths), ["m.txt"]);
});

test("stash and stash pop are operations on the stashed files", async () => {
  const repo = makeRepo();
  commitFiles(repo, "one", { "a.txt": "1\n" });
  const watcher = await watch(repo);

  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
  git(repo, "stash", "push", "-q", "-u");
  const [stash] = await watcher.poll();
  assert.equal(stash.description, "stash");
  assert.deepEqual(rel(repo, stash.paths), ["a.txt", "untracked.txt"]);

  git(repo, "stash", "pop", "-q");
  const [pop] = await watcher.poll();
  assert.equal(pop.description, "stash pop");
  assert.deepEqual(rel(repo, pop.paths), ["a.txt", "untracked.txt"]);
});

test("dropping a stash changes no files", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  git(repo, "stash", "-q");
  const watcher = await watch(repo);
  git(repo, "stash", "drop", "-q");
  assert.deepEqual(await watcher.poll(), []);
});
