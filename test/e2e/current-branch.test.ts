import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  claudeEdit,
  configureClaudeHooks,
  getApi,
  git,
  humanEdit,
  listBranches,
  recordedCommits,
  repoRoot,
  resetRepo,
  setSetting,
  sleep,
  startRecording,
  stopRecording,
  stubDialogs,
  waitFor,
} from "./helpers";

suite("E6 current-branch mode", () => {
  let dialogs: ReturnType<typeof stubDialogs>;

  suiteSetup(async () => {
    await getApi();
    await setSetting("debounceMs", 500);
    await setSetting("commitMode", "currentBranch");
  });

  suiteTeardown(async () => {
    await setSetting("commitMode", "trackingWorktree");
  });

  setup(async () => {
    await resetRepo();
    await configureClaudeHooks();
    dialogs = stubDialogs({});
  });

  teardown(() => dialogs.restore());

  test("recorder commits go onto the checked-out branch and leave pre-staged changes staged", async () => {
    const root = repoRoot();
    fs.writeFileSync(path.join(root, "staged.txt"), "staged by the user\n");
    git(root, "add", "staged.txt");

    await startRecording();
    await humanEdit("readme.md", "\nHuman line\n");
    await sleep(1_200);
    await claudeEdit("index.js", "// assistant comment\nmodule.exports = 1;\n");
    await waitFor(
      () => recordedCommits("main").some((subject) => subject.startsWith("Flight Recorder: assistant")),
      "the assistant commit on main"
    );
    await stopRecording();

    assert.deepEqual(listBranches(root), ["main"]);
    const commits = recordedCommits("main");
    assert.match(commits[0], /^recording stopped: /);
    assert.deepEqual(commits.slice(1), [
      "Flight Recorder: assistant tool edit (1 file)",
      "Flight Recorder: human edits (1 file)",
    ]);
    const committedFiles = git(root, "log", "--name-only", "--format=", "e2e-base..main").split("\n");
    assert.equal(committedFiles.includes("staged.txt"), false);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "staged.txt");
    const api = await getApi();
    assert.equal(api.getRecordingBranchState()?.commitMode, "currentBranch");
  });
});
