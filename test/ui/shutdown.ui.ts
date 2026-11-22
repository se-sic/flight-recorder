import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { after } from "node:test";
import { appendHook, branches, closeAllWindows, git, makeWorkspace, sleep, VsCodeWindow, waitFor } from "./driver";

after(closeAllWindows);

// UI tests: a real VS Code window driven from outside (see driver.ts). They
// cover what the in-process e2e tests cannot: reloading, quitting and killing
// the window while recording. Run with `npm run test:ui`.

const FINAL = "flight-recorder/main";

/** Starts recording through the command palette and waits for the status bar to switch. */
async function startRecording(window: VsCodeWindow): Promise<void> {
  await window.runCommand("Flight Recorder: Start Recording");
  await waitFor(async () => (await window.bodyText()).includes("Stop Flight Recorder"), "recording to start");
}

/** Types `text` at the top of `rel` in its editor and saves it. */
async function editAndSave(window: VsCodeWindow, rel: string, text: string): Promise<void> {
  await window.openFile(rel);
  await window.type(text);
  await window.save();
  await waitFor(() => fs.readFileSync(path.join(window.workspace, rel), "utf8").includes(text), `${rel} to be saved`);
}

/** Simulates a Claude Edit of `rel` through the hook log and the file on disk. */
async function claudeEdit(workspace: string, rel: string, line: string): Promise<void> {
  const filePath = path.join(workspace, rel);
  const before = fs.readFileSync(filePath, "utf8");
  const toolInput = { file_path: filePath, old_string: before, new_string: `${line}\n${before}` };
  appendHook(workspace, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "ui-edit", tool_input: toolInput });
  await sleep(300);
  fs.writeFileSync(filePath, `${line}\n${before}`);
  await sleep(300);
  appendHook(workspace, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "ui-edit", tool_input: toolInput, tool_response: { filePath } });
}

/** Active (unfinished) recording branches. */
function activeBranches(workspace: string): string[] {
  return branches(workspace).filter((name) => name.includes("-active/"));
}

/** Shows the Flight Recorder panel and returns its text. */
async function panelText(window: VsCodeWindow): Promise<string> {
  await window.runCommand("Focus on Recording History View");
  return waitFor(async () => (await window.webviewTexts()).find((text) => /Recording|recording/.test(text)), "the Flight Recorder panel");
}

test("Reload Window while recording commits the pending edit and finalizes the branch", { timeout: 240_000 }, async () => {
  const { workspace, userDataDir } = makeWorkspace();
  const window = await VsCodeWindow.launch(workspace, userDataDir);
  try {
    await startRecording(window);
    await editAndSave(window, "readme.md", "reload line\n");

    await window.reload();

    await waitFor(() => branches(workspace).includes(FINAL), "the final branch");
    assert.deepEqual(activeBranches(workspace), []);
    assert.match(git(workspace, "show", `${FINAL}:readme.md`), /reload line/);
    assert.match(git(workspace, "log", "--format=%s", `main..${FINAL}`), /^recording stopped: .*\.log\/claude-/m, "log snapshot");
    assert.match(await window.bodyText(), /Start Flight Recorder/);
    assert.match(await panelText(window), /Recording saved/);
  } finally {
    await window.kill();
  }
});

test("quitting VS Code while recording finalizes the branch", { timeout: 240_000 }, async () => {
  const { workspace, userDataDir } = makeWorkspace();
  let window = await VsCodeWindow.launch(workspace, userDataDir);
  await startRecording(window);
  await editAndSave(window, "readme.md", "quit line\n");

  await window.quit();

  assert.ok(branches(workspace).includes(FINAL), branches(workspace).join(", "));
  assert.deepEqual(activeBranches(workspace), []);
  assert.match(git(workspace, "show", `${FINAL}:readme.md`), /quit line/);
  assert.match(git(workspace, "log", "--format=%s", `main..${FINAL}`), /^recording stopped: /m, "log snapshot");

  window = await VsCodeWindow.launch(workspace, userDataDir);
  try {
    const panel = await panelText(window);
    assert.match(panel, /Recording saved/);
    assert.doesNotMatch(panel, /not finalized/);
  } finally {
    await window.kill();
  }
});

test("after a crash, Recover finalizes everything that was already committed", { timeout: 240_000 }, async () => {
  const { workspace, userDataDir } = makeWorkspace();
  let window = await VsCodeWindow.launch(workspace, userDataDir);
  await startRecording(window);
  await editAndSave(window, "readme.md", "before crash\n");
  await claudeEdit(workspace, "index.js", "// claude before crash");
  const active = await waitFor(() => {
    const [name] = activeBranches(workspace);
    return name && Number(git(workspace, "rev-list", "--count", `main..${name}`)) >= 2 ? name : null;
  }, "the human and assistant commits on the active branch");

  await window.kill();
  assert.deepEqual(activeBranches(workspace), [active], "a crash leaves the recording unfinished");

  window = await VsCodeWindow.launch(workspace, userDataDir);
  try {
    assert.match(await panelText(window), /1 earlier recording\(s\) were not finalized/);
    await window.runCommand("Flight Recorder: Recover Unfinished Recordings");
    await waitFor(() => branches(workspace).includes(FINAL) && activeBranches(workspace).length === 0, "the recovered final branch");
    const subjects = git(workspace, "log", "--format=%s", `main..${FINAL}`);
    assert.match(subjects, /human edits/);
    assert.match(subjects, /assistant tool edit/);
    assert.match(git(workspace, "show", `${FINAL}:readme.md`), /before crash/);
  } finally {
    await window.kill();
  }
});
