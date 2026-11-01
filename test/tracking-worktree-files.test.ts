import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  commitAssistantLogSnapshot,
  commitChatExportSnapshot,
  commitTrackedWindow,
  finalizeRecordingCommitTarget,
  prepareRecordingCommitTarget,
  RecordingCommitTarget,
} from "../src/recording/commits";
import { WindowCommit } from "../src/recording/staging-tracker";
import { git, makeRepo, makeTempDir } from "./git-fixtures";

type TrackingTarget = Extract<RecordingCommitTarget, { mode: "trackingWorktree" }>;

/** Starts a tracking-worktree session in `repo`. */
async function startSession(repo: string): Promise<TrackingTarget> {
  const res = await prepareRecordingCommitTarget(repo, false, {
    mode: "trackingWorktree",
    trackingBranchPrefix: "flight-recorder",
  });
  if (!res.ok || res.target.mode !== "trackingWorktree") {
    throw new Error(`expected a tracking worktree target: ${res.ok ? "" : res.msg}`);
  }
  return res.target;
}

/** Commits a window of `files` (relative to `repo`) into the tracking worktree. */
async function commitWindow(
  repo: string,
  target: RecordingCommitTarget,
  kind: "human" | "assistant",
  files: string[],
  snapshots?: Record<string, string>
) {
  const abs = files.map((file) => path.join(repo, file));
  const commit: WindowCommit = kind === "human"
    ? {
      kind,
      files: abs,
      startedAt: 1_000,
      endedAt: 2_000,
      ...(snapshots ? { snapshots } : {}),
    }
    : {
      kind,
      files: abs,
      startedAt: 1_000,
      endedAt: 2_000,
      events: [],
      origins: ["assistant-tool-edit"],
      fileAttributions: [],
    };
  return commitTrackedWindow(repo, commit, false, false, false, target);
}

/** Lists the paths changed by the newest commit on `branch`. */
function lastCommitFiles(repo: string, branch: string): string[] {
  return git(repo, "show", "--name-status", "--format=", branch)
    .split("\n")
    .filter(Boolean)
    .sort();
}

/** Writes `content` to `rel` under `root`, creating parent directories. */
function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

// --- U1: snapshots of ignored and deleted files ---

test("a snapshotted gitignored file neither breaks nor joins the human commit (worktree mode)", async () => {
  const repo = makeRepo();
  write(repo, ".gitignore", "secret.txt\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore secret");
  const target = await startSession(repo);
  write(repo, "secret.txt", "token\n");
  write(repo, "README.md", "human\nassistant\n");

  const res = await commitWindow(repo, target, "human", ["secret.txt", "README.md"], {
    [path.join(repo, "secret.txt")]: "token\n",
    [path.join(repo, "README.md")]: "human\n",
  });

  assert.equal(res.ok, true, res.msg);
  assert.deepEqual(lastCommitFiles(repo, target.activeBranchName), ["M\tREADME.md"]);
  assert.equal(git(repo, "show", `${target.activeBranchName}:README.md`), "human");
});

test("a snapshotted gitignored file neither breaks nor joins the human commit (current-branch mode)", async () => {
  const repo = makeRepo();
  write(repo, ".gitignore", "secret.txt\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore secret");
  write(repo, "secret.txt", "token\n");
  write(repo, "README.md", "human\nassistant\n");

  const res = await commitWindow(
    repo,
    { mode: "currentBranch", sourceRoot: repo, commitRoot: repo },
    "human",
    ["secret.txt", "README.md"],
    {
      [path.join(repo, "secret.txt")]: "token\n",
      [path.join(repo, "README.md")]: "human\n",
    }
  );

  assert.equal(res.ok, true, res.msg);
  assert.deepEqual(lastCommitFiles(repo, "main"), ["M\tREADME.md"]);
});

for (const mode of ["trackingWorktree", "currentBranch"] as const) {
  test(`an edited gitignored file without a snapshot does not break the commit (${mode})`, async () => {
    const repo = makeRepo();
    write(repo, ".gitignore", ".env\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore env");
    const target: RecordingCommitTarget = mode === "trackingWorktree"
      ? await startSession(repo)
      : { mode, sourceRoot: repo, commitRoot: repo };
    write(repo, ".env", "TOKEN=secret\n");
    write(repo, "README.md", "edited\n");

    const res = await commitWindow(repo, target, "human", [".env", "README.md"]);

    const branch = target.mode === "trackingWorktree" ? target.activeBranchName : "main";
    assert.equal(res.ok, true, res.msg);
    assert.deepEqual(lastCommitFiles(repo, branch), ["M\tREADME.md"]);
  });
}

test("a human snapshot is kept when the assistant deletes the file afterwards", async () => {
  const repo = makeRepo();
  const target = await startSession(repo);
  write(repo, "notes.txt", "human draft\n");
  fs.rmSync(path.join(repo, "notes.txt"));

  const human = await commitWindow(repo, target, "human", ["notes.txt"], {
    [path.join(repo, "notes.txt")]: "human draft\n",
  });
  const assistant = await commitWindow(repo, target, "assistant", ["notes.txt"]);

  assert.equal(human.ok, true, human.msg);
  assert.equal(git(repo, "show", `${target.activeBranchName}~1:notes.txt`), "human draft");
  assert.equal(assistant.ok, true, assistant.msg);
  assert.deepEqual(lastCommitFiles(repo, target.activeBranchName), ["D\tnotes.txt"]);
});

test("reverting a file to the source branch version is recorded on the recording branch", async () => {
  const repo = makeRepo();
  const first = await startSession(repo);
  write(repo, "README.md", "edited\n");
  await commitWindow(repo, first, "human", ["README.md"]);
  await finalizeRecordingCommitTarget(first, false);
  const second = await startSession(repo);
  write(repo, "README.md", "init\n");

  const res = await commitWindow(repo, second, "human", ["README.md"]);

  assert.equal(res.ok, true, res.msg);
  assert.equal(git(repo, "show", `${second.activeBranchName}:README.md`), "init");
});

// --- U2: file operations mirrored into the worktree ---

test("worktree commits mirror deletes, renames, new files in subdirectories and symlinks", async () => {
  const repo = makeRepo();
  write(repo, "old.txt", "old\n");
  write(repo, "gone.txt", "gone\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "fixtures");
  const target = await startSession(repo);

  fs.rmSync(path.join(repo, "gone.txt"));
  fs.renameSync(path.join(repo, "old.txt"), path.join(repo, "new.txt"));
  write(repo, "src/deep/file.ts", "export {};\n");
  fs.symlinkSync("new.txt", path.join(repo, "link.txt"));

  const res = await commitWindow(repo, target, "human", [
    "gone.txt",
    "old.txt",
    "new.txt",
    "src/deep/file.ts",
    "link.txt",
  ]);

  assert.equal(res.ok, true, res.msg);
  const branch = target.activeBranchName;
  assert.deepEqual(
    git(repo, "ls-tree", "-r", "--name-only", branch).split("\n").sort(),
    ["README.md", "link.txt", "new.txt", "src/deep/file.ts"]
  );
  assert.equal(git(repo, "show", `${branch}:new.txt`), "old");
  assert.match(git(repo, "ls-tree", branch, "link.txt"), /^120000 /);
  assert.equal(git(repo, "show", `${branch}:link.txt`), "new.txt");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));
  assert.equal(git(repo, "branch", "--show-current"), "main");
});

test("unchanged files named in a window produce no commit", async () => {
  const repo = makeRepo();
  const target = await startSession(repo);
  const before = git(repo, "rev-parse", target.activeBranchName);

  const res = await commitWindow(repo, target, "human", ["README.md"]);

  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(git(repo, "rev-parse", target.activeBranchName), before);
});

// --- U3: log and chat snapshots in worktree mode ---

test("log snapshot commits land in the worktree, force-added past ignore rules", async () => {
  const repo = makeRepo();
  write(repo, ".gitignore", ".log/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore logs");
  const target = await startSession(repo);
  const sourceLog = path.join(makeTempDir("fr-test-log-"), "claude.jsonl");
  fs.writeFileSync(sourceLog, "{\"hook\":1}\n");

  const res = await commitAssistantLogSnapshot(repo, sourceLog, "claude", false, true, target);

  assert.equal(res.ok, true, res.msg);
  const [status] = lastCommitFiles(repo, target.activeBranchName);
  assert.match(status, /^A\t\.log\/claude-.+\.log$/);
  assert.match(git(repo, "log", "-1", "--format=%s", target.activeBranchName), /^recording stopped: /);
  assert.equal(fs.existsSync(path.join(repo, ".log")), false);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("log snapshot commits report ignored logs when force-adding is off", async () => {
  const repo = makeRepo();
  write(repo, ".gitignore", ".log/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore logs");
  const target = await startSession(repo);
  const before = git(repo, "rev-parse", target.activeBranchName);
  const sourceLog = path.join(makeTempDir("fr-test-log-"), "claude.jsonl");
  fs.writeFileSync(sourceLog, "{}\n");

  const res = await commitAssistantLogSnapshot(repo, sourceLog, "claude", false, false, target);

  assert.equal(res.ok, false);
  assert.equal(res.skipped, false);
  assert.equal(git(repo, "rev-parse", target.activeBranchName), before);
});

test("chat export commits land in the worktree and skip when nothing changed", async () => {
  const repo = makeRepo();
  write(repo, ".gitignore", ".chat-log/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore chats");
  const target = await startSession(repo);
  const chatDir = path.join(target.commitRoot, ".chat-log");
  write(chatDir, "copilot-chat/2026-11-04_1000_test.jsonl", "{}\n");

  const res = await commitChatExportSnapshot(repo, chatDir, false, true, target);
  const again = await commitChatExportSnapshot(repo, chatDir, false, true, target);

  assert.equal(res.ok, true, res.msg);
  assert.deepEqual(lastCommitFiles(repo, target.activeBranchName), [
    "A\t.chat-log/copilot-chat/2026-11-04_1000_test.jsonl",
  ]);
  assert.equal(again.ok, false);
  assert.equal(again.skipped, true);
  assert.equal(fs.existsSync(path.join(repo, ".chat-log")), false);
});

test("commit metadata lists only recorded files, not ignored or transient ones", async () => {
  const repo = makeRepo();
  write(repo, ".gitignore", ".env\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore env");
  const target = await startSession(repo);
  write(repo, ".env", "TOKEN=secret\n");
  write(repo, "README.md", "edited\n");

  const res = await commitWindow(repo, target, "assistant", [".env", "index.js.tmp", "README.md"]);

  assert.equal(res.ok, true, res.msg);
  const message = git(repo, "log", "-1", "--format=%B", target.activeBranchName);
  assert.match(message, /^Flight Recorder: assistant tool edit \(1 file\)/);
  assert.match(message, /"files":\["README.md"\]/);
  assert.doesNotMatch(message, /\.env|index\.js\.tmp/);
});
