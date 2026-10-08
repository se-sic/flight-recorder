import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  commitAssistantLogSnapshot,
  commitChatExportSnapshot,
  commitTrackedWindow,
} from "../src/recording/commits";
import { gitCmd } from "../src/utils/git";
import type { WindowCommit } from "../src/recording/staging-tracker";

async function createRepo(): Promise<string> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fr-commits-"));
  await gitCmd(["init"], repoRoot);
  await gitCmd(["config", "user.name", "Test User"], repoRoot);
  await gitCmd(["config", "user.email", "test@example.com"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "base\n", "utf8");
  await gitCmd(["add", "tracked.txt"], repoRoot);
  await gitCmd(["commit", "-m", "base"], repoRoot);
  return repoRoot;
}

function humanCommit(repoRoot: string, files: string[]): WindowCommit {
  return {
    kind: "human",
    files: files.map((file) => path.join(repoRoot, file)),
    startedAt: 1_000,
    endedAt: 2_000,
  };
}

test("commitTrackedWindow leaves unrelated pre-staged files out of path-specific commits", async () => {
  const repoRoot = await createRepo();

  fs.writeFileSync(path.join(repoRoot, "preexisting.txt"), "preexisting\n", "utf8");
  await gitCmd(["add", "preexisting.txt"], repoRoot);
  fs.appendFileSync(path.join(repoRoot, "tracked.txt"), "flight recorder\n", "utf8");

  const result = await commitTrackedWindow(
    repoRoot,
    humanCommit(repoRoot, ["tracked.txt"]),
    false,
    false,
    false
  );

  assert.equal(result.ok, true);

  const headFiles = await gitCmd(["show", "--name-only", "--format=", "HEAD"], repoRoot);
  assert.deepEqual(
    headFiles.out.trim().split(/\r?\n/).filter(Boolean),
    ["tracked.txt"]
  );

  const staged = await gitCmd(["diff", "--cached", "--name-status"], repoRoot);
  assert.equal(staged.out.trim(), "A\tpreexisting.txt");
});

test("commitTrackedWindow with no files does not fall back to staging the whole repo", async () => {
  const repoRoot = await createRepo();

  fs.writeFileSync(path.join(repoRoot, "preexisting.txt"), "preexisting\n", "utf8");

  const result = await commitTrackedWindow(
    repoRoot,
    humanCommit(repoRoot, []),
    false,
    false,
    false
  );

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);

  const status = await gitCmd(["status", "--short"], repoRoot);
  assert.equal(status.out.trim(), "?? preexisting.txt");
});

test("commitAssistantLogSnapshot leaves unrelated pre-staged files staged", async () => {
  const repoRoot = await createRepo();

  fs.writeFileSync(path.join(repoRoot, "preexisting.txt"), "preexisting\n", "utf8");
  await gitCmd(["add", "preexisting.txt"], repoRoot);
  const sourceLog = path.join(repoRoot, "source.log");
  fs.writeFileSync(sourceLog, "assistant log\n", "utf8");

  const result = await commitAssistantLogSnapshot(
    repoRoot,
    sourceLog,
    "copilot",
    false,
    true
  );

  assert.equal(result.ok, true);

  const headFiles = await gitCmd(["show", "--name-only", "--format=", "HEAD"], repoRoot);
  const committedFiles = headFiles.out.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(committedFiles.length, 1);
  assert.match(committedFiles[0], /^\.log\/copilot-/);

  const staged = await gitCmd(["diff", "--cached", "--name-status"], repoRoot);
  assert.equal(staged.out.trim(), "A\tpreexisting.txt");
});

test("commitChatExportSnapshot leaves unrelated pre-staged files staged", async () => {
  const repoRoot = await createRepo();

  fs.writeFileSync(path.join(repoRoot, "preexisting.txt"), "preexisting\n", "utf8");
  await gitCmd(["add", "preexisting.txt"], repoRoot);
  const chatExportDir = path.join(repoRoot, ".chat-log", "workspace", "chatSessions");
  fs.mkdirSync(chatExportDir, { recursive: true });
  fs.writeFileSync(path.join(chatExportDir, "chat.json"), "{}\n", "utf8");

  const result = await commitChatExportSnapshot(
    repoRoot,
    chatExportDir,
    false,
    true
  );

  assert.equal(result.ok, true);

  const headFiles = await gitCmd(["show", "--name-only", "--format=", "HEAD"], repoRoot);
  assert.deepEqual(
    headFiles.out.trim().split(/\r?\n/).filter(Boolean),
    [".chat-log/workspace/chatSessions/chat.json"]
  );

  const staged = await gitCmd(["diff", "--cached", "--name-status"], repoRoot);
  assert.equal(staged.out.trim(), "A\tpreexisting.txt");
});
