import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { makeBareRemote, makeTempDir } from "../git-fixtures";
import {
  configureClaudeHooks,
  getApi,
  git,
  humanEdit,
  listBranches,
  recordedCommits,
  repoRoot,
  resetRepo,
  setSetting,
  startRecording,
  stopRecording,
  stubDialogs,
  waitFor,
  within,
} from "./helpers";

const BRANCH = "flight-recorder/main";

/** Runs a Flight Recorder command with scripted dialog answers and returns the dialogs it showed. */
async function runCommand(command: string, answers: Record<string, string | undefined> = {}, timeoutMs = 20_000) {
  const dialogs = stubDialogs(answers);
  try {
    await within(vscode.commands.executeCommand(command), timeoutMs, command);
  } finally {
    dialogs.restore();
  }
  return dialogs.calls;
}

/** Records one short session with a human edit of `readme.md`. */
async function recordSession(text: string): Promise<void> {
  await startRecording();
  await humanEdit("readme.md", text);
  await stopRecording();
}

suite("Recording workflows", () => {
  suiteSetup(async () => {
    await getApi();
    await setSetting("commitMode", "trackingWorktree");
  });

  setup(async () => {
    await resetRepo();
    await configureClaudeHooks();
  });

  test("stop keeps a recording whose final branch is checked out elsewhere, and Recover finishes it once released", async () => {
    const root = repoRoot();
    await recordSession("\nfirst session\n");
    const holder = path.join(makeTempDir("fr-e2e-holder-"), "wt");
    git(root, "worktree", "add", "-q", holder, BRANCH);
    const before = git(root, "rev-parse", BRANCH);

    try {
      const dialogs = stubDialogs({});
      try {
        await startRecording();
        await humanEdit("readme.md", "second session\n");
        await stopRecording();
      } finally {
        dialogs.restore();
      }
      const warning = dialogs.calls.map((call) => call.message).join("\n");
      assert.match(warning, /checked out/);
      assert.match(warning, /Recover/);
      assert.equal(git(root, "rev-parse", BRANCH), before, "final branch untouched");
      const unfinished = await (await getApi()).listUnfinishedRecordings();
      assert.equal(unfinished.length, 1);
    } finally {
      git(root, "worktree", "remove", "--force", holder);
    }

    await runCommand("flightRecorder.recoverRecordings");

    assert.deepEqual(await (await getApi()).listUnfinishedRecordings(), []);
    assert.equal(git(root, "merge-base", "--is-ancestor", before, BRANCH), "");
    assert.match(git(root, "show", `${BRANCH}:readme.md`), /second session/);
    assert.deepEqual(listBranches(root).filter((name) => name.includes("-active/")), []);
  });

  test("when idle, the panel follows the checked-out branch", async () => {
    const api = await getApi();
    const root = repoRoot();
    await recordSession("\non main\n");
    assert.equal((await api.getPanelBranchState())?.finalBranchName, BRANCH);

    git(root, "checkout", "-q", "-b", "other");
    const onOther = await api.getPanelBranchState();
    assert.equal(onOther?.finalBranchName, "flight-recorder/other");
    assert.equal(listBranches(root).includes("flight-recorder/other"), false, "nothing recorded on other yet");

    await recordSession("on other\n");
    assert.ok(listBranches(root).includes("flight-recorder/other"));
    assert.equal((await api.getPanelBranchState())?.finalBranchName, "flight-recorder/other");

    git(root, "checkout", "-q", "-f", "main");
    assert.equal((await api.getPanelBranchState())?.finalBranchName, BRANCH);
  });

  test("a later session is pushed again as a fast-forward, without force", async () => {
    const root = repoRoot();
    const remote = makeBareRemote();
    git(root, "remote", "add", "origin", remote);
    await recordSession("\nfirst push\n");
    await runCommand("flightRecorder.pushTrackingBranch");
    const firstPushed = git(remote, "rev-parse", BRANCH);

    await recordSession("second push\n");
    assert.equal(git(root, "rev-list", "--count", `origin/${BRANCH}..${BRANCH}`), "2");
    const calls = await runCommand("flightRecorder.pushTrackingBranch");

    assert.equal(calls.some((call) => call.kind === "showQuickPick"), false);
    assert.equal(git(remote, "rev-parse", BRANCH), git(root, "rev-parse", BRANCH));
    assert.equal(git(remote, "merge-base", "--is-ancestor", firstPushed, BRANCH), "");
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

suite("Anonymize Repository", () => {
  suiteSetup(async () => {
    await getApi();
    await setSetting("commitMode", "trackingWorktree");
    await setSetting("absolutePathHandling", "repoOnly");
  });

  setup(async () => {
    await resetRepo();
    await configureClaudeHooks();
  });

  test("installs git-filter-repo and writes a clone without identities or repo paths", async function () {
    if (!hasPython) {
      this.skip();
    }
    this.timeout(300_000);
    const root = repoRoot();
    // The human edit puts the absolute repo path into recorded file content.
    await startRecording();
    await humanEdit("readme.md", `\nsee ${path.join(root, "index.js")}\n`);
    await stopRecording();
    assert.ok(recordedCommits(BRANCH).length >= 1);

    const destination = makeTempDir("fr-e2e-anon-");
    const window = vscode.window as unknown as Record<string, unknown>;
    const showOpenDialog = window.showOpenDialog;
    window.showOpenDialog = async () => [vscode.Uri.file(destination)];
    try {
      await runCommand("flightRecorder.anonymizeRepo", {}, 280_000);
    } finally {
      window.showOpenDialog = showOpenDialog;
    }

    const clone = await waitFor(
      () => fs.readdirSync(destination).map((name) => path.join(destination, name))[0],
      "the anonymized clone"
    );
    const identities = git(clone, "log", "--all", "--format=%an <%ae>|%cn <%ce>").split("\n");
    assert.ok(identities.every((line) => /^Anonymous Developer/.test(line) && line.includes("|Anonymous Developer")), identities.join("\n"));
    const readme = git(clone, "show", `${BRANCH}:readme.md`);
    assert.match(readme, /<REPO_ROOT>\/index\.js/);
    assert.doesNotMatch(readme, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(git(root, "log", "-1", "--format=%an", BRANCH), "E2E User", "original repository unchanged");
  });
});
