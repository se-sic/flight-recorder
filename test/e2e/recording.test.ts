import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  claudeBash,
  claudeEdit,
  claudeRead,
  configureClaudeHooks,
  getApi,
  git,
  humanEdit,
  listBranches,
  recordedCommits,
  repoRoot,
  resetRepo,
  setSetting,
  showFile,
  sleep,
  startRecording,
  stopRecording,
  stubDialogs,
  waitFor,
} from "./helpers";

suite("E2/E3 Claude hook recording", () => {
  let dialogs: ReturnType<typeof stubDialogs>;

  suiteSetup(async () => {
    await getApi();
    await setSetting("debounceMs", 500);
    await setSetting("commitMode", "trackingWorktree");
  });

  setup(async () => {
    await resetRepo();
    dialogs = stubDialogs({});
  });

  teardown(() => dialogs.restore());

  test("Configure Claude Hooks installs local hook settings and excludes them from git", async () => {
    dialogs.restore();
    const calls = await configureClaudeHooks();
    dialogs = stubDialogs({});
    const root = repoRoot();

    assert.ok(calls.some((call) => call.kind === "showQuickPick"), "scope picker shown");
    assert.ok(fs.existsSync(path.join(root, ".claude", "settings.local.json")));
    const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /\.claude\/settings\.local\.json/);
    assert.match(exclude, /\.claude\/flight-recorder-hooks\.jsonl/);
    assert.equal(git(root, "status", "--porcelain"), "", "hook setup leaves git status clean");
  });

  test("E2: a full session lands on the final branch and leaves the checkout untouched", async () => {
    await configureClaudeHooks();
    const api = await getApi();
    const root = repoRoot();
    const mainHead = git(root, "rev-parse", "main");

    await startRecording();
    assert.equal(api.isRecording(), true, "recording is running right after Start returns");
    const active = api.getRecordingBranchState()?.activeBranchName ?? "";
    assert.match(active, /^flight-recorder-active\/main\//);
    assert.deepEqual(await api.listUnfinishedRecordings(), [], "the running session is not 'unfinished'");

    await humanEdit("readme.md", "\nHuman line\n");
    await sleep(1_200);
    await claudeEdit("index.js", "// assistant comment\nmodule.exports = 1;\n");
    await waitFor(
      () => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: assistant")),
      "the assistant commit on the active branch"
    );

    await stopRecording();

    assert.equal(api.isRecording(), false);
    const state = api.getRecordingBranchState();
    assert.equal(state?.finalized, true);
    assert.equal(state?.displayBranchName, "flight-recorder/main");
    assert.deepEqual(listBranches(root), ["flight-recorder/main", "main"]);
    assert.equal(git(root, "worktree", "list").split("\n").length, 1);

    const commits = recordedCommits("flight-recorder/main");
    assert.match(commits[0], /^recording stopped: /);
    assert.deepEqual(commits.slice(1), [
      "Flight Recorder: assistant tool edit (1 file)",
      "Flight Recorder: human edits (1 file)",
    ]);
    assert.equal(git(root, "show", "--name-only", "--format=", "flight-recorder/main~1"), "index.js");
    assert.equal(git(root, "show", "--name-only", "--format=", "flight-recorder/main~2"), "readme.md");

    assert.equal(git(root, "rev-parse", "main"), mainHead);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.deepEqual(git(root, "diff", "--name-only").split("\n").sort(), ["index.js", "readme.md"]);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "", "nothing staged in the user's index");
  });

  test("E3: a file edited by the human, then by the assistant, is split correctly", async () => {
    await configureClaudeHooks();
    const api = await getApi();
    await startRecording();
    const active = api.getRecordingBranchState()?.activeBranchName ?? "";

    const document = await humanEdit("index.js", "// human line\n");
    const humanText = document.getText();
    await sleep(1_200);
    const finalText = `${humanText}// assistant line\n`;
    await claudeEdit("index.js", finalText);
    await waitFor(() => document.getText() === finalText, "the editor to reload the assistant edit");
    await waitFor(
      () => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: assistant")),
      "the assistant commit"
    );
    await stopRecording();

    const commits = recordedCommits("flight-recorder/main");
    assert.deepEqual(commits.slice(1), [
      "Flight Recorder: assistant tool edit (1 file)",
      "Flight Recorder: human edits (1 file)",
    ]);
    assert.equal(showFile("flight-recorder/main~2", "index.js"), humanText.trimEnd());
    assert.equal(showFile("flight-recorder/main~1", "index.js"), finalText.trimEnd());
  });

  test("Claude changing a file through a shell command is recorded as an assistant edit", async () => {
    await configureClaudeHooks();
    const api = await getApi();
    await startRecording();
    const active = api.getRecordingBranchState()?.activeBranchName ?? "";
    const root = repoRoot();
    const newContent = "// prepended by a shell command\nmodule.exports = 1;\n";

    await claudeBash("printf ... | cat - index.js > index.js.tmp && mv index.js.tmp index.js", () => {
      fs.writeFileSync(path.join(root, "index.js.tmp"), newContent);
      fs.renameSync(path.join(root, "index.js.tmp"), path.join(root, "index.js"));
    });
    await waitFor(
      () => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: assistant")),
      "the assistant commit for the shell edit"
    );
    await stopRecording();

    const commits = recordedCommits("flight-recorder/main");
    assert.deepEqual(commits.slice(1), ["Flight Recorder: assistant edits (1 file)"]);
    assert.equal(git(root, "show", "--name-only", "--format=", "flight-recorder/main~1"), "index.js");
    assert.equal(showFile("flight-recorder/main~1", "index.js"), newContent.trimEnd());
  });

  test("a file Claude only read stays human-owned when the human edits it afterwards", async () => {
    await configureClaudeHooks();
    await startRecording();

    await claudeRead("readme.md");
    await sleep(2_000);
    await humanEdit("readme.md", "\nedited after Claude read it\n");
    await sleep(2_000);
    await stopRecording();

    assert.deepEqual(recordedCommits("flight-recorder/main").slice(1), ["Flight Recorder: human edits (1 file)"]);
  });

  test("a second session fast-forwards the final branch", async () => {
    await configureClaudeHooks();
    await startRecording();
    await humanEdit("readme.md", "\nfirst session\n");
    await stopRecording();
    const firstHead = git(repoRoot(), "rev-parse", "flight-recorder/main");

    await startRecording();
    await humanEdit("readme.md", "second session\n");
    await stopRecording();

    assert.equal(git(repoRoot(), "merge-base", "--is-ancestor", firstHead, "flight-recorder/main"), "");
    assert.ok(Number(git(repoRoot(), "rev-list", "--count", `${firstHead}..flight-recorder/main`)) >= 2);
  });
});
