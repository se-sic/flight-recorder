import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  appendHook,
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

  test("stopping while the window no longer answers still commits and finalizes", async () => {
    await configureClaudeHooks();
    await startRecording();
    await humanEdit("readme.md", "\nedited right before a reload\n");

    // During a reload, calls to the window (like setContext) may never settle.
    const commands = vscode.commands as unknown as Record<string, unknown>;
    const executeCommand = vscode.commands.executeCommand;
    commands.executeCommand = (command: string, ...args: unknown[]) =>
      command === "setContext" ? new Promise(() => undefined) : executeCommand(command, ...args);
    try {
      await stopRecording();
    } finally {
      commands.executeCommand = executeCommand;
    }

    const commits = recordedCommits("flight-recorder/main");
    assert.ok(commits.includes("Flight Recorder: human edits (1 file)"), commits.join("\n"));
    assert.match(showFile("flight-recorder/main", "readme.md"), /edited right before a reload/);
    assert.deepEqual(listBranches(repoRoot()).filter((name) => name.includes("-active/")), []);
  });

  test("an edit the participant rejects does not turn their later edit of that file into an assistant edit", async () => {
    await configureClaudeHooks();
    await startRecording();
    const toolInput = { file_path: path.join(repoRoot(), "index.js"), old_string: "module.exports = 1;", new_string: "module.exports = 2;" };
    // Claude announces the edit, the participant rejects it: no change, no PostToolUse.
    appendHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "rejected", tool_input: toolInput });
    await sleep(500);
    appendHook({ hook_event_name: "Stop" });
    await sleep(2_000);
    await humanEdit("index.js", "// the participant's own change\n");
    await sleep(1_500);
    await stopRecording();

    assert.deepEqual(recordedCommits("flight-recorder/main").slice(1), ["Flight Recorder: human edits (1 file)"]);
    assert.match(showFile("flight-recorder/main", "index.js"), /the participant's own change/);
  });
});
