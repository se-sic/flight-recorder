import * as path from "path";
import * as vscode from "vscode";
import { exportCurrentWorkspaceChats } from "./chat-export";
import {
  commitChatExportSnapshot,
  commitTrackedWindow,
  commitAssistantLogSnapshot,
  GitActionResult,
  GitFailureKind,
  validateGitRecordingReadiness,
} from "./commits";
import { Tailer } from "./parser";
import { AssistantEventParser } from "./integration";
import {
  getActiveAssistantIntegration,
  getAvailableAssistantIntegrationIds,
} from "./integrations";
import {
  FineGrainedStagingTracker,
  WindowCommit,
} from "./staging-tracker";
import { getLogChannel } from "../utils/logging";
import { getWorkspaceRepoRoot } from "../utils/paths";
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
  shownFailureKinds: Set<GitFailureKind>;
};

let running: RecordingSession | null = null;
let stopping = false;
let recordingStatusBarItem: vscode.StatusBarItem | null = null;
let extensionContextRef: vscode.ExtensionContext | null = null;

function createEmptyParserProxy() {
  return {
    *feed(_chunk: string) {
      yield* [];
    },
  };
}

function normalizeFileUri(uri: vscode.Uri): string | null {
  if (uri.scheme !== "file") {
    return null;
  }

  return path.resolve(uri.fsPath);
}

function normalizePaths(paths: Iterable<string>): string[] {
  return Array.from(
    new Set(Array.from(paths).map((candidate) => path.resolve(candidate)))
  ).sort((left, right) => left.localeCompare(right));
}

async function saveTrackedFilesIfOpen(
  pathsToSave: Iterable<string>
): Promise<void> {
  const targetPaths = Array.from(
    new Set(Array.from(pathsToSave).map((p) => path.resolve(p)))
  );

  for (const targetPath of targetPaths) {
    const doc = vscode.workspace.textDocuments.find((d) => {
      if (d.uri.scheme !== "file") {
        return false;
      }
      return path.resolve(d.uri.fsPath) === targetPath;
    });

    if (!doc || !doc.isDirty) {
      continue;
    }

    const saved = await doc.save();
    if (saved) {
      getLogChannel().info(`Saved ${targetPath}`);
    } else {
      getLogChannel().info(
        `Could not save ${targetPath}; committing current on-disk content.`
      );
    }
  }
}

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

async function commitTrackedWindowAndReport(
  session: RecordingSession,
  commit: WindowCommit
): Promise<boolean> {
  await saveTrackedFilesIfOpen(commit.files);

  const result = await commitTrackedWindow(
    session.repoRoot,
    commit,
    session.addAll,
    session.allowEmpty,
    session.dryRun
  );

  const shouldStop = reportGitActionResult(
    result,
    session.shownFailureKinds
  );

  if (shouldStop) {
    await stopRecording();
    void vscode.window.showErrorMessage(
      `${EXTENSION_NAME} stopped because Git is unavailable for this workspace.`
    );
  }

  return shouldStop;
}

function registerWorkspaceChangeTracking(
  session: RecordingSession
): vscode.Disposable[] {
  const trackPaths = (paths: Iterable<string>) => {
    session.tracker.recordHumanChange(normalizePaths(paths));
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

      trackPaths([filePath]);
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
  ];
}

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

async function setRecordingContext(active: boolean): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    "flightRecorder.isRecording",
    active
  );
}

function gitFailureUiMessage(kind: GitFailureKind, fallback: string): string {
  switch (kind) {
    case "git_not_found":
      return `${EXTENSION_NAME} could not find Git. Install Git and make sure it is available in PATH.`;
    case "not_a_repo":
      return `${EXTENSION_NAME} requires the opened folder to be a git repository.`;
    case "identity_not_configured":
      return `${EXTENSION_NAME} could not create a commit because Git user.name or user.email is not configured.`;
    case "add_failed":
      return `${EXTENSION_NAME} could not stage files for commit.`;
    case "commit_failed":
      return `${EXTENSION_NAME} could not create a git commit.`;
    case "unknown_git_error":
    default:
      return `${EXTENSION_NAME} encountered a git error: ${fallback}`;
  }
}

function reportGitActionResult(
  result: GitActionResult,
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

export function initializeRecordingStatusBar(
  item: vscode.StatusBarItem
): void {
  recordingStatusBarItem = item;
  updateRecordingStatusIndicator(false);
}

export async function initializeRecordingContext(): Promise<void> {
  await setRecordingContext(false);
}

export function isRecording(): boolean {
  return running !== null;
}

function getConfiguredIntegrationOrShowError() {
  const integration = getActiveAssistantIntegration();
  if (integration) {
    return integration;
  }

  const availableIds = getAvailableAssistantIntegrationIds();
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  const configuredId = cfg.get<string>("activeIntegration", "[unset]");
  void vscode.window.showErrorMessage(
    `${EXTENSION_NAME} does not know the configured assistant integration "${configuredId}". Available integrations: ${availableIds.join(", ")}.`
  );
  return null;
}

export async function startRecording(
  context: vscode.ExtensionContext
): Promise<boolean> {
  if (running) {
    return false;
  }

  extensionContextRef = context;
  const output = getLogChannel();
  const integration = getConfiguredIntegrationOrShowError();
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

  const readiness = await validateGitRecordingReadiness(repoRoot, dryRun);
  if (!readiness.ok) {
    output.error(`${readiness.msg}\n${readiness.err}`);
    vscode.window.showErrorMessage(
      gitFailureUiMessage(readiness.kind, readiness.msg)
    );
    return false;
  }

  const prepared = await integration.prepareRecording(context, repoRoot);
  if (prepared.ok === false) {
    output.error(`${prepared.msg}\n${prepared.err ?? ""}`);
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME} could not prepare ${integration.displayName} recording. ${prepared.msg}`
    );
    return false;
  }

  output.info(`Repo: ${repoRoot}`);
  getLogChannel().show(true);
  if (prepared.ok === true) {
    output.info(`Using ${prepared.displayName} log: ${prepared.logFile}`);
  } else {
    output.info(prepared.waitMessage);
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
      const preAssistantCommits = session.tracker.recordAssistantEvent(
        ev,
        Date.now()
      );

      for (const commit of preAssistantCommits) {
        const shouldStop = await commitTrackedWindowAndReport(
          session,
          commit
        );
        if (shouldStop) {
          return;
        }
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
    shownFailureKinds: new Set<GitFailureKind>(),
  };
  if (prepared.ok === true && session) {
    const attached = attachLogSource(session, prepared.logFile, prepared.parser);
    if (!attached) {
      clearInterval(interval);
      return false;
    }
  }
  if (!session) {
    clearInterval(interval);
    return false;
  }
  session.subscriptions = registerWorkspaceChangeTracking(session);
  running = session;
  await setRecordingContext(true);
  updateRecordingStatusIndicator(true);

  return true;
}

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
        forceAddGeneratedLogs
      );
      reportGitActionResult(
        snapshotRes,
        current.shownFailureKinds
      );
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
          current.repoRoot
        );
        if (!chatExport.ok) {
          output.error(chatExport.msg);
          void vscode.window.showErrorMessage(
            `${EXTENSION_NAME} could not export chats during shutdown. ${chatExport.msg}`
          );
        } else {
          output.info(
            `Exported ${chatExport.count} session file(s) to ${chatExport.destDir}`
          );
          const chatCommitRes = await commitChatExportSnapshot(
            current.repoRoot,
            chatExport.destDir,
            current.dryRun,
            forceAddGeneratedLogs
          );
          reportGitActionResult(
            chatCommitRes,
            current.shownFailureKinds
          );
        }
      }
    }

    updateRecordingStatusIndicator(false);
    output.info("Stopped.");
  } finally {
    stopping = false;
  }

  return true;
}

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

export async function deactivateRecording(): Promise<void> {
  if (running) {
    await stopRecording();
  }
  await setRecordingContext(false);
  updateRecordingStatusIndicator(false);
}
