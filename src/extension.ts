import * as vscode from "vscode";
import { runAnonymization } from "./anonymization/controller";
import {
  disposeEditHistoryVisualization,
  startEditHistoryVisualization,
} from "./visualization/controller";
import {
  exportAllChats,
  getRecordingBranchState,
  initializeRecordingContext,
  LAST_RECORDING_BRANCH_STATE_KEY,
  listUnfinishedRecordings,
  RecordingBranchUiState,
  initializeRecordingStatusBar,
  isRecording,
  restoreRecordingBranchState,
  showAssistantLogPath,
  startRecording,
  stopRecording,
  deactivateRecording,
} from "./recording/session";
import { initializeRecordingHistoryPanel } from "./history-panel/controller";
import { configureClaudeHooks } from "./recording/agents/claude/hooks";
import { configureOpenCodePlugin } from "./recording/agents/opencode/setup";
import { COMMAND_STATUS, EXTENSION_NAME } from "./utils/constants";
import { initializeLogChannel } from "./utils/logging";

/** Read-only state returned from `activate`, used by the end-to-end tests. */
export type FlightRecorderApi = {
  isRecording: () => boolean;
  getRecordingBranchState: () => RecordingBranchUiState | null;
  getPersistedRecordingBranchState: () => RecordingBranchUiState | undefined;
  listUnfinishedRecordings: typeof listUnfinishedRecordings;
};

/** Extension activation entry point: sets up logging, the recording status bar item, and registers all commands. */
export function activate(context: vscode.ExtensionContext): FlightRecorderApi {
  // Initialize global logging channel
  const outputChannel = initializeLogChannel(EXTENSION_NAME);
  context.subscriptions.push(outputChannel);

  const recordingStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  recordingStatusBarItem.name = EXTENSION_NAME + " recording status";
  initializeRecordingStatusBar(recordingStatusBarItem);
  void initializeRecordingContext();
  restoreRecordingBranchState(context);
  initializeRecordingHistoryPanel(context);
  context.subscriptions.push(recordingStatusBarItem);

  const startCmd = vscode.commands.registerCommand(
    "flightRecorder.start",
    async () => {
      if (isRecording()) {
        vscode.window.showWarningMessage(COMMAND_STATUS.alreadyRunning);
        return;
      }

      const started = await startRecording(context);
      if (started) {
        vscode.window.showInformationMessage(COMMAND_STATUS.started);
      }
    }
  );

  const stopCmd = vscode.commands.registerCommand(
    "flightRecorder.stop",
    async () => {
      if (!isRecording()) {
        vscode.window.showInformationMessage(COMMAND_STATUS.notRunning);
        return;
      }

      const stopped = await stopRecording();
      if (stopped) {
        vscode.window.showInformationMessage(COMMAND_STATUS.stopped);
      }
    }
  );

  const printCmd = vscode.commands.registerCommand(
    "flightRecorder.printLog",
    async () => {
      await showAssistantLogPath(context);
    }
  );

  const exportChatsCmd = vscode.commands.registerCommand(
    "flightRecorder.exportAllChats",
    async () => {
      await exportAllChats(context);
    }
  );

  const configureClaudeHooksCmd = vscode.commands.registerCommand(
    "flightRecorder.configureClaudeHooks",
    async () => {
      await configureClaudeHooks();
    }
  );

  const configureOpenCodePluginCmd = vscode.commands.registerCommand(
    "flightRecorder.configureOpenCodePlugin",
    async () => {
      await configureOpenCodePlugin();
    }
  );

  const anonymizeRepoCmd = vscode.commands.registerCommand(
    "flightRecorder.anonymizeRepo",
    async () => {
      await runAnonymization(context);
    }
  );

  const editHistoryVisualizationCmd = vscode.commands.registerCommand(
    "flightRecorder.editHistoryVisualization",
    async (revision?: unknown) => {
      // The history panel passes the recording branch; the command palette passes nothing.
      await startEditHistoryVisualization(
        context,
        typeof revision === "string" ? revision : undefined
      );
    }
  );

  context.subscriptions.push(
    startCmd,
    stopCmd,
    printCmd,
    exportChatsCmd,
    configureClaudeHooksCmd,
    configureOpenCodePluginCmd,
    anonymizeRepoCmd,
    editHistoryVisualizationCmd
  );

  return {
    isRecording,
    getRecordingBranchState,
    getPersistedRecordingBranchState: () =>
      context.workspaceState.get<RecordingBranchUiState>(LAST_RECORDING_BRANCH_STATE_KEY),
    listUnfinishedRecordings,
  };
}

/** Extension deactivation entry point: tears down the edit history visualization and stops any active recording. */
export async function deactivate() {
  disposeEditHistoryVisualization();
  await deactivateRecording();
}
