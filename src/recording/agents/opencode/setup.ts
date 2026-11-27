import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { addGitExcludeEntries } from "../../../utils/git-exclude";
import { normalizePath } from "../../../utils/fs-path";
import { getWorkspaceRepoRoot } from "../../../utils/paths";
import { EXTENSION_NAME } from "../../../utils/constants";
import { getOpenCodeLogPath, getOpenCodePluginPath } from "./config";
import { buildOpenCodePluginSource } from "./plugin-source";

/** Shows a confirmation dialog summarizing what configuring the OpenCode plugin will change, returning whether the user confirmed. */
async function confirmConfiguration(
  pluginPath: string,
  logPath: string
): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `Flight Recorder will write an OpenCode plugin to ${pluginPath} that records tool calls to ${logPath}, exclude both files from git, and switch this workspace to the OpenCode integration. Requires OpenCode 2.0 or newer.`,
    { modal: true },
    "Configure OpenCode Plugin"
  );

  return choice === "Configure OpenCode Plugin";
}

/**
 * Entry point for the "Configure OpenCode Plugin" command: writes (or
 * updates) the Flight Recorder plugin into the repository's
 * `.opencode/plugins/` folder, creates its log file, excludes both from git,
 * and switches the workspace to the OpenCode integration.
 */
export async function configureOpenCodePlugin(): Promise<void> {
  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder (git repo) before configuring the OpenCode plugin."
  );
  if (!repoRoot) {
    return;
  }

  const pluginPath = getOpenCodePluginPath(repoRoot);
  const logPath = getOpenCodeLogPath(repoRoot);

  const confirmed = await confirmConfiguration(pluginPath, logPath);
  if (!confirmed) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, buildOpenCodePluginSource(normalizePath(repoRoot)), "utf8");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, "", "utf8");
    }

    await addGitExcludeEntries(repoRoot, [pluginPath, logPath]);

    // Switching the integration writes workspace settings. If that creates
    // `.vscode/settings.json`, keep it out of the participant's git status.
    const workspaceSettingsPath = path.join(repoRoot, ".vscode", "settings.json");
    const hadWorkspaceSettings = fs.existsSync(workspaceSettingsPath);
    const cfg = vscode.workspace.getConfiguration("flightRecorder");
    await cfg.update(
      "activeIntegration",
      "opencode",
      vscode.ConfigurationTarget.Workspace
    );
    if (!hadWorkspaceSettings && fs.existsSync(workspaceSettingsPath)) {
      await addGitExcludeEntries(repoRoot, [workspaceSettingsPath]);
    }

    await vscode.window.showInformationMessage(
      `${EXTENSION_NAME} configured the OpenCode plugin. OpenCode picks it up automatically; if a session is already running and nothing gets recorded, restart OpenCode.`,
      "OK"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME} could not configure the OpenCode plugin. ${message}`
    );
  }
}
