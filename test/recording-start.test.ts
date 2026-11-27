import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  finalizeRecordingCommitTarget,
  listPendingTrackingSessions,
  prepareRecordingCommitTarget,
  validateGitRecordingReadiness,
} from "../src/recording/commits";
import { commitEmpty, git, makeRepo, makeTempDir } from "./git-fixtures";

/** Prepares a tracking-worktree target with `prefix` and returns the result. */
function prepare(repo: string, prefix = "flight-recorder") {
  return prepareRecordingCommitTarget(repo, false, {
    mode: "trackingWorktree",
    trackingBranchPrefix: prefix,
  });
}

/** Runs `fn` with the given environment variables set, restoring them afterwards. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// --- U4: start readiness ---

test("readiness accepts a normal repository", async () => {
  assert.deepEqual(await validateGitRecordingReadiness(makeRepo(), false), { ok: true });
});

test("readiness rejects a folder that is not a git repository", async () => {
  const dir = makeTempDir("fr-test-plain-");
  await withEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir) }, async () => {
    const res = await validateGitRecordingReadiness(dir, false);
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.kind, "not_a_repo");
  });
});

test("readiness rejects a missing commit identity, except in dry runs", async () => {
  const repo = makeRepo();
  git(repo, "config", "--unset", "user.name");
  git(repo, "config", "--unset", "user.email");
  git(repo, "config", "user.useConfigOnly", "true");
  const emptyConfig = path.join(makeTempDir("fr-test-home-"), "gitconfig");
  fs.writeFileSync(emptyConfig, "");

  await withEnv(
    {
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
      EMAIL: "",
    },
    async () => {
      const res = await validateGitRecordingReadiness(repo, false);
      assert.equal(res.ok, false);
      assert.equal(!res.ok && res.kind, "identity_not_configured");
      assert.deepEqual(await validateGitRecordingReadiness(repo, true), { ok: true });
    }
  );
});

test("a repository without commits fails start with a clear message instead of a broken worktree", async () => {
  const repo = makeTempDir("fr-test-unborn-");
  git(repo, "init", "-q", "-b", "main");

  const readiness = await validateGitRecordingReadiness(repo, true);
  const res = readiness.ok ? await prepare(repo) : readiness;

  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.msg : "", /no commits|commit first|empty repository/i);
  assert.equal(
    fs.existsSync(path.join(repo, ".git", "flight-recorder-worktrees")) &&
      fs.readdirSync(path.join(repo, ".git", "flight-recorder-worktrees")).length > 0,
    false
  );
});

// --- U5: branch naming ---

test("source branches with slashes and odd characters map to one safe final branch", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature/Login+page#2");

  const res = await prepare(repo);

  assert.equal(res.ok, true, res.ok ? "" : res.msg);
  if (!res.ok || res.target.mode !== "trackingWorktree") {
    return;
  }
  assert.equal(res.target.finalBranchName, "flight-recorder/feature-Login-page-2");
  assert.match(
    res.target.activeBranchName,
    /^flight-recorder-active\/feature-Login-page-2\/[A-Za-z0-9._-]+$/
  );
  assert.equal(git(repo, "check-ref-format", `refs/heads/${res.target.activeBranchName}`), "");
});

test("a detached HEAD records to a branch named after the commit", async () => {
  const repo = makeRepo();
  const short = git(repo, "rev-parse", "--short", "HEAD");
  git(repo, "checkout", "-q", "--detach");

  const res = await prepare(repo);

  assert.equal(res.ok, true, res.ok ? "" : res.msg);
  assert.equal(
    res.ok && res.target.mode === "trackingWorktree" && res.target.finalBranchName,
    `flight-recorder/detached-${short}`
  );
});

test("a custom prefix is sanitized and used for final, active and pending branches", async () => {
  const repo = makeRepo();

  const res = await prepare(repo, " study run/ fr ");

  assert.equal(res.ok, true, res.ok ? "" : res.msg);
  if (!res.ok || res.target.mode !== "trackingWorktree") {
    return;
  }
  assert.equal(res.target.finalBranchName, "study-run/fr/main");
  assert.match(res.target.activeBranchName, /^study-run\/fr-active\/main\//);
  const pending = await listPendingTrackingSessions(repo, "study-run/fr");
  assert.deepEqual(pending.map((session) => session.finalBranchName), ["study-run/fr/main"]);
});

test("a source branch named 'active' can be recorded and finalized", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "active");
  commitEmpty(repo, "work on active");

  const res = await prepare(repo);
  assert.equal(res.ok, true, res.ok ? "" : res.msg);
  if (!res.ok) {
    return;
  }
  const finalized = await finalizeRecordingCommitTarget(res.target, false);

  assert.equal(finalized.ok, true, finalized.msg);
  assert.deepEqual(await listPendingTrackingSessions(repo, "flight-recorder"), []);
});
