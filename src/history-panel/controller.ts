import * as vscode from "vscode";
import {
  getRecordingBranchState,
  listUnfinishedRecordings,
  onRecordingHistoryChanged,
  recoverUnfinishedRecordings,
} from "../recording/session";
import { getLogChannel } from "../utils/logging";
import { EXTENSION_NAME } from "../utils/constants";
import {
  pushRecordingBranch,
  readRecordingHistory,
  resolvePushRemote,
} from "./history";
import { buildHtml } from "./view";

const VIEW_ID = "flightRecorder.historyView";

let historyProvider: RecordingHistoryViewProvider | null = null;
let pushInProgress = false;

class RecordingHistoryViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private message: string | null = null;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === "refresh") {
        void this.refresh();
      }
      if (message.type === "push") {
        void vscode.commands.executeCommand("flightRecorder.pushTrackingBranch");
      }
      if (message.type === "recover") {
        void vscode.commands.executeCommand("flightRecorder.recoverRecordings");
      }
    });
    void this.refresh();
  }

  async refresh(message: string | null = null): Promise<void> {
    this.message = message;
    if (!this.view) {
      return;
    }

    const state = getRecordingBranchState();
    const branchName = state?.displayBranchName ?? null;
    const history = state && branchName
      ? await readRecordingHistory(state.repoRoot, branchName, state.sourceBranchName)
      : null;
    const unfinished = await listUnfinishedRecordings();
    this.view.webview.html = buildHtml(
      state,
      history,
      this.message,
      unfinished.length,
      this.view.webview.cspSource,
      pushInProgress
    );
  }
}

export function initializeRecordingHistoryPanel(
  context: vscode.ExtensionContext
): void {
  historyProvider = new RecordingHistoryViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, historyProvider),
    onRecordingHistoryChanged(() => {
      void historyProvider?.refresh();
    }),
    vscode.commands.registerCommand("flightRecorder.refreshHistory", async () => {
      await historyProvider?.refresh();
    }),
    vscode.commands.registerCommand("flightRecorder.recoverRecordings", async () => {
      await recoverUnfinishedRecordings();
    }),
    vscode.commands.registerCommand("flightRecorder.copyTrackingBranch", async () => {
      const state = getRecordingBranchState();
      const branch = state?.displayBranchName ?? state?.finalBranchName;
      if (!branch) {
        void vscode.window.showInformationMessage("No Flight Recorder branch is available yet.");
        return;
      }
      await vscode.env.clipboard.writeText(branch);
      void vscode.window.showInformationMessage(`Copied ${branch}.`);
    }),
    vscode.commands.registerCommand("flightRecorder.pushTrackingBranch", async () => {
      const state = getRecordingBranchState();
      if (!state || state.commitMode !== "trackingWorktree" || !state.finalBranchName) {
        void vscode.window.showInformationMessage("No finalized Flight Recorder branch is available to push.");
        return;
      }
      if (state.isRecording || !state.finalized) {
        void vscode.window.showInformationMessage(
          "Push is available after recording stops and the recording branch is finalized."
        );
        return;
      }

      if (pushInProgress) {
        void vscode.window.showInformationMessage(
          `${EXTENSION_NAME} is already pushing the recording branch.`
        );
        return;
      }

      const branchName = state.finalBranchName;
      const resolved = await resolvePushRemote(state.repoRoot, branchName);
      let remote: string | undefined;
      if ("remote" in resolved) {
        remote = resolved.remote;
      } else if (resolved.choices.length === 0) {
        void vscode.window.showErrorMessage(
          `${EXTENSION_NAME}: this repository has no Git remote to push ${branchName} to.`
        );
        return;
      } else {
        remote = await vscode.window.showQuickPick(resolved.choices, {
          title: `Push ${branchName} to which remote?`,
          placeHolder: "The recording branch has no upstream yet",
        });
        if (!remote) {
          return;
        }
      }
      const pushRemote = remote;

      pushInProgress = true;
      await historyProvider?.refresh(`Pushing ${branchName} to ${pushRemote}...`);
      let result;
      try {
        result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Pushing ${branchName} to ${pushRemote}`,
            cancellable: false,
          },
          async () => pushRecordingBranch(state.repoRoot, branchName, pushRemote)
        );
      } finally {
        pushInProgress = false;
      }

      const output = getLogChannel();
      if (result.ok) {
        output.info(result.msg);
        void vscode.window.showInformationMessage(result.msg);
        await historyProvider?.refresh(result.msg);
        return;
      }

      output.error(result.msg);
      if (result.err) {
        output.error(result.err);
      }
      void vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${result.msg}`);
      await historyProvider?.refresh(result.msg);
    })
  );
}
