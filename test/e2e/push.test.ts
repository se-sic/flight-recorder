import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { makeBareRemote } from "../git-fixtures";
import {
  configureClaudeHooks,
  getApi,
  git,
  humanEdit,
  repoRoot,
  resetRepo,
  setSetting,
  startRecording,
  stopRecording,
  stubDialogs,
  within,
} from "./helpers";

const BRANCH = "flight-recorder/main";

/** Runs the Push command with scripted dialog answers. */
async function push(answers: Record<string, string | undefined> = {}) {
  const dialogs = stubDialogs(answers);
  try {
    await within(vscode.commands.executeCommand("flightRecorder.pushTrackingBranch"), 20_000, "Push");
  } finally {
    dialogs.restore();
  }
  return dialogs.calls;
}

suite("E5 persisted state and push", () => {
  suiteSetup(async () => {
    await getApi();
    await setSetting("commitMode", "trackingWorktree");
  });

  setup(async () => {
    await resetRepo();
    await configureClaudeHooks();
  });

  test("push is refused while recording", async () => {
    git(repoRoot(), "remote", "add", "origin", makeBareRemote());
    await startRecording();
    const calls = await push();
    await stopRecording();

    assert.ok(calls.some((call) => /available after recording stops/.test(call.message)));
    assert.equal(git(repoRoot(), "ls-remote", "--heads", "origin"), "");
  });

  test("finalized branch state is persisted and pushed to the only remote without asking", async () => {
    const api = await getApi();
    const remote = makeBareRemote();
    git(repoRoot(), "remote", "add", "origin", remote);
    await startRecording();
    await humanEdit("readme.md", "\npush me\n");
    await stopRecording();

    const persisted = api.getPersistedRecordingBranchState();
    assert.equal(persisted?.finalized, true);
    assert.equal(persisted?.isRecording, false);
    assert.equal(persisted?.finalBranchName, BRANCH);

    const calls = await push();

    assert.equal(calls.some((call) => call.kind === "showQuickPick"), false);
    assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), `refs/heads/${BRANCH}`);
    assert.equal(git(remote, "rev-parse", BRANCH), git(repoRoot(), "rev-parse", BRANCH));
    assert.equal(git(repoRoot(), "rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`), `origin/${BRANCH}`);
  });

  test("with several remotes and no upstream, push asks with origin listed first", async () => {
    const backup = makeBareRemote();
    const origin = makeBareRemote();
    git(repoRoot(), "remote", "add", "backup", backup);
    git(repoRoot(), "remote", "add", "origin", origin);
    await startRecording();
    await humanEdit("readme.md", "\ntwo remotes\n");
    await stopRecording();

    const cancelled = await push();
    const picker = cancelled.find((call) => call.kind === "showQuickPick");
    assert.deepEqual(picker?.items, ["origin", "backup"]);
    assert.equal(git(backup, "for-each-ref"), "");
    assert.equal(git(origin, "for-each-ref"), "");

    await push({ "which remote": "backup" });
    assert.equal(git(backup, "for-each-ref", "--format=%(refname)"), `refs/heads/${BRANCH}`);
    assert.equal(git(origin, "for-each-ref"), "");
  });
});
