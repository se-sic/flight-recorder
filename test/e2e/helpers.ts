import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { git, listBranches } from "../git-fixtures";

export { git, listBranches };

export const EXTENSION_ID = "SE-SIC.flight-recorder";

/** The branch state the extension shows in its history panel (subset used by the tests). */
export type BranchState = {
  repoRoot: string;
  isRecording: boolean;
  commitMode: "trackingWorktree" | "currentBranch";
  activeBranchName?: string;
  finalBranchName?: string;
  displayBranchName?: string;
  finalized: boolean;
};

/** Mirrors `FlightRecorderApi` in src/extension.ts. */
export type FlightRecorderApi = {
  isRecording: () => boolean;
  getRecordingBranchState: () => BranchState | null;
  getPersistedRecordingBranchState: () => BranchState | undefined;
  listUnfinishedRecordings: () => Promise<Array<{ activeBranchName: string; finalBranchName: string }>>;
  getPanelBranchState: () => Promise<(BranchState & { sourceBranchName?: string }) | null>;
};
export const HOOK_LOG = ".claude/flight-recorder-hooks.jsonl";

/** Absolute path of the throwaway workspace repository. */
export function repoRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "e2e tests need a workspace folder");
  return folder.uri.fsPath;
}

/** Activates the extension and returns its test API. */
export async function getApi(): Promise<FlightRecorderApi> {
  const extension = vscode.extensions.getExtension<FlightRecorderApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} should be installed`);
  return extension.activate();
}

/** Polls `condition` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  description: string,
  timeoutMs = 15_000
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await condition();
    if (last) {
      return last as NonNullable<T>;
    }
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects if `promise` does not settle within `ms`, naming what hung. */
export async function within<T>(promise: Thenable<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type DialogAnswer = string | undefined | ((message: string, items: unknown[]) => unknown);

export type DialogCall = { kind: string; message: string; modal: boolean; items: string[] };

/**
 * Replaces VS Code's message and quick-pick dialogs with scripted answers.
 * `answers` maps a regex source (matched against the message or quick-pick
 * title) to the item label to "click"; unmatched dialogs are dismissed.
 * Returns the recorded calls and a restore function.
 */
export function stubDialogs(answers: Record<string, DialogAnswer>) {
  const window = vscode.window as unknown as Record<string, unknown>;
  const names = ["showInformationMessage", "showWarningMessage", "showErrorMessage", "showQuickPick"];
  const originals = Object.fromEntries(names.map((name) => [name, window[name]]));
  const calls: DialogCall[] = [];

  const labelOf = (item: unknown) =>
    typeof item === "string" ? item : (item as { label?: string; title?: string })?.label ??
      (item as { title?: string })?.title ?? "";
  const answerFor = (text: string, items: unknown[]) => {
    for (const [pattern, answer] of Object.entries(answers)) {
      if (new RegExp(pattern).test(text)) {
        if (typeof answer === "function") {
          return answer(text, items);
        }
        return items.find((item) => labelOf(item) === answer);
      }
    }
    return undefined;
  };

  for (const kind of names.slice(0, 3)) {
    window[kind] = async (message: string, ...rest: unknown[]) => {
      const options = rest[0] && typeof rest[0] === "object" && !("title" in (rest[0] as object))
        ? rest[0] as vscode.MessageOptions
        : undefined;
      const items = options ? rest.slice(1) : rest;
      calls.push({ kind, message, modal: !!options?.modal, items: items.map(labelOf) });
      return answerFor(message, items);
    };
  }
  window.showQuickPick = async (rawItems: unknown, options?: vscode.QuickPickOptions) => {
    const items = (await rawItems) as unknown[];
    const title = options?.title ?? options?.placeHolder ?? "";
    calls.push({ kind: "showQuickPick", message: title, modal: false, items: items.map(labelOf) });
    return answerFor(title, items);
  };

  return {
    calls,
    restore: () => {
      for (const name of names) {
        window[name] = originals[name];
      }
    },
  };
}

/** Sets `flightRecorder.<key>` globally for the test run. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("flightRecorder")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * Brings the workspace repository back to its initial commit: stops any
 * recording, removes Flight Recorder branches, worktrees and remotes, and
 * discards working tree changes (keeping ignored hook setup files).
 */
export async function resetRepo(): Promise<void> {
  // The test VS Code may create chat sessions of its own; keep stop deterministic.
  await setSetting("exportChatsOnStop", false);
  const api = await getApi();
  if (api.isRecording()) {
    const stub = stubDialogs({});
    try {
      await vscode.commands.executeCommand("flightRecorder.stop");
    } finally {
      stub.restore();
    }
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");

  const root = repoRoot();
  git(root, "checkout", "-q", "-f", "main");
  git(root, "reset", "-q", "--hard", "e2e-base");
  git(root, "clean", "-q", "-fd");
  const worktrees = path.join(git(root, "rev-parse", "--absolute-git-dir"), "flight-recorder-worktrees");
  fs.rmSync(worktrees, { recursive: true, force: true });
  git(root, "worktree", "prune");
  for (const branch of listBranches(root).filter((name) => name !== "main")) {
    git(root, "branch", "-q", "-D", branch);
  }
  for (const remote of git(root, "remote").split("\n").filter(Boolean)) {
    git(root, "remote", "remove", remote);
  }
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, HOOK_LOG), "");
}

/** Runs "Configure Claude Hooks" for local scope, answering its dialogs. */
export async function configureClaudeHooks(): Promise<DialogCall[]> {
  const stub = stubDialogs({
    "Claude hooks": "Local only (Recommended)",
    "Flight Recorder will update": "Configure Claude Hooks",
    "configured Claude hooks": "OK",
  });
  try {
    await within(
      vscode.commands.executeCommand("flightRecorder.configureClaudeHooks"),
      10_000,
      "the Configure Claude Hooks command"
    );
  } finally {
    stub.restore();
  }
  return stub.calls;
}

/** Runs "Configure OpenCode Plugin", confirming its dialog. */
export async function configureOpenCodePlugin(): Promise<void> {
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

/** Opens `rel` in an editor, appends `text` through a real edit, and saves. */
export async function humanEdit(rel: string, text: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(path.join(repoRoot(), rel));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, document.lineAt(document.lineCount - 1).range.end, text);
  assert.ok(await vscode.workspace.applyEdit(edit), `edit of ${rel} should apply`);
  assert.ok(await document.save(), `${rel} should save`);
  return document;
}

/** Appends one Claude hook payload to the hook log, like the installed hook script does. */
export function appendHook(payload: Record<string, unknown>): void {
  const root = repoRoot();
  fs.appendFileSync(
    path.join(root, HOOK_LOG),
    `${JSON.stringify({ session_id: "e2e-session", cwd: root, ...payload })}\n`
  );
}

/**
 * Simulates Claude editing `rel` the way Claude Code does it: PreToolUse
 * hook, the file written on disk, then PostToolUse.
 */
export async function claudeEdit(rel: string, newContent: string): Promise<void> {
  const filePath = path.join(repoRoot(), rel);
  const toolInput = { file_path: filePath, old_string: "", new_string: newContent };
  appendHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: toolInput });
  await sleep(400);
  fs.writeFileSync(filePath, newContent);
  await sleep(400);
  appendHook({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: toolInput,
    tool_response: { filePath, success: true },
  });
}

/**
 * Simulates Claude changing files with its Bash tool: PreToolUse Bash, the
 * shell command's effect (`change`), then PostToolUse Bash. Hook events for
 * Bash name no files, so only the file watcher can see the change.
 */
export async function claudeBash(command: string, change: () => void): Promise<void> {
  const toolUse = { tool_name: "Bash", tool_use_id: `bash-${Date.now()}`, tool_input: { command } };
  appendHook({ hook_event_name: "PreToolUse", ...toolUse });
  await sleep(400);
  change();
  await sleep(1_500);
  appendHook({ hook_event_name: "PostToolUse", ...toolUse, tool_response: { stdout: "", stderr: "" } });
}

/** Simulates Claude reading `rel` with its Read tool. */
export async function claudeRead(rel: string): Promise<void> {
  const toolUse = { tool_name: "Read", tool_input: { file_path: path.join(repoRoot(), rel) } };
  appendHook({ hook_event_name: "PreToolUse", ...toolUse });
  await sleep(200);
  appendHook({ hook_event_name: "PostToolUse", ...toolUse, tool_response: { type: "text" } });
}

/** Lists `kind: subject` for each commit on `branch` that is not on `base`, newest first. */
export function recordedCommits(branch: string, base = "e2e-base"): string[] {
  const out = git(repoRoot(), "log", "--format=%s", `${base}..${branch}`);
  return out.split("\n").filter(Boolean).map((subject) => subject.split(" {")[0]);
}

/** Returns the content of `rel` in the commit `rev`. */
export function showFile(rev: string, rel: string): string {
  return git(repoRoot(), "show", `${rev}:${rel}`);
}

/** Starts recording and asserts the start command returns promptly. */
export async function startRecording(): Promise<void> {
  await within(
    vscode.commands.executeCommand("flightRecorder.start"),
    10_000,
    "the Start Recording command"
  );
}

/** Stops recording and asserts the stop command returns promptly. */
export async function stopRecording(): Promise<void> {
  await within(
    vscode.commands.executeCommand("flightRecorder.stop"),
    20_000,
    "the Stop Recording command"
  );
}
