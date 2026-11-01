import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  configureClaudeHooks,
  getApi,
  git,
  listBranches,
  repoRoot,
  resetRepo,
  setSetting,
  startRecording,
  stopRecording,
  stubDialogs,
} from "./helpers";

const LEFTOVER = "flight-recorder-active/main/2026-01-01T00-00-00-000Z-leftov";

/** Creates an unfinished recording like one left behind by a closed window. */
function createLeftoverRecording(): string {
  const root = repoRoot();
  const worktree = path.join(
    git(root, "rev-parse", "--absolute-git-dir"),
    "flight-recorder-worktrees",
    LEFTOVER.replace(/\//g, "__")
  );
  git(root, "worktree", "add", "-q", "-b", LEFTOVER, worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "readme.md"), "# leftover work\n");
  git(worktree, "commit", "-q", "-am", "Flight Recorder: human edits (1 file)");
  return git(root, "rev-parse", LEFTOVER);
}

suite("E4 unfinished recordings at start", () => {
  suiteSetup(async () => {
    await getApi();
    await setSetting("commitMode", "trackingWorktree");
  });

  setup(async () => {
    await resetRepo();
    await configureClaudeHooks();
    createLeftoverRecording();
  });

  test("the start prompt is modal, and cancelling it starts nothing", async () => {
    const api = await getApi();
    const dialogs = stubDialogs({});
    try {
      await startRecording();
    } finally {
      dialogs.restore();
    }

    const prompt = dialogs.calls.find((call) => /not finalized/.test(call.message));
    assert.ok(prompt, "the unfinished-recording prompt is shown");
    assert.equal(prompt.modal, true);
    assert.deepEqual(prompt.items, ["Recover Now", "Start Anyway"]);
    assert.equal(api.isRecording(), false);
    assert.deepEqual(listBranches(repoRoot()), [LEFTOVER, "main"]);
  });

  test("Start Anyway starts a new session and keeps the leftover listed as unfinished", async () => {
    const api = await getApi();
    const dialogs = stubDialogs({ "not finalized": "Start Anyway" });
    try {
      await startRecording();
      assert.equal(api.isRecording(), true);
      const unfinished = await api.listUnfinishedRecordings();
      assert.deepEqual(unfinished.map((session) => session.activeBranchName), [LEFTOVER]);
      await stopRecording();
    } finally {
      dialogs.restore();
    }
    assert.ok(listBranches(repoRoot()).includes(LEFTOVER));
  });

  test("Recover Now finalizes the leftover before starting", async () => {
    const api = await getApi();
    const leftoverHead = git(repoRoot(), "rev-parse", LEFTOVER);
    const dialogs = stubDialogs({ "not finalized": "Recover Now" });
    try {
      await startRecording();
      assert.equal(api.isRecording(), true);
      assert.equal(git(repoRoot(), "merge-base", "--is-ancestor", leftoverHead, "flight-recorder/main"), "");
      assert.deepEqual(await api.listUnfinishedRecordings(), []);
      await stopRecording();
    } finally {
      dialogs.restore();
    }
    assert.equal(listBranches(repoRoot()).includes(LEFTOVER), false);
  });

  test("the Recover command saves a diverged recording as a separate branch when confirmed", async () => {
    const root = repoRoot();
    git(root, "branch", "flight-recorder/main", "main");
    git(root, "checkout", "-q", "flight-recorder/main");
    git(root, "commit", "-q", "--allow-empty", "-m", "diverging commit");
    git(root, "checkout", "-q", "main");
    const divergedHead = git(root, "rev-parse", "flight-recorder/main");
    const leftoverHead = git(root, "rev-parse", LEFTOVER);

    const dialogs = stubDialogs({ "diverged|cannot be fast-forwarded|Separate Branch": "Save as Separate Branch" });
    try {
      await vscode.commands.executeCommand("flightRecorder.recoverRecordings");
    } finally {
      dialogs.restore();
    }

    const separate = "flight-recorder/main-2026-01-01T00-00-00-000Z-leftov";
    assert.equal(git(root, "rev-parse", "flight-recorder/main"), divergedHead);
    assert.equal(git(root, "rev-parse", separate), leftoverHead);
    assert.equal(listBranches(root).includes(LEFTOVER), false);
    assert.ok(dialogs.calls.some((call) => call.modal && call.items.includes("Save as Separate Branch")));
  });
});
