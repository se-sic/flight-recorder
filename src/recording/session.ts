import * as path from "path";
import * as vscode from "vscode";
import { exportCurrentWorkspaceChats } from "./chat-export";
import {
  commitChatExportSnapshot,
  commitCopilotLogSnapshot,
  commitForEvent,
  commitForEvents,
  GitActionResult,
  GitFailureKind,
  validateGitRecordingReadiness,
} from "./commits";
import { CopilotLogParser, Tailer } from "./parser";
import { CompletionEvent } from "./event";
import { getLogChannel } from "../utils/logging";
import {
  getCopilotLogFile,
  getWindowLogDirFromContext,
  getWorkspaceRepoRoot,
} from "../utils/paths";
import { EXTENSION_NAME } from "../utils/constants";

type RecordingSession = {
  repoRoot: string;
  logFile: string;
  tailer: Tailer;
  interval: ReturnType<typeof setInterval>;
  pending: CompletionEvent[];
  pendingAt: number;
  debounceMs: number;
  addAll: boolean;
  allowEmpty: boolean;
  dryRun: boolean;
  shownFailureKinds: Set<GitFailureKind>;
};

type LogSetupResult =
  | { ok: true }
  | { ok: false; msg: string; err?: string };

let running: RecordingSession | null = null;
let stopping = false;
let recordingStatusBarItem: vscode.StatusBarItem | null = null;
let extensionContextRef: vscode.ExtensionContext | null = null;

function eventFilePaths(ev: CompletionEvent): string[] {
  return ev.files;
}

function eventPrimaryFilePath(ev: CompletionEvent): string {
  return ev.files[0] ?? "[unknown-file]";
}

async function saveEventFilesIfOpen(
  ev: CompletionEvent
): Promise<void> {
  const targetPaths = Array.from(
    new Set(eventFilePaths(ev).map((p) => path.resolve(p)))
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

async function enableCopilotDebugLogging(): Promise<LogSetupResult> {
  const output = getLogChannel();
  try {
    await vscode.commands.executeCommand(
      "workbench.action.setDefaultLogLevel",
      vscode.LogLevel.Debug,
      "github.copilot-chat"
    );
    output.debug("Set default log level to debug for github.copilot-chat.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.debug(
      `Could not set default log level for github.copilot-chat: ${msg}`
    );
    return {
      ok: false,
      msg: "Could not set the default log level to debug for GitHub Copilot Chat.",
      err: msg,
    };
  }

  try {
    const commands = await vscode.commands.getCommands(true);

    const debugLevelCommand =
      commands.find((c) => c === "workbench.action.output.activeOutputLogLevel.2") ??
      commands.find(
        (c) => c === "workbench.action.output.activeOutputLogLevel.debug"
      ) ??
      null;

    if (!debugLevelCommand) {
      output.debug(
        "Could not find output log-level debug command in this VS Code build."
      );
      return {
        ok: false,
        msg: "Could not find the VS Code command for setting the active output log level to debug.",
      };
    }

    const copilotChatShowOutputCommand =
      commands.find(
        (c) =>
          /workbench\.action\.output\.show\..*copilot-chat.*copilot chat.*\.log$/i.test(
            c
          )
      ) ??
      commands.find((c) =>
        /workbench\.action\.output\.show\..*copilot-chat.*\.log$/i.test(c)
      ) ??
      null;

    if (!copilotChatShowOutputCommand) {
      output.debug(
        "Could not find GitHub Copilot Chat log output channel command."
      );
      return {
        ok: false,
        msg: "Could not find the VS Code command for showing the GitHub Copilot Chat log output channel.",
      };
    }

    try {
      await vscode.commands.executeCommand(copilotChatShowOutputCommand);
      await vscode.commands.executeCommand(debugLevelCommand);
      output.debug(
        `Set active output log level to debug via ${copilotChatShowOutputCommand}.`
      );
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.debug(
        `Could not set active output log level via ${copilotChatShowOutputCommand}: ${msg}`
      );
      return {
        ok: false,
        msg: "Could not set the active GitHub Copilot Chat output log level to debug.",
        err: msg,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.debug(`Failed to discover output commands: ${msg}`);
    return {
      ok: false,
      msg: "Failed to discover the VS Code commands required to enable Copilot debug logging.",
      err: msg,
    };
  }
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

export async function startRecording(
  context: vscode.ExtensionContext
): Promise<boolean> {
  if (running) {
    return false;
  }

  extensionContextRef = context;
  const output = getLogChannel();

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

  const windowLogDir = getWindowLogDirFromContext(context);
  if (!windowLogDir) {
    vscode.window.showErrorMessage(
      "Could not locate VS Code window log directory."
    );
    return false;
  }
  const logFile = await getCopilotLogFile(vscode.Uri.file(windowLogDir));
  if (!logFile) {
    vscode.window.showErrorMessage("Could not find Copilot log file.");
    return false;
  }

  output.info(`Using log: ${logFile}`);
  output.info(`Repo: ${repoRoot}`);

  const logSetup = await enableCopilotDebugLogging();
  if (!logSetup.ok) {
    output.error(`${logSetup.msg}\n${logSetup.err ?? ""}`);
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME} could not enable GitHub Copilot Chat debug logging. The recorder depends on debug-level Copilot log events and may not capture completions correctly.`
    );
    return false;
  }
  getLogChannel().show(true);

  const parser = new CopilotLogParser();
  const tailer = new Tailer(logFile);

  try {
    tailer.open();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.error(`Failed to open log file: ${msg}`);
    return false;
  }
  tailer.startFromEnd();

  let session: RecordingSession | null = null;
  const interval = setInterval(async () => {
    if (!session) {
      return;
    }

    const chunk = tailer.readNew();
    if (!chunk) {
      if (
        session.pending.length > 0 &&
        debounceMs > 0 &&
        Date.now() - session.pendingAt >= debounceMs
      ) {
        for (const pendingEv of session.pending) {
          await saveEventFilesIfOpen(pendingEv);
        }
        const res = await commitForEvents(
          repoRoot,
          session.pending,
          addAll,
          allowEmpty,
          dryRun
        );
        const shouldStop = reportGitActionResult(
          res,
          session.shownFailureKinds
        );
        session.pending = [];
        if (shouldStop) {
          await stopRecording();
          void vscode.window.showErrorMessage(
            `${EXTENSION_NAME} stopped because Git is unavailable for this workspace.`
          );
        }
      }
      return;
    }

    for (const ev of parser.feed(chunk)) {
      if (debounceMs > 0) {
        session.pending.push(ev);
        session.pendingAt = Date.now();
      } else {
        await saveEventFilesIfOpen(ev);
        const res = await commitForEvent(
          repoRoot,
          ev,
          addAll,
          allowEmpty,
          dryRun
        );
        const shouldStop = reportGitActionResult(
          res,
          session.shownFailureKinds
        );
        if (shouldStop) {
          await stopRecording();
          void vscode.window.showErrorMessage(
            `${EXTENSION_NAME} stopped because Git is unavailable for this workspace.`
          );
          break;
        }
      }
    }
  }, 300);

  session = {
    repoRoot,
    logFile,
    tailer,
    interval,
    pending: [],
    pendingAt: 0,
    debounceMs,
    addAll,
    allowEmpty,
    dryRun,
    shownFailureKinds: new Set<GitFailureKind>(),
  };
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
    current.tailer.close();

    if (current.pending.length > 0 && current.debounceMs > 0) {
      for (const pendingEv of current.pending) {
        await saveEventFilesIfOpen(pendingEv);
      }
      const pendingRes = await commitForEvents(
        current.repoRoot,
        current.pending,
        current.addAll,
        current.allowEmpty,
        current.dryRun
      );
      reportGitActionResult(pendingRes, current.shownFailureKinds);
    }

    const cfg = vscode.workspace.getConfiguration("flightRecorder");
    const forceAddGeneratedLogs = cfg.get<boolean>("forceAddGeneratedLogs", true);
    const snapshotRes = await commitCopilotLogSnapshot(
      current.repoRoot,
      current.logFile,
      current.dryRun,
      forceAddGeneratedLogs
    );
    reportGitActionResult(
      snapshotRes,
      current.shownFailureKinds
    );

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

export async function showCopilotLogPath(
  context: vscode.ExtensionContext
): Promise<void> {
  const windowLogDir = getWindowLogDirFromContext(context);
  if (!windowLogDir) {
    vscode.window.showErrorMessage(
      "Could not locate VS Code window log directory."
    );
    return;
  }
  const logFile = await getCopilotLogFile(vscode.Uri.file(windowLogDir));
  if (!logFile) {
    vscode.window.showErrorMessage("Could not find Copilot log file.");
    return;
  }
  vscode.window.showInformationMessage(`Copilot log file: ${logFile}`);
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
