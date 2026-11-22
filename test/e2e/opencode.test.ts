import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  getApi,
  git,
  humanEdit,
  recordedCommits,
  repoRoot,
  resetRepo,
  setSetting,
  showFile,
  sleep,
  startRecording,
  stopRecording,
  configureOpenCodePlugin,
  listBranches,
  stubDialogs,
  waitFor,
  within,
} from "./helpers";

const PLUGIN = ".opencode/plugins/flight-recorder.ts";
const LOG = ".opencode/flight-recorder-events.jsonl";
const SESSION = "ses_e2e";


/** Appends one record to the plugin log, like the generated OpenCode plugin does. */
function appendRecord(record: Record<string, unknown>): void {
  fs.appendFileSync(
    path.join(repoRoot(), LOG),
    `${JSON.stringify({ fr: 3, ts: Date.now(), sessionID: SESSION, ...record })}\n`
  );
}

let callCounter = 0;

/**
 * Simulates one OpenCode tool call: the `pre` record, the tool's effect on
 * disk (`change`), then the `post` record with the tool result.
 */
async function openCodeTool(
  tool: string,
  input: Record<string, unknown>,
  change: () => void,
  post: Record<string, unknown> = {},
  messageID = "msg_e2e"
): Promise<void> {
  const shared = { tool, messageID, callID: `call_${++callCounter}`, agent: "build", input };
  appendRecord({ kind: "pre", ...shared });
  await sleep(400);
  change();
  await sleep(tool === "shell" ? 1_500 : 400);
  appendRecord({ kind: "post", ...shared, status: "completed", ...post });
}

/** Simulates OpenCode's `edit` tool replacing the whole content of `rel`. */
async function openCodeEdit(rel: string, newContent: string): Promise<void> {
  const filePath = path.join(repoRoot(), rel);
  const oldContent = fs.readFileSync(filePath, "utf8");
  await openCodeTool(
    "edit",
    { path: filePath, oldString: oldContent, newString: newContent },
    () => fs.writeFileSync(filePath, newContent),
    { metadata: { files: [{ file: rel, status: "modified" }] } }
  );
}

/** Lists `subject: files` for each recorded commit on the final branch, oldest first. */
function recordedFiles(): Array<{ subject: string; files: string[] }> {
  const root = repoRoot();
  return git(root, "rev-list", "--reverse", "e2e-base..flight-recorder/main").split("\n").filter(Boolean).map((sha) => ({
    subject: git(root, "log", "-1", "--format=%s", sha).split(" {")[0],
    files: git(root, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean),
  }));
}

/** The subject of the one recorded commit that changed `file`. */
function subjectFor(file: string): string {
  const commits = recordedFiles().filter((commit) => commit.files.includes(file));
  assert.equal(commits.length, 1, `${file} in exactly one commit: ${JSON.stringify(recordedFiles())}`);
  return commits[0].subject;
}

/** Waits until the active branch of the running recording has an assistant commit. */
async function waitForAssistantCommit(): Promise<void> {
  const active = (await getApi()).getRecordingBranchState()?.activeBranchName ?? "";
  await waitFor(
    () => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: assistant")),
    "an assistant commit on the active branch"
  );
}

suite("OpenCode plugin recording", () => {
  let dialogs: ReturnType<typeof stubDialogs>;

  suiteSetup(async () => {
    await getApi();
    await setSetting("debounceMs", 500);
    await setSetting("commitMode", "trackingWorktree");
  });

  setup(async () => {
    await resetRepo();
    dialogs = stubDialogs({});
    await configureOpenCodePlugin();
    // The log is git-excluded, so resetRepo keeps it; start every test empty.
    fs.writeFileSync(path.join(repoRoot(), LOG), "");
    appendRecord({ kind: "setup", directory: repoRoot(), app: { name: "cli", version: "2.2.2" } });
  });

  teardown(() => dialogs.restore());

  suiteTeardown(async () => {
    // Other suites configure their own integration; don't leave OpenCode selected.
    await vscode.workspace
      .getConfiguration("flightRecorder")
      .update("activeIntegration", undefined, vscode.ConfigurationTarget.Workspace);
  });

  test("Configure OpenCode Plugin installs the plugin and keeps git status clean", async () => {
    const root = repoRoot();
    assert.ok(fs.existsSync(path.join(root, PLUGIN)));
    assert.match(fs.readFileSync(path.join(root, PLUGIN), "utf8"), /flight-recorder-plugin-schema: 3/);
    const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /\.opencode\/plugins\/flight-recorder\.ts/);
    assert.match(exclude, /\.opencode\/flight-recorder-events\.jsonl/);
    assert.equal(
      vscode.workspace.getConfiguration("flightRecorder").get("activeIntegration"),
      "opencode"
    );
    // resetRepo creates .claude/ for the Claude tests; it is only excluded once those ran.
    const status = git(root, "status", "--porcelain").split("\n").filter((line) => line && !line.endsWith(" .claude/"));
    assert.deepEqual(status, [], "plugin setup leaves git status clean");
  });

  test("human and OpenCode edits land in separate commits on the final branch", async () => {
    const api = await getApi();
    const root = repoRoot();
    const mainHead = git(root, "rev-parse", "main");
    await startRecording();
    const active = api.getRecordingBranchState()?.activeBranchName ?? "";

    await humanEdit("readme.md", "\nHuman line\n");
    await sleep(1_200);
    const newContent = "// opencode comment\nmodule.exports = 1;\n";
    await openCodeEdit("index.js", newContent);
    await waitFor(
      () => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: assistant")),
      "the assistant commit on the active branch"
    );
    await stopRecording();

    const commits = recordedCommits("flight-recorder/main");
    assert.match(commits[0], /^recording stopped: /);
    assert.deepEqual(commits.slice(1), [
      "Flight Recorder: assistant tool edit (1 file)",
      "Flight Recorder: human edits (1 file)",
    ]);
    assert.equal(git(root, "show", "--name-only", "--format=", "flight-recorder/main~1"), "index.js");
    assert.equal(showFile("flight-recorder/main~1", "index.js"), newContent.trimEnd());
    assert.equal(git(root, "show", "--name-only", "--format=", "flight-recorder/main~2"), "readme.md");
    const body = git(root, "log", "-1", "--format=%B", "flight-recorder/main~1");
    assert.match(body, /"fileAttributions":\[\{"path":"index.js","origin":"assistant-tool-edit"/);
    assert.equal(git(root, "rev-parse", "main"), mainHead, "the user's branch is untouched");
  });

  test("a file OpenCode changes through a shell command is recorded as an assistant edit", async () => {
    const api = await getApi();
    const root = repoRoot();
    await startRecording();
    const active = api.getRecordingBranchState()?.activeBranchName ?? "";
    const newContent = "// prepended by a shell command\nmodule.exports = 1;\n";

    await openCodeTool("shell", { command: "./prepend.sh index.js" }, () => {
      fs.writeFileSync(path.join(root, "index.js.tmp"), newContent);
      fs.renameSync(path.join(root, "index.js.tmp"), path.join(root, "index.js"));
    });
    appendRecord({ kind: "step", messageID: "msg_e2e", files: ["index.js"], snapshot: "snap" });
    appendRecord({ kind: "idle", outcome: "succeeded" });
    await waitFor(
      () => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: assistant")),
      "the assistant commit for the shell edit"
    );
    await stopRecording();

    const commits = recordedCommits("flight-recorder/main").slice(1);
    assert.equal(commits.length, 1);
    assert.match(commits[0], /^Flight Recorder: assistant .*\(1 file\)$/);
    assert.equal(git(root, "show", "--name-only", "--format=", "flight-recorder/main~1"), "index.js");
    assert.equal(showFile("flight-recorder/main~1", "index.js"), newContent.trimEnd());
  });

  test("a file OpenCode only read stays human-owned when the human edits it afterwards", async () => {
    await startRecording();

    await openCodeTool("read", { path: path.join(repoRoot(), "readme.md") }, () => undefined);
    await sleep(2_000);
    await humanEdit("readme.md", "\nedited after OpenCode read it\n");
    await sleep(2_000);
    await stopRecording();

    assert.deepEqual(recordedCommits("flight-recorder/main").slice(1), [
      "Flight Recorder: human edits (1 file)",
    ]);
  });
  test("B6a: a human edit of another file while OpenCode edits stays human", async () => {
    const root = repoRoot();
    await startRecording();
    const filePath = path.join(root, "index.js");
    const newContent = "// opencode while the human types\nmodule.exports = 1;\n";
    await openCodeTool(
      "edit",
      { path: filePath, oldString: fs.readFileSync(filePath, "utf8"), newString: newContent },
      () => fs.writeFileSync(filePath, newContent),
      { metadata: { files: [{ file: "index.js", status: "modified" }] } },
      "msg_b6a"
    );
    await humanEdit("readme.md", "\nhuman during the OpenCode turn\n");
    await waitForAssistantCommit();
    await sleep(1_500);
    await stopRecording();

    assert.match(subjectFor("index.js"), /^Flight Recorder: assistant tool edit/);
    assert.match(subjectFor("readme.md"), /^Flight Recorder: human edits/);
  });

  test("B6b: while an OpenCode shell command runs, every change is the assistant's (documented tradeoff)", async () => {
    const root = repoRoot();
    await startRecording();
    const shared = { tool: "shell", messageID: "msg_b6b", callID: "call_b6b", agent: "build", input: { command: "sleep 2 && echo done >> notes.txt" } };
    appendRecord({ kind: "pre", ...shared });
    await sleep(400);
    await humanEdit("readme.md", "\nhuman during a shell command\n");
    fs.writeFileSync(path.join(root, "notes.txt"), "done\n");
    await sleep(800);
    appendRecord({ kind: "post", ...shared, status: "completed" });
    appendRecord({ kind: "step", messageID: "msg_b6b", files: ["notes.txt"], snapshot: "snap" });
    appendRecord({ kind: "idle", outcome: "succeeded" });
    await waitForAssistantCommit();
    await stopRecording();

    assert.match(subjectFor("notes.txt"), /^Flight Recorder: assistant/);
    assert.match(subjectFor("readme.md"), /^Flight Recorder: assistant/);
  });

  test("B7: interrupting a shell command closes the assistant window right away", async () => {
    await startRecording();
    appendRecord({ kind: "pre", tool: "shell", messageID: "msg_b7", callID: "call_b7", agent: "build", input: { command: "sleep 60 && echo late >> notes.txt" } });
    await sleep(500);
    appendRecord({ kind: "idle", outcome: "interrupted", reason: "user" });
    await sleep(1_500);
    await humanEdit("readme.md", "\nhuman after the interrupt\n");
    await sleep(1_500);
    await stopRecording();

    assert.deepEqual(recordedCommits("flight-recorder/main").slice(1), ["Flight Recorder: human edits (1 file)"]);
    assert.equal(fs.existsSync(path.join(repoRoot(), "notes.txt")), false);
  });

  test("B8: OpenCode started before the recording still has its relative paths resolved to the repo", async () => {
    // setup() wrote the setup record before recording started, so the parser never sees it.
    const root = repoRoot();
    await startRecording();
    const newContent = "// relative path edit\nmodule.exports = 1;\n";
    await openCodeTool(
      "edit",
      { path: "index.js", oldString: "module.exports = 1;\n", newString: newContent },
      () => fs.writeFileSync(path.join(root, "index.js"), newContent),
      { metadata: { files: [{ file: "index.js", status: "modified" }] } },
      "msg_b8"
    );
    await waitForAssistantCommit();
    await stopRecording();

    assert.match(subjectFor("index.js"), /^Flight Recorder: assistant tool edit/);
    assert.equal(showFile("flight-recorder/main", "index.js"), newContent.trimEnd());
  });

  test("B9: an outdated plugin is reported at start and updated by the offered action", async () => {
    const pluginPath = path.join(repoRoot(), PLUGIN);
    fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, "utf8").replace(/flight-recorder-plugin-schema: \d+/, "flight-recorder-plugin-schema: 2"));
    dialogs.restore();
    dialogs = stubDialogs({
      "is outdated": "Configure OpenCode Plugin",
      "OpenCode plugin to": "Configure OpenCode Plugin",
      "configured the OpenCode plugin": "OK",
    });

    await startRecording();
    await waitFor(() => /flight-recorder-plugin-schema: 3/.test(fs.readFileSync(pluginPath, "utf8")), "the updated plugin");
    await openCodeEdit("index.js", "// after the plugin update\nmodule.exports = 1;\n");
    await waitForAssistantCommit();
    await stopRecording();

    assert.ok(dialogs.calls.some((call) => /outdated/.test(call.message)), "outdated warning shown");
    assert.match(subjectFor("index.js"), /^Flight Recorder: assistant tool edit/);
  });

  test("B10a: with the log missing, recording waits and attaches once OpenCode creates it", async () => {
    const logPath = path.join(repoRoot(), LOG);
    fs.rmSync(logPath);
    await startRecording();
    assert.equal((await getApi()).isRecording(), true);

    fs.writeFileSync(logPath, "");
    await sleep(2_500);
    await openCodeEdit("index.js", "// after the log appeared\nmodule.exports = 1;\n");
    await waitForAssistantCommit();
    await stopRecording();

    assert.match(subjectFor("index.js"), /^Flight Recorder: assistant tool edit/);
  });

  test("B10b: with openCodeMissingSourceBehavior=fail, a missing log stops the start cleanly", async () => {
    fs.rmSync(path.join(repoRoot(), LOG));
    await setSetting("openCodeMissingSourceBehavior", "fail");
    try {
      await startRecording();
      assert.equal((await getApi()).isRecording(), false);
      assert.ok(dialogs.calls.some((call) => /flight-recorder-events\.jsonl/.test(call.message)), JSON.stringify(dialogs.calls));
      assert.deepEqual(listBranches(repoRoot()).filter((name) => name.includes("-active/")), []);
    } finally {
      await setSetting("openCodeMissingSourceBehavior", undefined);
    }
  });

  test("B12: the same file edited by the human, then by OpenCode, is split between the commits", async () => {
    const root = repoRoot();
    await startRecording();
    await humanEdit("index.js", "// human line\n");
    await sleep(1_200);
    const withHuman = fs.readFileSync(path.join(root, "index.js"), "utf8");
    await openCodeEdit("index.js", `// opencode line\n${withHuman}`);
    await waitForAssistantCommit();
    await stopRecording();

    const [human, assistant] = recordedFiles().filter((commit) => commit.files.includes("index.js"));
    assert.match(human.subject, /^Flight Recorder: human edits/);
    assert.match(assistant.subject, /^Flight Recorder: assistant tool edit/);
    assert.equal(showFile("flight-recorder/main~2", "index.js"), withHuman.trimEnd());
    assert.doesNotMatch(showFile("flight-recorder/main~2", "index.js"), /opencode line/);
    assert.equal(showFile("flight-recorder/main", "index.js"), fs.readFileSync(path.join(root, "index.js"), "utf8").trimEnd());
  });
});
