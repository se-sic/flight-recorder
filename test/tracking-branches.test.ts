import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  commitTrackedWindow,
  finalizePendingTrackingSession,
  finalizeRecordingCommitTarget,
  listPendingTrackingSessions,
  prepareRecordingCommitTarget,
  RecordingCommitTarget,
} from "../src/recording/commits";
import { commitEmpty, git, listBranches, makeRepo } from "./git-fixtures";

type TrackingTarget = Extract<RecordingCommitTarget, { mode: "trackingWorktree" }>;

const PREFIX = "flight-recorder";

async function startSession(repo: string): Promise<TrackingTarget> {
  const res = await prepareRecordingCommitTarget(repo, false, {
    mode: "trackingWorktree",
    trackingBranchPrefix: PREFIX,
  });
  assert.equal(res.ok, true, res.ok ? "" : res.msg);
  if (!res.ok || res.target.mode !== "trackingWorktree") {
    throw new Error("expected a tracking worktree target");
  }
  return res.target;
}

/** Writes a file in the visible checkout and records it through the real commit pipeline. */
async function recordHumanEdit(
  repo: string,
  target: TrackingTarget,
  fileName: string
): Promise<void> {
  const filePath = path.join(repo, fileName);
  fs.writeFileSync(filePath, `${fileName}\n`);
  const res = await commitTrackedWindow(
    repo,
    { kind: "human", files: [filePath], startedAt: 1_000, endedAt: 2_000 },
    false,
    false,
    false,
    target
  );
  assert.equal(res.ok, true, res.msg);
}

async function finalize(target: TrackingTarget) {
  return finalizeRecordingCommitTarget(target, false);
}

test("tracking worktree commits leave the visible branch and index untouched", async () => {
  const repo = makeRepo();
  const mainHead = git(repo, "rev-parse", "HEAD");
  const target = await startSession(repo);

  assert.match(target.activeBranchName, /^flight-recorder\/active\/main\/.+/);
  assert.equal(target.finalBranchName, "flight-recorder/main");
  assert.ok(fs.existsSync(target.commitRoot));

  await recordHumanEdit(repo, target, "notes.txt");

  assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "status", "--porcelain"), "?? notes.txt");
  assert.match(
    git(repo, "log", "-1", "--format=%B", target.activeBranchName),
    /^Flight Recorder: human edits \(1 file\)/
  );
  assert.equal(
    git(repo, "show", `${target.activeBranchName}:notes.txt`),
    "notes.txt"
  );
});

test("finalization creates the final branch and releases the worktree and active branch", async () => {
  const repo = makeRepo();
  const target = await startSession(repo);
  await recordHumanEdit(repo, target, "a.txt");
  const activeHead = git(repo, "rev-parse", target.activeBranchName);

  const res = await finalize(target);

  assert.equal(res.ok, true, res.msg);
  assert.equal(res.skipped, false);
  assert.equal(git(repo, "rev-parse", "flight-recorder/main"), activeHead);
  assert.equal(fs.existsSync(target.commitRoot), false);
  assert.deepEqual(listBranches(repo), ["flight-recorder/main", "main"]);
  assert.deepEqual(await listPendingTrackingSessions(repo, PREFIX), []);
});

test("a second session starts from and fast-forwards the final branch", async () => {
  const repo = makeRepo();
  const first = await startSession(repo);
  await recordHumanEdit(repo, first, "first.txt");
  await finalize(first);
  const firstHead = git(repo, "rev-parse", "flight-recorder/main");

  const second = await startSession(repo);
  assert.equal(git(repo, "rev-parse", second.activeBranchName), firstHead);
  await recordHumanEdit(repo, second, "second.txt");
  const res = await finalize(second);

  assert.equal(res.ok, true, res.msg);
  assert.equal(
    git(repo, "rev-list", "--count", `${firstHead}..flight-recorder/main`),
    "1"
  );
});

test("a diverged final branch is never force-updated and the recording is kept", async () => {
  const repo = makeRepo();
  const first = await startSession(repo);
  await recordHumanEdit(repo, first, "first.txt");
  await finalize(first);

  const second = await startSession(repo);
  await recordHumanEdit(repo, second, "second.txt");
  const divergedHead = commitEmpty(repo, "unrelated");
  git(repo, "branch", "-f", "flight-recorder/main", divergedHead);

  const res = await finalize(second);

  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.diverged, true);
  assert.equal(git(repo, "rev-parse", "flight-recorder/main"), divergedHead);
  assert.ok(fs.existsSync(second.commitRoot));

  const pending = await listPendingTrackingSessions(repo, PREFIX);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].activeBranchName, second.activeBranchName);
  assert.equal(pending[0].finalBranchName, "flight-recorder/main");
  assert.equal(pending[0].sessionId, second.sessionId);
  assert.equal(
    fs.realpathSync(pending[0].worktreePath ?? ""),
    fs.realpathSync(second.commitRoot)
  );
});

test("recovery can save a diverged recording as a separate branch", async () => {
  const repo = makeRepo();
  const first = await startSession(repo);
  await finalize(first);
  const second = await startSession(repo);
  await recordHumanEdit(repo, second, "second.txt");
  const activeHead = git(repo, "rev-parse", second.activeBranchName);
  git(repo, "branch", "-f", "flight-recorder/main", commitEmpty(repo, "unrelated"));

  const [pending] = await listPendingTrackingSessions(repo, PREFIX);
  const preserved = await finalizePendingTrackingSession(pending, "preserve");
  assert.equal(!preserved.ok && preserved.diverged, true);

  const res = await finalizePendingTrackingSession(pending, "separateBranch");

  const separateBranch = `flight-recorder/main-${second.sessionId}`;
  assert.equal(res.ok, true, res.msg);
  assert.equal(res.ok && !res.skipped && res.finalBranchName, separateBranch);
  assert.equal(git(repo, "rev-parse", separateBranch), activeHead);
  assert.equal(fs.existsSync(second.commitRoot), false);
  assert.deepEqual(await listPendingTrackingSessions(repo, PREFIX), []);
});

test("finalization explains when the final branch is checked out elsewhere", async () => {
  const repo = makeRepo();
  const first = await startSession(repo);
  await finalize(first);
  const second = await startSession(repo);
  await recordHumanEdit(repo, second, "second.txt");
  const activeHead = git(repo, "rev-parse", second.activeBranchName);
  git(repo, "checkout", "-q", "flight-recorder/main");

  const res = await finalize(second);

  assert.equal(res.ok, false);
  assert.match(res.msg, /flight-recorder\/main is checked out at/);
  assert.match(res.msg, /Recover Unfinished Recordings/);

  git(repo, "checkout", "-q", "main");
  const [pending] = await listPendingTrackingSessions(repo, PREFIX);
  const recovered = await finalizePendingTrackingSession(pending, "preserve");
  assert.equal(recovered.ok, true, recovered.msg);
  assert.equal(git(repo, "rev-parse", "flight-recorder/main"), activeHead);
});

test("cleanup failures after publishing are warnings, and recovery finishes the cleanup", async () => {
  const repo = makeRepo();
  const target = await startSession(repo);
  await recordHumanEdit(repo, target, "a.txt");
  const activeHead = git(repo, "rev-parse", target.activeBranchName);
  git(repo, "worktree", "lock", target.commitRoot);

  const res = await finalize(target);

  assert.equal(res.ok, true, res.msg);
  assert.equal(res.ok && !res.skipped && typeof res.warning, "string");
  assert.equal(git(repo, "rev-parse", "flight-recorder/main"), activeHead);

  git(repo, "worktree", "unlock", target.commitRoot);
  const [pending] = await listPendingTrackingSessions(repo, PREFIX);
  assert.equal(pending.activeBranchName, target.activeBranchName);
  const recovered = await finalizePendingTrackingSession(pending, "preserve");

  assert.equal(recovered.ok, true, recovered.msg);
  assert.equal(recovered.ok && !recovered.skipped && recovered.warning, undefined);
  assert.equal(fs.existsSync(target.commitRoot), false);
  assert.deepEqual(listBranches(repo), ["flight-recorder/main", "main"]);
});

test("a hidden worktree with uncommitted changes is preserved", async () => {
  const repo = makeRepo();
  const target = await startSession(repo);
  fs.writeFileSync(path.join(target.commitRoot, "stray.txt"), "stray\n");

  const res = await finalize(target);

  assert.equal(res.ok, false);
  assert.match(res.msg, /uncommitted changes/);
  assert.ok(fs.existsSync(target.commitRoot));
  assert.equal(listBranches(repo).includes("flight-recorder/main"), false);
});

test("a clean worktree from the previous tracking model is released on start", async () => {
  const repo = makeRepo();
  const legacyPath = path.join(
    git(repo, "rev-parse", "--absolute-git-dir"),
    "flight-recorder-worktrees",
    "flight-recorder__main"
  );
  git(repo, "worktree", "add", "-q", "-b", "flight-recorder/main", legacyPath, "HEAD");

  const target = await startSession(repo);
  await recordHumanEdit(repo, target, "a.txt");
  const res = await finalize(target);

  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(res.ok, true, res.msg);
});

test("a dirty worktree from the previous tracking model blocks start with guidance", async () => {
  const repo = makeRepo();
  const legacyPath = path.join(
    git(repo, "rev-parse", "--absolute-git-dir"),
    "flight-recorder-worktrees",
    "flight-recorder__main"
  );
  git(repo, "worktree", "add", "-q", "-b", "flight-recorder/main", legacyPath, "HEAD");
  fs.writeFileSync(path.join(legacyPath, "stray.txt"), "stray\n");

  const res = await prepareRecordingCommitTarget(repo, false, {
    mode: "trackingWorktree",
    trackingBranchPrefix: PREFIX,
  });

  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.msg : "", /older Flight Recorder worktree/);
  assert.ok(fs.existsSync(legacyPath));
});

test("dry runs and current-branch mode do not touch git", async () => {
  const repo = makeRepo();
  const branchesBefore = listBranches(repo);

  const dry = await prepareRecordingCommitTarget(repo, true, {
    mode: "trackingWorktree",
    trackingBranchPrefix: PREFIX,
  });
  assert.equal(dry.ok, true);
  if (!dry.ok) {
    return;
  }
  assert.equal(fs.existsSync(dry.target.commitRoot), false);
  const dryFinalize = await finalizeRecordingCommitTarget(dry.target, true);
  assert.equal(dryFinalize.ok && dryFinalize.skipped, true);

  const current = await prepareRecordingCommitTarget(repo, false, {
    mode: "currentBranch",
    trackingBranchPrefix: PREFIX,
  });
  assert.equal(current.ok, true);
  if (!current.ok) {
    return;
  }
  const currentFinalize = await finalizeRecordingCommitTarget(current.target, false);
  assert.equal(currentFinalize.ok && currentFinalize.skipped, true);

  assert.deepEqual(listBranches(repo), branchesBefore);
});

test("listPendingTrackingSessions ignores unrelated and malformed branches", async () => {
  const repo = makeRepo();
  git(repo, "branch", "flight-recorder/main");
  git(repo, "branch", "flight-recorder/active/missing-session");
  git(repo, "branch", "other/active/main/123");
  git(repo, "branch", "flight-recorder/active/feature-x/2026-01-01T00-00-00-000Z-abc123");

  const pending = await listPendingTrackingSessions(repo, PREFIX);

  assert.deepEqual(
    pending.map((session) => ({
      final: session.finalBranchName,
      sessionId: session.sessionId,
      worktreePath: session.worktreePath,
    })),
    [
      {
        final: "flight-recorder/feature-x",
        sessionId: "2026-01-01T00-00-00-000Z-abc123",
        worktreePath: null,
      },
    ]
  );
});
