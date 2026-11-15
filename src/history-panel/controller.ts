import * as vscode from "vscode";
import {
  getPanelBranchState,
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
  /** The branch the panel currently shows, opened by "Show edit history in editor". */
  private shownBranch: string | null = null;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === "recover") {
        void vscode.commands.executeCommand("flightRecorder.recoverRecordings");
      }
      if (message.type === "visualize" && this.shownBranch) {
        void vscode.commands.executeCommand("flightRecorder.editHistoryVisualization", this.shownBranch);
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
      }
    });
    void this.refresh();
  }

  async refresh(message: string | null = null): Promise<void> {
    this.message = message;
    if (!this.view) {
      return;
    }

    const state = await getPanelBranchState();
    const branchName = state?.displayBranchName ?? null;
    const history = state && branchName
      ? await readRecordingHistory(state.repoRoot, branchName, state.sourceBranchName, state.finalBranchName)
      : null;
    // The checked-out branch has never been recorded: show the start hint instead.
    const hasNoRecording = !!state && !state.isRecording && state.commitMode === "trackingWorktree" && history === null;
    this.shownBranch = history ? branchName : null;
    const unfinished = await listUnfinishedRecordings();
    this.view.webview.html = buildHtml(
      hasNoRecording ? null : state,
      history,
      this.message,
      unfinished.length,
      this.view.webview.cspSource
    );
  }
}

/** Calls `onChange` when the checked-out branch changes, by watching the repository's `.git/HEAD`. */
function watchCheckedOutBranch(onChange: () => void): vscode.Disposable {
  const repoFolder = vscode.workspace.workspaceFolders?.[0];
  if (!repoFolder) {
    return new vscode.Disposable(() => undefined);
  }
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(repoFolder, ".git/HEAD")
  );
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  return watcher;
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
    watchCheckedOutBranch(() => {
      void historyProvider?.refresh();
    }),
    vscode.commands.registerCommand("flightRecorder.refreshHistory", async () => {
      await historyProvider?.refresh();
    }),
    vscode.commands.registerCommand("flightRecorder.recoverRecordings", async () => {
      await recoverUnfinishedRecordings();
    }),
    vscode.commands.registerCommand("flightRecorder.copyTrackingBranch", async () => {
      const state = await getPanelBranchState();
      const branch = state?.displayBranchName ?? state?.finalBranchName;
      if (!branch) {
        void vscode.window.showInformationMessage("No Flight Recorder branch is available yet.");
        return;
      }
      await vscode.env.clipboard.writeText(branch);
      void vscode.window.showInformationMessage(`Copied ${branch}.`);
    }),
    vscode.commands.registerCommand("flightRecorder.pushTrackingBranch", async () => {
      const state = await getPanelBranchState();
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
