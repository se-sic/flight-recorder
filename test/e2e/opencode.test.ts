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
  stubDialogs,
  waitFor,
  within,
} from "./helpers";

const PLUGIN = ".opencode/plugins/flight-recorder.ts";
const LOG = ".opencode/flight-recorder-events.jsonl";
const SESSION = "ses_e2e";

/** Runs "Configure OpenCode Plugin", confirming its dialog. */
async function configureOpenCodePlugin(): Promise<void> {
  const stub = stubDialogs({
    "OpenCode plugin to": "Configure OpenCode Plugin",
    "configured the OpenCode plugin": "OK",
  });
  try {
    await within(
      vscode.commands.executeCommand("flightRecorder.configureOpenCodePlugin"),
      10_000,
      "the Configure OpenCode Plugin command"
    );
  } finally {
    stub.restore();
  }
}

/** Appends one record to the plugin log, like the generated OpenCode plugin does. */
function appendRecord(record: Record<string, unknown>): void {
  fs.appendFileSync(
    path.join(repoRoot(), LOG),
    `${JSON.stringify({ fr: 2, ts: Date.now(), sessionID: SESSION, ...record })}\n`
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
    assert.match(fs.readFileSync(path.join(root, PLUGIN), "utf8"), /flight-recorder-plugin-schema: 2/);
    const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /\.opencode\/plugins\/flight-recorder\.ts/);
    assert.match(exclude, /\.opencode\/flight-recorder-events\.jsonl/);
    assert.equal(
      vscode.workspace.getConfiguration("flightRecorder").get("activeIntegration"),
      "opencode"
    );
    assert.equal(git(root, "status", "--porcelain"), "", "plugin setup leaves git status clean");
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
});
