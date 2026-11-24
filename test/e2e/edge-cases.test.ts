import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  claudeBash,
  claudeEdit,
  configureClaudeHooks,
  getApi,
  git,
  humanEdit,
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

const FINAL = "flight-recorder/main";

/** Lists `kind: files` for each recorded commit on the final branch, oldest first, with git's exact file names. */
function recorded(base = "e2e-base"): Array<{ subject: string; files: string[] }> {
  const root = repoRoot();
  return git(root, "rev-list", "--reverse", `${base}..${FINAL}`).split("\n").filter(Boolean).map((sha) => ({
    subject: git(root, "log", "-1", "--format=%s", sha).split(" {")[0],
    files: git(root, "-c", "core.quotePath=false", "show", "--name-status", "--format=", sha).split("\n").filter(Boolean),
  }));
}

/** Waits until the running recording has an assistant commit on its active branch. */
async function waitForAssistantCommit(): Promise<void> {
  const active = (await getApi()).getRecordingBranchState()?.activeBranchName ?? "";
  await waitFor(
    () => recordedCommits(active).some((subject) => subject.startsWith("Flight Recorder: assistant")),
    "an assistant commit on the active branch"
  );
}

/** Whether `rel` exists on the final branch. */
function onFinalBranch(rel: string): boolean {
  return git(repoRoot(), "ls-tree", "--name-only", FINAL, "--", rel) !== "";
}

suite("Edge cases", () => {
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

  test("Claude deleting a file through the shell deletes it on the recording branch", async () => {
    await startRecording();
    await claudeBash("rm index.js", () => fs.rmSync(path.join(repoRoot(), "index.js")));
    await waitForAssistantCommit();
    await stopRecording();

    const [commit] = recorded();
    assert.match(commit.subject, /^Flight Recorder: assistant/);
    assert.deepEqual(commit.files, ["D\tindex.js"]);
    assert.equal(onFinalBranch("index.js"), false);
  });

  test("Claude renaming a file through the shell records the rename as one assistant commit", async () => {
    const root = repoRoot();
    await startRecording();
    await claudeBash("mv readme.md docs.md", () => fs.renameSync(path.join(root, "readme.md"), path.join(root, "docs.md")));
    await waitForAssistantCommit();
    await stopRecording();

    const commits = recorded().filter((commit) => !commit.subject.startsWith("recording stopped"));
    assert.equal(commits.length, 1, JSON.stringify(commits));
    assert.match(commits[0].subject, /^Flight Recorder: assistant/);
    assert.equal(onFinalBranch("readme.md"), false);
    assert.equal(onFinalBranch("docs.md"), true);
  });

  test("a human rename and delete in VS Code are human commits", async () => {
    const root = repoRoot();
    await startRecording();
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(path.join(root, "index.js")), vscode.Uri.file(path.join(root, "main.js")));
    edit.deleteFile(vscode.Uri.file(path.join(root, "readme.md")));
    assert.ok(await vscode.workspace.applyEdit(edit));
    await sleep(1_500);
    await stopRecording();

    const commits = recorded().filter((commit) => !commit.subject.startsWith("recording stopped"));
    assert.ok(commits.every((commit) => commit.subject.startsWith("Flight Recorder: human edits")), JSON.stringify(commits));
    assert.equal(onFinalBranch("index.js"), false);
    assert.equal(onFinalBranch("main.js"), true);
    assert.equal(onFinalBranch("readme.md"), false);
  });

  test("an npm install by Claude (thousands of ignored files) records only the real change, quickly", async function () {
    this.timeout(120_000);
    const root = repoRoot();
    await startRecording();
    const started = Date.now();
    await claudeBash("npm install && npm pkg set version=2.0.0", () => {
      for (let i = 0; i < 3_000; i++) {
        const dir = path.join(root, "node_modules", `pkg-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "index.js"), `module.exports = ${i};\n`);
      }
      fs.writeFileSync(path.join(root, "index.js"), "module.exports = 2;\n");
    });
    await waitForAssistantCommit();
    await stopRecording();
    const elapsed = Date.now() - started;

    const files = recorded().flatMap((commit) => commit.files);
    assert.ok(files.every((entry) => !entry.includes("node_modules")), files.slice(0, 5).join(", "));
    assert.ok(files.includes("M\tindex.js"), files.join(", "));
    assert.ok(elapsed < 30_000, `recording took ${elapsed} ms`);
  });

  test("file names with spaces and non-ASCII characters are recorded exactly", async () => {
    const root = repoRoot();
    fs.mkdirSync(path.join(root, "docs ü"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs ü", "Ärger & Co.md"), "# Notizen\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "add docs");
    await startRecording();

    await humanEdit("docs ü/Ärger & Co.md", "\nvon Hand\n");
    await sleep(1_200);
    await claudeEdit("docs ü/Ärger & Co.md", "# Notizen\n\nvon Hand\n\nvon Claude\n");
    await waitForAssistantCommit();
    await stopRecording();

    const commits = recorded("main").filter((commit) => !commit.subject.startsWith("recording stopped"));
    assert.deepEqual(commits.map((commit) => commit.files), [["M\tdocs ü/Ärger & Co.md"], ["M\tdocs ü/Ärger & Co.md"]]);
    assert.match(commits[0].subject, /^Flight Recorder: human edits/);
    assert.match(commits[1].subject, /^Flight Recorder: assistant tool edit/);
  });

  test("unsaved human text and a Claude edit of the same file on disk (documents the behavior)", async () => {
    const root = repoRoot();
    const file = path.join(root, "index.js");
    await startRecording();
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), "// typed but not saved\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    await sleep(1_200);

    await claudeEdit("index.js", "// claude\nmodule.exports = 1;\n");
    await waitForAssistantCommit();
    await stopRecording();

    const commits = recorded().filter((commit) => !commit.subject.startsWith("recording stopped"));
    const contents = commits.map((commit, i) => `${commit.subject}: ${JSON.stringify(git(root, "show", `${FINAL}~${commits.length - i}:index.js`))}`);
    console.log(`Unsaved-edit scenario:\n  ${contents.join("\n  ")}\n  editor: ${JSON.stringify(document.getText())} dirty=${document.isDirty}\n  disk: ${JSON.stringify(fs.readFileSync(file, "utf8"))}`);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });
});
