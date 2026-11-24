import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  claudeBash,
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

/** Subject (without metadata) and changed files of each recorder commit on `branch` after `base`, oldest first. */
function recorderCommits(branch: string, base: string): Array<{ subject: string; files: string[] }> {
  const root = repoRoot();
  return git(root, "rev-list", "--reverse", `${base}..${branch}`).split("\n").filter(Boolean)
    .map((sha) => ({
      subject: git(root, "log", "-1", "--format=%s", sha).split(" (")[0],
      files: git(root, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean),
    }))
    .filter((commit) => commit.subject.startsWith("Flight Recorder:"));
}

/** Commits `files` (relative path → content) on a new branch `name` and goes back to main. */
function makeBranch(name: string, files: Record<string, string>): void {
  const root = repoRoot();
  git(root, "checkout", "-q", "-b", name);
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `${name} work`);
  git(root, "checkout", "-q", "main");
}

/** Opens `rel` in an editor without changing it, so git changing it makes VS Code reload it. */
async function openUnchanged(rel: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(path.join(repoRoot(), rel));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

/** The running recording's active branch. */
async function activeBranch(): Promise<string> {
  return (await getApi()).getRecordingBranchState()?.activeBranchName ?? "";
}

suite("Git operations while recording", () => {
  let dialogs: ReturnType<typeof stubDialogs>;

  suiteSetup(async () => {
    await getApi();
    await setSetting("debounceMs", 500);
    await setSetting("commitMode", "trackingWorktree");
  });

  setup(async () => {
    await resetRepo();
    dialogs = stubDialogs({});
    await configureClaudeHooks();
  });

  teardown(() => dialogs.restore());

  test("switching branches saves the recording and starts a new one on the checked-out branch", async () => {
    const root = repoRoot();
    makeBranch("other", { "index.js": "module.exports = 'other';\n" });
    await startRecording();
    await humanEdit("readme.md", "\non main\n");
    await openUnchanged("index.js");
    await sleep(500);

    git(root, "checkout", "-q", "other");
    const api = await getApi();
    await waitFor(
      () => api.isRecording() && api.getRecordingBranchState()?.sourceBranchName === "other",
      "the recording to move to the other branch"
    );
    assert.ok(listBranches(root).includes("flight-recorder/main"), "the recording of main is saved");
    await sleep(1_500);
    await humanEdit("index.js", "// on other\n");
    await stopRecording();

    assert.deepEqual(listBranches(root).filter((name) => name.includes("-active/")), []);
    assert.deepEqual(recorderCommits("flight-recorder/main", "main"), [
      { subject: "Flight Recorder: human edits", files: ["readme.md"] },
    ]);
    assert.deepEqual(recorderCommits("flight-recorder/other", "other"), [
      { subject: "Flight Recorder: human edits", files: ["index.js"] },
    ]);
    assert.equal(git(root, "show", "flight-recorder/other:index.js"), "module.exports = 'other';\n// on other");
    assert.equal(git(root, "show", "flight-recorder/main:index.js"), "module.exports = 1;", "main's recording never sees other's files");
  });

  test("a merge is recorded as a git operation, not as human edits", async () => {
    const root = repoRoot();
    makeBranch("side", { "index.js": "module.exports = 'side';\n", "lib.js": "exports.lib = true;\n" });
    await startRecording();
    await humanEdit("readme.md", "\nbefore merge\n");
    const index = await openUnchanged("index.js");

    git(root, "merge", "-q", "--ff-only", "side");
    const active = await activeBranch();
    await waitFor(() => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: git operation")), "the git operation commit");
    await waitFor(() => index.getText().includes("side"), "the editor to reload index.js");
    await sleep(1_000);
    await humanEdit("readme.md", "after merge\n");
    await stopRecording();

    assert.deepEqual(recorderCommits("flight-recorder/main", "e2e-base"), [
      { subject: "Flight Recorder: human edits", files: ["readme.md"] },
      { subject: "Flight Recorder: git operation", files: ["index.js", "lib.js"] },
      { subject: "Flight Recorder: human edits", files: ["readme.md"] },
    ]);
    const body = git(root, "log", "-1", "--format=%B", "flight-recorder/main~2");
    assert.match(body, /"operation":"merge side: Fast-forward"/);
  });

  test("a stash run by Claude is a git operation, not an assistant edit", async () => {
    const root = repoRoot();
    await startRecording();
    await humanEdit("index.js", "// work in progress\n");
    await sleep(1_200);
    await claudeBash("git stash", () => git(root, "stash", "-q"));
    const active = await activeBranch();
    await waitFor(() => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: git operation")), "the git operation commit");
    await stopRecording();

    assert.deepEqual(recorderCommits("flight-recorder/main", "e2e-base"), [
      { subject: "Flight Recorder: human edits", files: ["index.js"] },
      { subject: "Flight Recorder: git operation", files: ["index.js"] },
    ]);
    assert.equal(git(root, "show", "flight-recorder/main:index.js"), "module.exports = 1;");
  });

  test("a plain commit changes nothing in the recording", async () => {
    const root = repoRoot();
    await startRecording();
    await humanEdit("index.js", "// committed by hand\n");
    git(root, "commit", "-q", "-am", "by hand");
    await sleep(1_500);
    await stopRecording();

    assert.deepEqual(recorderCommits("flight-recorder/main", "e2e-base"), [
      { subject: "Flight Recorder: human edits", files: ["index.js"] },
    ]);
  });
});
