import assert from "node:assert/strict";
import test from "node:test";
import {
  pushRecordingBranch,
  readRecordingHistory,
  resolvePushRemote,
} from "../src/history-panel/history";
import { formatWindowCommitMessage } from "../src/recording/staging-tracker";
import { commitEmpty, git, makeBareRemote, makeRepo, makeTempDir } from "./git-fixtures";

const BRANCH = "flight-recorder/main";

test("readRecordingHistory parses every recording commit kind, newest first", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", BRANCH);
  commitEmpty(repo, "legacy commit without metadata");
  commitEmpty(
    repo,
    formatWindowCommitMessage(
      {
        kind: "human",
        files: [`${repo}/src/a.ts`, `${repo}/src/b.ts`],
        startedAt: 1_000,
        endedAt: 2_000,
      },
      repo
    )
  );
  commitEmpty(
    repo,
    formatWindowCommitMessage(
      {
        kind: "assistant",
        files: [`${repo}/src/c.ts`],
        startedAt: 3_000,
        endedAt: 4_000,
        events: [],
        origins: ["assistant-tool-edit"],
        fileAttributions: [],
      },
      repo
    )
  );
  commitEmpty(repo, "recording stopped: 2026-10-30 | log file: .log/copilot.log");
  commitEmpty(repo, "chat export: .chat-log/abc");
  git(repo, "checkout", "-q", "main");

  const history = await readRecordingHistory(repo, BRANCH);

  assert.ok(history);
  assert.deepEqual(
    history.entries.map((entry) => entry.kind),
    ["chat", "log", "assistant", "human", "unknown", "unknown"]
  );
  const [, , assistant, human, legacy] = history.entries;
  assert.equal(assistant.subject, "Flight Recorder: assistant tool edit (1 file)");
  assert.deepEqual(assistant.files, ["src/c.ts"]);
  assert.deepEqual(assistant.origins, ["assistant-tool-edit"]);
  assert.equal(human.subject, "Flight Recorder: human edits (2 files)");
  assert.deepEqual(human.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(legacy.subject, "legacy commit without metadata");
  assert.deepEqual(legacy.files, []);
  assert.equal(history.upstream, null);
});

test("readRecordingHistory hides the source branch history the recording started from", async () => {
  const repo = makeRepo();
  commitEmpty(repo, "older project commit");
  git(repo, "checkout", "-q", "-b", BRANCH);
  commitEmpty(repo, "Flight Recorder: human edits (0 files)");
  git(repo, "checkout", "-q", "main");
  commitEmpty(repo, "newer project commit");

  const history = await readRecordingHistory(repo, BRANCH, "main");

  assert.deepEqual(
    history?.entries.map((entry) => entry.subject),
    ["Flight Recorder: human edits (0 files)"]
  );
  const unfiltered = await readRecordingHistory(repo, BRANCH, "missing-branch");
  assert.equal(unfiltered?.entries.length, 3);
});

test("readRecordingHistory returns null for a missing branch", async () => {
  const repo = makeRepo();
  assert.equal(await readRecordingHistory(repo, BRANCH), null);
});

test("resolvePushRemote asks for a choice only when the remote is ambiguous", async () => {
  const repo = makeRepo();
  git(repo, "branch", BRANCH);
  assert.deepEqual(await resolvePushRemote(repo, BRANCH), { choices: [] });

  git(repo, "remote", "add", "backup", makeBareRemote());
  assert.deepEqual(await resolvePushRemote(repo, BRANCH), { remote: "backup" });

  git(repo, "remote", "add", "origin", makeBareRemote());
  assert.deepEqual(await resolvePushRemote(repo, BRANCH), {
    choices: ["origin", "backup"],
  });

  git(repo, "config", `branch.${BRANCH}.remote`, "backup");
  assert.deepEqual(await resolvePushRemote(repo, BRANCH), { remote: "backup" });
});

test("pushRecordingBranch pushes only the recording branch and sets its upstream", async () => {
  const repo = makeRepo();
  const remote = makeBareRemote();
  git(repo, "remote", "add", "origin", remote);
  git(repo, "branch", BRANCH);

  const res = await pushRecordingBranch(repo, BRANCH, "origin");

  assert.equal(res.ok, true, res.msg);
  assert.equal(
    git(remote, "for-each-ref", "--format=%(refname)"),
    `refs/heads/${BRANCH}`
  );
  let history = await readRecordingHistory(repo, BRANCH);
  assert.equal(history?.upstream, `origin/${BRANCH}`);
  assert.deepEqual([history?.ahead, history?.behind], [0, 0]);

  git(repo, "checkout", "-q", BRANCH);
  commitEmpty(repo, "Flight Recorder: human edits (0 files)");
  git(repo, "checkout", "-q", "main");
  history = await readRecordingHistory(repo, BRANCH);
  assert.deepEqual([history?.ahead, history?.behind], [1, 0]);
});

test("pushRecordingBranch reports a missing branch without pushing", async () => {
  const repo = makeRepo();
  const remote = makeBareRemote();
  git(repo, "remote", "add", "origin", remote);

  const res = await pushRecordingBranch(repo, BRANCH, "origin");

  assert.equal(res.ok, false);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), "");
});

test("a recording branch behind its remote is reported as behind and never force-pushed", async () => {
  const repo = makeRepo();
  const remote = makeBareRemote();
  git(repo, "remote", "add", "origin", remote);
  git(repo, "branch", BRANCH);
  await pushRecordingBranch(repo, BRANCH, "origin");
  const other = makeTempDir("fr-test-clone-");
  git(other, "clone", "-q", "-b", BRANCH, remote, ".");
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.com");
  commitEmpty(other, "pushed from elsewhere");
  git(other, "push", "-q", "origin", BRANCH);
  git(repo, "fetch", "-q", "origin");

  const history = await readRecordingHistory(repo, BRANCH);

  assert.deepEqual([history?.ahead, history?.behind], [0, 1]);
  const remoteHead = git(remote, "rev-parse", BRANCH);
  const push = await pushRecordingBranch(repo, BRANCH, "origin");
  assert.equal(push.ok, false);
  assert.match(push.msg, /newer commits|behind|pull|fetch/i);
  assert.equal(git(remote, "rev-parse", BRANCH), remoteHead);
});

test("readRecordingHistory treats a deleted upstream as no upstream", async () => {
  const repo = makeRepo();
  const remote = makeBareRemote();
  git(repo, "remote", "add", "origin", remote);
  git(repo, "branch", BRANCH);
  await pushRecordingBranch(repo, BRANCH, "origin");
  git(remote, "branch", "-D", BRANCH);
  git(repo, "fetch", "-q", "--prune", "origin");

  const history = await readRecordingHistory(repo, BRANCH);

  assert.equal(history?.upstream, null);
  assert.deepEqual([history?.ahead, history?.behind], [null, null]);
  assert.deepEqual(await resolvePushRemote(repo, BRANCH), { remote: "origin" });
  const push = await pushRecordingBranch(repo, BRANCH, "origin");
  assert.equal(push.ok, true, push.msg);
});
