import * as fs from "fs";
import * as vscode from "vscode";
import { exportCurrentWorkspaceChats } from "./chat-export";
import {
  commitChatExportSnapshot,
  commitTrackedWindow,
  commitAssistantLogSnapshot,
  GitActionResult,
  GitFailureKind,
  finalizePendingTrackingSession,
  discardRecordingCommitTarget,
  finalizeRecordingCommitTarget,
  listPendingTrackingSessions,
  PendingTrackingSession,
  prepareRecordingCommitTarget,
  RecordingFinalizationResult,
  RecordingCommitMode,
  RecordingCommitTarget,
  readSourceBranchName,
  recordingBranchName,
  validateGitRecordingReadiness,
} from "./commits";
import { Tailer } from "../utils/tailer";
import {
  AssistantIntegration,
  AssistantEventParser,
  AssistantIntegrationSetupAction,
  ASK_ON_STARTUP_INTEGRATION_ID,
  getActiveAssistantIntegration,
  getAvailableAssistantIntegrationIds,
  getConfiguredIntegrationId,
  pickAssistantIntegration,
} from "./integration";
import { AssistantEvent } from "./event";
import {
  FineGrainedStagingTracker,
  hashInsertedText,
  WindowCommit,
  WorkspaceTextChange,
} from "./staging-tracker";
import { getClaudeSourceMode } from "./agents/claude/config";
import { getLogChannel } from "../utils/logging";
import { getWorkspaceRepoRoot, workspaceRootPath } from "../utils/paths";
import { normalizePath, relativePathInside, samePath, uriToPath } from "../utils/fs-path";
import { EXTENSION_NAME } from "../utils/constants";

type RecordingSession = {
  repoRoot: string;
  assistantId: string;
  assistantDisplayName: string;
  logFile: string | null;
  logSnapshotPrefix: string;
  tailer: Tailer | null;
  parser: AssistantEventParser;
  awaitLogFile: (() => Promise<string | null>) | null;
  sourceWaitingMessageShown: boolean;
  interval: ReturnType<typeof setInterval>;
  tracker: FineGrainedStagingTracker;
  subscriptions: vscode.Disposable[];
  addAll: boolean;
  allowEmpty: boolean;
  dryRun: boolean;
  commitTarget: RecordingCommitTarget;
  shownFailureKinds: Set<GitFailureKind>;
  /** When recording started; chat export on stop only includes sessions used since then. */
  startedAt: Date;
};

export type RecordingBranchUiState = {
  repoRoot: string;
  isRecording: boolean;
  commitMode: RecordingCommitTarget["mode"];
  assistantDisplayName?: string;
  sourceBranchName?: string;
  activeBranchName?: string;
  finalBranchName?: string;
  displayBranchName?: string;
  commitRoot?: string;
  finalized: boolean;
};

let running: RecordingSession | null = null;
let stopping = false;
/** Set while VS Code shuts the extension down; the window may no longer answer calls then. */
let shuttingDown = false;
/** How long to wait for a call that needs the VS Code window before going on without it. */
const WINDOW_CALL_TIMEOUT_MS = 1_500;
let recordingStatusBarItem: vscode.StatusBarItem | null = null;
let extensionContextRef: vscode.ExtensionContext | null = null;
let claudeNewSessionHintShown = false;
let recovering = false;
let starting = false;
let startingActiveBranch: string | null = null;
let lastRecordingBranchState: RecordingBranchUiState | null = null;
export const LAST_RECORDING_BRANCH_STATE_KEY = "flightRecorder.lastRecordingBranchState";
const recordingHistoryChangedEmitter = new vscode.EventEmitter<void>();

export const onRecordingHistoryChanged = recordingHistoryChangedEmitter.event;

function fireRecordingHistoryChanged(): void {
  recordingHistoryChangedEmitter.fire();
}

/**
 * Remembers the branch the history panel should show and persists it in
 * workspace state, so the panel and push still work after a window reload.
 * The persisted copy is never marked as recording, since a reload ends it.
 */
function setLastRecordingBranchState(state: RecordingBranchUiState | null): void {
  lastRecordingBranchState = state;
  void extensionContextRef?.workspaceState.update(
    LAST_RECORDING_BRANCH_STATE_KEY,
    state ? { ...state, isRecording: false } : undefined
  );
}

/** Restores the last recording branch state for this workspace on activation. */
export function restoreRecordingBranchState(
  context: vscode.ExtensionContext
): void {
  extensionContextRef = context;
  const stored = context.workspaceState.get<RecordingBranchUiState>(
    LAST_RECORDING_BRANCH_STATE_KEY
  );
  const workspaceRoot = workspaceRootPath();
  if (stored && (!workspaceRoot || samePath(stored.repoRoot, workspaceRoot))) {
    lastRecordingBranchState = { ...stored, isRecording: false };
  }
}

/** Builds the history-panel state for a session; `publishedBranchName` overrides the final branch after finalization. */
function stateFromSession(
  session: RecordingSession,
  finalized: boolean,
  publishedBranchName?: string
): RecordingBranchUiState {
  if (session.commitTarget.mode === "trackingWorktree") {
    const finalBranchName =
      publishedBranchName ?? session.commitTarget.finalBranchName;
    return {
      repoRoot: session.repoRoot,
      isRecording: running === session,
      commitMode: "trackingWorktree",
      assistantDisplayName: session.assistantDisplayName,
      sourceBranchName: session.commitTarget.sourceBranchName,
      activeBranchName: session.commitTarget.activeBranchName,
      finalBranchName,
      displayBranchName: finalized
        ? finalBranchName
        : session.commitTarget.activeBranchName,
      commitRoot: session.commitTarget.commitRoot,
      finalized,
    };
  }

  return {
    repoRoot: session.repoRoot,
    isRecording: running === session,
    commitMode: "currentBranch",
    assistantDisplayName: session.assistantDisplayName,
    displayBranchName: undefined,
    commitRoot: session.commitTarget.commitRoot,
    finalized,
  };
}

/** Returns the branch state the history panel should display: the running session, or the last finished one. */
export function getRecordingBranchState(): RecordingBranchUiState | null {
  if (running) {
    return stateFromSession(running, false);
  }
  return lastRecordingBranchState;
}

/**
 * Returns the branch state the history panel shows: the running session, or
 * otherwise the recording branch of the checked-out branch, so the panel
 * follows branch switches. The last recording's details are kept when it
 * was made on the checked-out branch.
 */
export async function getPanelBranchState(): Promise<RecordingBranchUiState | null> {
  const last = getRecordingBranchState();
  const repoRoot = workspaceRootPath();
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  if (running || !repoRoot || cfg.get<RecordingCommitMode>("commitMode", "trackingWorktree") !== "trackingWorktree") {
    return last;
  }

  const sourceBranchName = await readSourceBranchName(repoRoot);
  if (last?.commitMode === "trackingWorktree" && last.sourceBranchName === sourceBranchName) {
    return last;
  }
  const finalBranchName = recordingBranchName(
    sourceBranchName,
    cfg.get<string>("trackingBranchPrefix", "flight-recorder")
  );
  return {
    repoRoot,
    isRecording: false,
    commitMode: "trackingWorktree",
    sourceBranchName,
    finalBranchName,
    displayBranchName: finalBranchName,
    finalized: true,
  };
}

/** Resolves a `file:` scheme URI to a normalized absolute path, or null for non-file URIs. */
function normalizeFileUri(uri: vscode.Uri): string | null {
  if (uri.scheme !== "file") {
    return null;
  }

  return uriToPath(uri);
}

/** Filters out the session's own assistant log file from a set of tracked paths, so Flight Recorder never commits its own log as a human/assistant edit. */
function filterInternalTrackingPaths(
  session: RecordingSession,
  paths: Iterable<string>
): string[] {
  const ignored = new Set<string>();
  if (session.logFile) {
    ignored.add(normalizePath(session.logFile));
  }

  return Array.from(new Set(Array.from(paths).map((candidate) => normalizePath(candidate))))
    .sort((left, right) => left.localeCompare(right))
    .filter((candidate) => !ignored.has(candidate));
}

/**
 * Waits for a call that needs the VS Code window, but at most `ms`. During a
 * reload or shutdown the window may never answer, and waiting for it would
 * keep the recording from being committed. Rejections count as no answer.
 */
async function settleWithin<T>(call: Thenable<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([Promise.resolve(call), timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Saves any open, dirty editor documents among the given paths, so a commit captures their current content. */
async function saveTrackedFilesIfOpen(
  pathsToSave: Iterable<string>
): Promise<void> {
  // Human commits carry editor snapshots, so skipping the save at shutdown loses nothing.
  if (shuttingDown) {
    return;
  }
  const targetPaths = Array.from(
    new Set(Array.from(pathsToSave).map((p) => normalizePath(p)))
  );

  for (const targetPath of targetPaths) {
    const doc = vscode.workspace.textDocuments.find((d) => {
      if (d.uri.scheme !== "file") {
        return false;
      }
      return uriToPath(d.uri) === targetPath;
    });

    if (!doc || !doc.isDirty) {
      continue;
    }

    const saved = await settleWithin(doc.save(), WINDOW_CALL_TIMEOUT_MS);
    if (saved) {
      getLogChannel().info(`Saved ${targetPath}`);
    } else {
      getLogChannel().info(
        `Could not save ${targetPath}; committing current on-disk content.`
      );
    }
  }
}

/** Opens and attaches a log file tailer (positioned at end-of-file) to the recording session. */
function attachLogSource(
  session: RecordingSession,
  logFile: string,
  parser: AssistantEventParser
): boolean {
  const tailer = new Tailer(logFile);
  try {
    tailer.open();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogChannel().error(`Failed to open log file: ${msg}`);
    return false;
  }

  tailer.startFromEnd();
  session.logFile = logFile;
  session.tailer = tailer;
  session.parser = parser;
  session.awaitLogFile = null;
  getLogChannel().info(
    `Attached ${session.assistantDisplayName} log source: ${logFile}`
  );
  return true;
}

/**
 * Saves any dirty files in a window commit, commits it, and reports the
 * result. Stops recording and shows an error if git turns out to be
 * unavailable. Returns whether recording was stopped.
 */
async function commitTrackedWindowAndReport(
  session: RecordingSession,
  commit: WindowCommit
): Promise<boolean> {
  const filteredFiles = filterInternalTrackingPaths(session, commit.files);
  const filteredCommit = { ...commit, files: filteredFiles };

  await saveTrackedFilesIfOpen(filteredCommit.files);

  const result = await commitTrackedWindow(
    session.repoRoot,
    filteredCommit,
    session.addAll,
    session.allowEmpty,
    session.dryRun,
    session.commitTarget
  );

  const shouldStop = reportGitActionResult(
    result,
    session.shownFailureKinds
  );

  if (result.ok && !result.skipped) {
    fireRecordingHistoryChanged();
  }

  if (shouldStop) {
    await stopRecording();
    void vscode.window.showErrorMessage(
      `${EXTENSION_NAME} stopped because Git is unavailable for this workspace.`
    );
  }

  return shouldStop;
}

/** Records one assistant event and commits any human window that the assistant boundary closes. */
async function processAssistantEvent(
  session: RecordingSession,
  event: AssistantEvent,
  at = Date.now()
): Promise<boolean> {
  const preAssistantCommits = session.tracker.recordAssistantEvent(event, at);

  for (const commit of preAssistantCommits) {
    const shouldStop = await commitTrackedWindowAndReport(session, commit);
    if (shouldStop) {
      return true;
    }
  }

  return false;
}

/**
 * Watches the repository for on-disk changes that VS Code reports no document
 * events for, such as files changed by a shell command, and feeds them into
 * the staging tracker. Paths inside `.git`, created directories (their files
 * are reported individually) and files last changed before the recording
 * started are skipped; deleted directories are kept so their removal is
 * committed.
 */
function watchDiskChanges(session: RecordingSession): vscode.Disposable[] {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(session.repoRoot, "**/*")
  );
  const track = (uri: vscode.Uri, deleted: boolean) => {
    const filePath = normalizeFileUri(uri);
    if (!filePath) {
      return;
    }
    const rel = relativePathInside(session.repoRoot, filePath);
    if (rel === null || rel.split("/").includes(".git")) {
      return;
    }
    if (!deleted) {
      try {
        const stat = fs.statSync(filePath);
        // Directories are reported file by file. Events that arrive late for
        // changes made before recording started are not part of the session
        // (ctime also covers renames, which keep mtime).
        if (
          stat.isDirectory() ||
          Math.max(stat.mtimeMs, stat.ctimeMs) < session.startedAt.getTime()
        ) {
          return;
        }
      } catch {
        return;
      }
    }
    const paths = filterInternalTrackingPaths(session, [filePath]);
    if (paths.length > 0) {
      session.tracker.recordDiskChange(paths);
    }
  };

  return [
    watcher,
    watcher.onDidCreate((uri) => track(uri, false)),
    watcher.onDidChange((uri) => track(uri, false)),
    watcher.onDidDelete((uri) => track(uri, true)),
  ];
}

/** Registers VS Code workspace listeners (document edits, file create/delete/rename) that feed human changes into the staging tracker. */
function registerWorkspaceChangeTracking(
  session: RecordingSession
): vscode.Disposable[] {
  const trackPaths = (paths: Iterable<string>) => {
    const filteredPaths = filterInternalTrackingPaths(session, paths);
    if (filteredPaths.length === 0) {
      return;
    }

    session.tracker.recordHumanChange(filteredPaths);
  };

  const trackUris = (uris: readonly vscode.Uri[]) => {
    const paths = uris
      .map((uri) => normalizeFileUri(uri))
      .filter((candidate): candidate is string => candidate !== null);
    trackPaths(paths);
  };

  return [
    vscode.workspace.onDidChangeTextDocument((event) => {
      const filePath = normalizeFileUri(event.document.uri);
      if (!filePath || event.contentChanges.length === 0) {
        return;
      }

      const filteredPaths = filterInternalTrackingPaths(session, [filePath]);
      if (filteredPaths.length === 0) {
        return;
      }

      const textChange: WorkspaceTextChange = {
        path: filePath,
        insertedTextHashes: event.contentChanges
          .filter((change) => change.text.length > 0)
          .map((change) => hashInsertedText(change.text)),
        insertedTextLength: event.contentChanges.reduce(
          (total, change) => total + change.text.length,
          0
        ),
        ranges: event.contentChanges.map((change) => ({
          startLine: change.range.start.line,
          startColumn: change.range.start.character,
          endLine: change.range.end.line,
          endColumn: change.range.end.character,
        })),
        text: event.document.getText(),
      };

      session.tracker.recordTextDocumentChange([textChange]);
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      trackUris(event.files);
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      trackUris(event.files);
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      const renamePaths = event.files.flatMap((entry) => {
        const oldPath = normalizeFileUri(entry.oldUri);
        const newPath = normalizeFileUri(entry.newUri);
        return [oldPath, newPath].filter(
          (candidate): candidate is string => candidate !== null
        );
      });
      trackPaths(renamePaths);
    }),
    ...watchDiskChanges(session),
  ];
}

/** Updates the status bar item's text, tooltip, command, and color to reflect whether recording is active. */
function updateRecordingStatusIndicator(active: boolean): void {
  if (!recordingStatusBarItem) {
    return;
  }

  if (active) {
    recordingStatusBarItem.text = `$(debug-stop) Stop ${EXTENSION_NAME}`;
    recordingStatusBarItem.tooltip =
      `${EXTENSION_NAME} is actively recording. Click to stop.`;
    recordingStatusBarItem.command = "flightRecorder.stop";
    recordingStatusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.prominentBackground"
    );
    recordingStatusBarItem.show();
    return;
  }

  recordingStatusBarItem.text = `$(record) Start ${EXTENSION_NAME}`;
  recordingStatusBarItem.tooltip =
    `${EXTENSION_NAME} is idle. Click to start recording.`;
  recordingStatusBarItem.command = "flightRecorder.start";
  recordingStatusBarItem.backgroundColor = undefined;
  recordingStatusBarItem.show();
}

/** Sets the `flightRecorder.isRecording` VS Code context key, used by menu/keybinding `when` clauses. */
async function setRecordingContext(active: boolean): Promise<void> {
  if (shuttingDown) {
    return;
  }
  await settleWithin(
    vscode.commands.executeCommand("setContext", "flightRecorder.isRecording", active),
    WINDOW_CALL_TIMEOUT_MS
  );
}

/** Maps a git failure kind to a human-readable message shown to the user. */
function gitFailureUiMessage(kind: GitFailureKind, fallback: string): string {
  switch (kind) {
    case "git_not_found":
      return `${EXTENSION_NAME} could not find Git. Install Git and make sure it is available in PATH.`;
    case "not_a_repo":
      return `${EXTENSION_NAME} requires the opened folder to be a git repository.`;
    case "no_commits":
      return `${EXTENSION_NAME} needs at least one commit in this repository. Create a first commit, then start recording.`;
    case "identity_not_configured":
      return `${EXTENSION_NAME} could not create a commit because Git user.name or user.email is not configured.`;
    case "add_failed":
      return `${EXTENSION_NAME} could not stage files for commit.`;
    case "commit_failed":
      return `${EXTENSION_NAME} could not create a git commit.`;
    case "finalize_failed":
      return `${EXTENSION_NAME} could not finalize the recording branch: ${fallback}`;
    case "push_failed":
      return `${EXTENSION_NAME} could not push the recording branch.`;
    case "unknown_git_error":
    default:
      return `${EXTENSION_NAME} encountered a git error: ${fallback}`;
  }
}

/**
 * Logs a git action's result and, for failures, shows an error message the
 * first time each failure kind occurs. Returns whether the failure is
 * severe enough (git missing, not a repo) that recording should stop.
 */
function reportGitActionResult(
  result: GitActionResult | RecordingFinalizationResult,
  shownFailureKinds?: Set<GitFailureKind>
): boolean {
  const output = getLogChannel();
  if (result.skipped) {
    for (const line of result.msg.split("\n")) {
      output.trace(line);
    }
    return false;
  }

  if (result.ok) {
    for (const line of result.msg.split("\n")) {
      output.info(line);
    }
    if ("warning" in result && result.warning) {
      for (const line of result.warning.split("\n")) {
        output.warn(line);
      }
      void vscode.window.showWarningMessage(
        `${EXTENSION_NAME}: ${result.warning}`
      );
    }
    return false;
  }

  for (const line of result.msg.split("\n")) {
    output.error(line);
  }
  output.error(`Git error details: ${result.err ?? "[no details]"}`);

  if (result.kind) {
    const shouldShowPopup =
      !shownFailureKinds || !shownFailureKinds.has(result.kind);
    if (shouldShowPopup) {
      shownFailureKinds?.add(result.kind);
      void vscode.window.showErrorMessage(
        gitFailureUiMessage(result.kind, result.msg)
      );
    }

    return result.kind === "git_not_found" || result.kind === "not_a_repo";
  }

  void vscode.window.showErrorMessage(
    `${EXTENSION_NAME} encountered an error: ${result.msg}`
  );
  return false;
}

/** Registers the extension's status bar item and initializes it to the idle state. */
export function initializeRecordingStatusBar(
  item: vscode.StatusBarItem
): void {
  recordingStatusBarItem = item;
  updateRecordingStatusIndicator(false);
}

/** Initializes the `flightRecorder.isRecording` context key to false on activation. */
export async function initializeRecordingContext(): Promise<void> {
  await setRecordingContext(false);
}

/** Returns whether a recording session is currently active. */
export function isRecording(): boolean {
  return running !== null;
}

/** Resolves the configured assistant integration, showing an error and returning null if the configured ID is unknown. */
function getConfiguredIntegrationOrShowError() {
  const integration = getActiveAssistantIntegration();
  if (integration) {
    return integration;
  }

  const availableIds = getAvailableAssistantIntegrationIds();
  const configuredId = getConfiguredIntegrationId();
  void vscode.window.showErrorMessage(
    `${EXTENSION_NAME} does not know the configured assistant integration "${configuredId}". Available integrations: ${availableIds.join(", ")}.`
  );
  return null;
}

/**
 * Resolves which assistant integration to use for an upcoming recording
 * session: prompts the user to pick one if `activeIntegration` is set to
 * the ask-on-startup sentinel, otherwise uses the fixed configured
 * integration.
 */
async function resolveIntegrationForStart(): Promise<AssistantIntegration | null> {
  const configuredId = getConfiguredIntegrationId();
  if (configuredId === ASK_ON_STARTUP_INTEGRATION_ID) {
    return (await pickAssistantIntegration(configuredId)) ?? null;
  }

  return getConfiguredIntegrationOrShowError();
}

/** Prompts the user to run an integration's suggested setup action (e.g. configuring Claude hooks), if one was provided. */
async function maybeRunIntegrationSetupAction(
  action: AssistantIntegrationSetupAction | undefined
): Promise<void> {
  if (!action) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    action.message,
    action.title
  );
  if (choice === action.title) {
    await vscode.commands.executeCommand(action.command);
  }
}

/** Shows a one-time reminder to start a fresh Claude session when hook-log recording begins, since already-open chats keep stale hook state. */
async function maybeShowClaudeNewSessionHint(
  assistantId: string
): Promise<void> {
  if (assistantId !== "claude-code" || claudeNewSessionHintShown) {
    return;
  }

  if (getClaudeSourceMode() !== "hookLog") {
    return;
  }

  claudeNewSessionHintShown = true;
  void vscode.window.showInformationMessage(
    "Claude hook recording is active. If Claude chat was already open before hook setup, start a new Claude chat/session in this repository so the current session picks up the hook state."
  );
}

/**
 * Entry point for the "Start Recording" command: resolves the assistant
 * integration and repo root, validates git readiness, prepares the
 * integration's log source, and starts the polling loop that tails the log,
 * feeds parsed events into the staging tracker, and commits window results.
 */
export async function startRecording(
  context: vscode.ExtensionContext
): Promise<boolean> {
  if (running || recovering || starting) {
    return false;
  }

  starting = true;
  try {
    return await startRecordingUnguarded(context);
  } finally {
    starting = false;
    startingActiveBranch = null;
  }
}

/** Performs the actual start; callers must hold the `starting` guard. */
async function startRecordingUnguarded(
  context: vscode.ExtensionContext
): Promise<boolean> {
  extensionContextRef = context;
  const output = getLogChannel();
  const integration = await resolveIntegrationForStart();
  if (!integration) {
    return false;
  }

  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder (git repo) before starting the recorder."
  );
  if (!repoRoot) {
    return false;
  }

  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  const debounceMs = cfg.get<number>("debounceMs", 0);
  const addAll = cfg.get<boolean>("addAll", false);
  const allowEmpty = cfg.get<boolean>("allowEmpty", false);
  const dryRun = cfg.get<boolean>("dryRun", false);
  const commitMode = cfg.get<RecordingCommitMode>(
    "commitMode",
    "trackingWorktree"
  );
  const trackingBranchPrefix = cfg.get<string>(
    "trackingBranchPrefix",
    "flight-recorder"
  );

  const readiness = await validateGitRecordingReadiness(repoRoot, dryRun);
  if (!readiness.ok) {
    output.error(`${readiness.msg}\n${readiness.err}`);
    vscode.window.showErrorMessage(
      gitFailureUiMessage(readiness.kind, readiness.msg)
    );
    return false;
  }

  if (commitMode === "trackingWorktree" && !dryRun) {
    const pending = await listPendingTrackingSessions(
      repoRoot,
      trackingBranchPrefix
    );
    if (pending.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `${EXTENSION_NAME} found ${pending.length} earlier recording(s) that were not finalized. Recover them before starting?`,
        { modal: true },
        "Recover Now",
        "Start Anyway"
      );
      if (!choice) {
        return false;
      }
      if (choice === "Recover Now") {
        await recoverUnfinishedRecordingsUnguarded();
      }
    }
  }

  // Prepare the integration first so a failure here leaves no hidden worktree behind.
  const prepared = await integration.prepareRecording(context, repoRoot);
  if (prepared.ok === false) {
    output.error(`${prepared.msg}\n${prepared.err ?? ""}`);
    await maybeRunIntegrationSetupAction(prepared.setupAction);
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME} could not prepare ${integration.displayName} recording. ${prepared.msg}`
    );
    return false;
  }

  const commitTargetResult = await prepareRecordingCommitTarget(
    repoRoot,
    dryRun,
    {
      mode: commitMode,
      trackingBranchPrefix,
    }
  );
  if (!commitTargetResult.ok) {
    output.error(`${commitTargetResult.msg}\n${commitTargetResult.err}`);
    vscode.window.showErrorMessage(
      gitFailureUiMessage(commitTargetResult.kind, commitTargetResult.msg)
    );
    return false;
  }
  const commitTarget = commitTargetResult.target;
  if (commitTarget.mode === "trackingWorktree") {
    startingActiveBranch = commitTarget.activeBranchName;
    output.info(
      `Using Flight Recorder active branch ${commitTarget.activeBranchName} at ${commitTarget.commitRoot}`
    );
    output.info(
      `Recording will finalize to ${commitTarget.finalBranchName} when stopped.`
    );
  }

  output.info(`Repo: ${repoRoot}`);
  getLogChannel().show(true);
  if (prepared.ok === true) {
    output.info(`Using ${prepared.displayName} log: ${prepared.logFile}`);
    await maybeShowClaudeNewSessionHint(prepared.assistantId);
  } else {
    output.info(prepared.waitMessage);
    await maybeRunIntegrationSetupAction(prepared.setupAction);
    await maybeShowClaudeNewSessionHint(prepared.assistantId);
  }

  let session: RecordingSession | null = null;
  const interval = setInterval(async () => {
    if (!session) {
      return;
    }

    if (!session.tailer) {
      if (!session.awaitLogFile) {
        return;
      }

      const awaitedLogFile = await session.awaitLogFile();
      if (!awaitedLogFile) {
        if (!session.sourceWaitingMessageShown) {
          output.info(
            `${session.assistantDisplayName} source is not available yet; waiting for the first assistant session in this repo.`
          );
          session.sourceWaitingMessageShown = true;
        }
        return;
      }

      const attached = attachLogSource(session, awaitedLogFile, session.parser);
      if (!attached) {
        return;
      }
    }

    const tailer = session.tailer;
    if (!tailer) {
      return;
    }

    const chunk = tailer.readNew();
    if (!chunk) {
      const idleCommit = session.tracker.flushAssistantWindowIfIdle(Date.now());
      if (idleCommit) {
        const shouldStop = await commitTrackedWindowAndReport(
          session,
          idleCommit
        );
        if (shouldStop) {
          return;
        }
      }
      return;
    }

    for (const ev of session.parser.feed(chunk)) {
      const shouldStop = await processAssistantEvent(session, ev);
      if (shouldStop) {
        return;
      }
    }
  }, 300);

  session = {
    repoRoot,
    assistantId: prepared.assistantId,
    assistantDisplayName: prepared.displayName,
    logFile: prepared.ok === true ? prepared.logFile : null,
    logSnapshotPrefix: prepared.logSnapshotPrefix,
    tailer: null,
    parser: prepared.parser,
    awaitLogFile: prepared.ok === "pending" ? prepared.awaitLogFile : null,
    sourceWaitingMessageShown: prepared.ok !== "pending",
    interval,
    tracker: new FineGrainedStagingTracker(debounceMs),
    subscriptions: [],
    addAll,
    allowEmpty,
    dryRun,
    commitTarget,
    shownFailureKinds: new Set<GitFailureKind>(),
    startedAt: new Date(),
  };
  if (prepared.ok === true && session) {
    const attached = attachLogSource(session, prepared.logFile, prepared.parser);
    if (!attached) {
      clearInterval(interval);
      await discardRecordingCommitTarget(commitTarget, dryRun);
      return false;
    }
  }
  if (!session) {
    clearInterval(interval);
    return false;
  }
  session.subscriptions = registerWorkspaceChangeTracking(session);
  for (const source of prepared.runtimeEventSources ?? []) {
    const disposable = await source.start((event) => {
      if (!running || running !== session) {
        return;
      }
      void processAssistantEvent(session, event);
    });
    session.subscriptions.push(disposable);
  }
  running = session;
  setLastRecordingBranchState(stateFromSession(session, false));
  fireRecordingHistoryChanged();
  await setRecordingContext(true);
  updateRecordingStatusIndicator(true);

  return true;
}

/**
 * Entry point for the "Stop Recording" command: flushes any pending human
 * or assistant window commits, commits a final assistant-log snapshot, and
 * optionally exports and commits chat sessions.
 */
export async function stopRecording(): Promise<boolean> {
  if (!running || stopping) {
    return false;
  }

  const output = getLogChannel();
  stopping = true;
  const current = running;
  running = null;

  if (!current) {
    stopping = false;
    return false;
  }

  try {
    await setRecordingContext(false);

    clearInterval(current.interval);
    for (const subscription of current.subscriptions) {
      subscription.dispose();
    }
    current.tailer?.close();

    const pendingCommits = current.tracker.flushAll(Date.now());
    for (const pendingCommit of pendingCommits) {
      await commitTrackedWindowAndReport(current, pendingCommit);
    }

    const cfg = vscode.workspace.getConfiguration("flightRecorder");
    const forceAddGeneratedLogs = cfg.get<boolean>("forceAddGeneratedLogs", true);
    if (current.logFile) {
      const snapshotRes = await commitAssistantLogSnapshot(
        current.repoRoot,
        current.logFile,
        current.logSnapshotPrefix,
        current.dryRun,
        forceAddGeneratedLogs,
        current.commitTarget
      );
      reportGitActionResult(
        snapshotRes,
        current.shownFailureKinds
      );
      if (snapshotRes.ok && !snapshotRes.skipped) {
        fireRecordingHistoryChanged();
      }
    } else {
      output.info(
        `No ${current.assistantDisplayName} log source was attached during this recording; skipping assistant-log snapshot commit.`
      );
    }

    const exportChatsOnStop = cfg.get<boolean>("exportChatsOnStop", false);
    if (exportChatsOnStop && !current.dryRun) {
      if (!extensionContextRef) {
        output.error(
          "Could not access extension context to export chats during shutdown."
        );
        void vscode.window.showErrorMessage(
          `${EXTENSION_NAME} could not export chats during shutdown because the extension context was unavailable.`
        );
      } else {
        const chatExport = await exportCurrentWorkspaceChats(
          extensionContextRef,
          current.repoRoot,
          current.commitTarget.commitRoot,
          current.startedAt
        );
        if (!chatExport.ok) {
          output.error(chatExport.msg);
          void vscode.window.showErrorMessage(
            `${EXTENSION_NAME} could not export chats during shutdown. ${chatExport.msg}`
          );
        } else if (chatExport.count === 0) {
          output.info("No chat sessions were active during this recording; skipping the chat export commit.");
        } else {
          output.info(
            `Exported ${chatExport.count} session file(s) to ${chatExport.destDir}`
          );
          const chatCommitRes = await commitChatExportSnapshot(
            current.repoRoot,
            chatExport.destDir,
            current.dryRun,
            forceAddGeneratedLogs,
            current.commitTarget
          );
          reportGitActionResult(
            chatCommitRes,
            current.shownFailureKinds
          );
          if (chatCommitRes.ok && !chatCommitRes.skipped) {
            fireRecordingHistoryChanged();
          }
        }
      }
    }

    const finalizeRes = await finalizeRecordingCommitTarget(
      current.commitTarget,
      current.dryRun
    );
    reportGitActionResult(
      finalizeRes,
      current.shownFailureKinds
    );
    const finalized = finalizeRes.ok && !finalizeRes.skipped;
    setLastRecordingBranchState(
      stateFromSession(
        current,
        finalized,
        finalized ? finalizeRes.finalBranchName : undefined
      )
    );
    fireRecordingHistoryChanged();

    updateRecordingStatusIndicator(false);
    output.info("Stopped.");
  } finally {
    stopping = false;
  }

  return true;
}

/** Reads the configured tracking branch prefix. */
function getTrackingBranchPrefix(): string {
  return vscode.workspace
    .getConfiguration("flightRecorder")
    .get<string>("trackingBranchPrefix", "flight-recorder");
}

/**
 * Lists active tracking branches that were never finalized, excluding the
 * branch of the currently running session. Returns an empty list when no
 * workspace folder is open.
 */
export async function listUnfinishedRecordings(): Promise<PendingTrackingSession[]> {
  const repoRoot = workspaceRootPath();
  if (!repoRoot) {
    return [];
  }

  const runningActiveBranch =
    running?.commitTarget.mode === "trackingWorktree"
      ? running.commitTarget.activeBranchName
      : null;
  const pending = await listPendingTrackingSessions(
    repoRoot,
    getTrackingBranchPrefix()
  );
  return pending.filter(
    (session) =>
      session.activeBranchName !== runningActiveBranch &&
      session.activeBranchName !== startingActiveBranch
  );
}

/**
 * Finalizes one unfinished recording. When its final branch has diverged,
 * asks whether to save the recording as a separate branch instead of
 * leaving it pending.
 */
async function recoverUnfinishedRecording(
  session: PendingTrackingSession
): Promise<RecordingFinalizationResult> {
  const result = await finalizePendingTrackingSession(session, "preserve");
  if (result.ok || !result.diverged) {
    return result;
  }

  const separateBranchName = `${session.finalBranchName}-${session.sessionId}`;
  const choice = await vscode.window.showWarningMessage(
    `${session.finalBranchName} has moved since recording ${session.sessionId} started, so it cannot be fast-forwarded.`,
    {
      modal: true,
      detail:
        `Flight Recorder never force-updates recording branches. You can save this recording as ${separateBranchName} instead, ` +
        "or cancel to keep it pending.",
    },
    "Save as Separate Branch"
  );
  if (choice !== "Save as Separate Branch") {
    return result;
  }
  return finalizePendingTrackingSession(session, "separateBranch");
}

/**
 * Entry point for the "Recover Unfinished Recordings" command: finalizes
 * leftover active tracking branches (from failed finalization or a window
 * that closed while recording) and releases their hidden worktrees.
 */
export async function recoverUnfinishedRecordings(): Promise<void> {
  if (starting) {
    void vscode.window.showInformationMessage(
      `${EXTENSION_NAME} is starting a recording; try recovering again afterwards.`
    );
    return;
  }
  await recoverUnfinishedRecordingsUnguarded();
}

/** Recovers unfinished recordings; also used by start's "Recover Now" while `starting` is set. */
async function recoverUnfinishedRecordingsUnguarded(): Promise<void> {
  if (running || stopping || recovering) {
    void vscode.window.showInformationMessage(
      `Stop the current ${EXTENSION_NAME} recording before recovering unfinished recordings.`
    );
    return;
  }

  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder (git repo) before recovering recordings."
  );
  if (!repoRoot) {
    return;
  }

  recovering = true;
  try {
    const pending = await listUnfinishedRecordings();
    if (pending.length === 0) {
      void vscode.window.showInformationMessage(
        `${EXTENSION_NAME} found no unfinished recordings.`
      );
      return;
    }

    let recovered = 0;
    for (const session of pending) {
      const result = await recoverUnfinishedRecording(session);
      reportGitActionResult(result);
      if (result.ok && !result.skipped) {
        recovered += 1;
        setLastRecordingBranchState({
          repoRoot,
          isRecording: false,
          commitMode: "trackingWorktree",
          activeBranchName: session.activeBranchName,
          finalBranchName: result.finalBranchName,
          displayBranchName: result.finalBranchName,
          finalized: true,
        });
      }
    }

    fireRecordingHistoryChanged();
    const remaining = pending.length - recovered;
    const summary =
      `${EXTENSION_NAME} recovered ${recovered} of ${pending.length} unfinished recording(s).` +
      (remaining > 0 ? " See the Flight Recorder output for the remaining ones." : "");
    if (remaining > 0) {
      void vscode.window.showWarningMessage(summary);
    } else {
      void vscode.window.showInformationMessage(summary);
    }
  } finally {
    recovering = false;
  }
}

/** Entry point for the "Print Assistant Log Path" command: shows the configured integration's primary log file path. */
export async function showAssistantLogPath(
  context: vscode.ExtensionContext
): Promise<void> {
  const integration = getConfiguredIntegrationOrShowError();
  if (!integration) {
    return;
  }

  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder (git repo) before inspecting assistant logs."
  );
  if (!repoRoot) {
    return;
  }

  const logFile = await integration.showPrimaryLogPath(context, repoRoot);
  if (!logFile) {
    vscode.window.showErrorMessage(
      `Could not find the primary log file for ${integration.displayName}.`
    );
    return;
  }
  vscode.window.showInformationMessage(
    `${integration.displayName} log file: ${logFile}`
  );
}

export async function exportAllChats(
  context: vscode.ExtensionContext
): Promise<void> {
  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder/workspace before exporting chats."
  );
  if (!repoRoot) {
    return;
  }
  getLogChannel().info(`Repo: ${repoRoot}`);
  const chatExport = await exportCurrentWorkspaceChats(context, repoRoot);
  if (!chatExport.ok) {
    vscode.window.showWarningMessage(chatExport.msg);
    return;
  }

  vscode.window.showInformationMessage(
    `Exported ${chatExport.count} session file(s) for current workspace to ${chatExport.destDir}`
  );
}

/** Stops a running recording when the extension is deactivated (window reload or close). */
export async function deactivateRecording(): Promise<void> {
  // VS Code gives deactivation only a few seconds, and the window is already
  // going away: stop without waiting for it, so the commits still land.
  shuttingDown = true;
  if (running) {
    await stopRecording();
  }
  updateRecordingStatusIndicator(false);
}
