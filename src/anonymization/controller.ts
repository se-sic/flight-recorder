import * as vscode from "vscode";
import {
  anonymizeCurrentRepository,
  checkGitFilterRepoAvailable,
  GIT_FILTER_REPO_INSTALL_URL,
  GIT_FILTER_REPO_VERSION,
  installGitFilterRepo,
} from "./repository";
import { getLogChannel } from "../utils/logging";
import { getWorkspaceRepoRoot } from "../utils/paths";
import { EXTENSION_NAME } from "../utils/constants";

/** Opens the git-filter-repo installation guide in the user's default browser. */
async function openGitFilterRepoInstallInstructions(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(GIT_FILTER_REPO_INSTALL_URL));
}

/**
 * Makes sure a usable git-filter-repo executable exists in the extension's
 * private storage, installing it (with a progress notification) if needed.
 * Returns the executable path, or null if it could not be made available.
 */
async function ensureGitFilterRepoDependency(
  context: vscode.ExtensionContext
): Promise<string | null> {
  const output = getLogChannel();
  const globalStoragePath = context.globalStorageUri.fsPath;
  const availability = await checkGitFilterRepoAvailable(globalStoragePath);
  if (availability.ok) {
    return availability.executablePath;
  }

  output.warn(`${availability.msg}\n${availability.err ?? ""}`);

  const installResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing git-filter-repo for ${EXTENSION_NAME}`,
      cancellable: false,
    },
    async () => installGitFilterRepo(globalStoragePath, getLogChannel())
  );
  if (installResult.ok) {
    output.info(
      `Installed git-filter-repo==${GIT_FILTER_REPO_VERSION} in ${globalStoragePath}`
    );
    return installResult.executablePath;
  }

  output.error(`${installResult.msg}\n${installResult.err ?? ""}`);
  const followUp = await vscode.window.showErrorMessage(
    `${EXTENSION_NAME} could not install its private git-filter-repo environment. ${installResult.msg}`,
    {
      modal: true,
      detail: installResult.err,
    },
    "Open installation instructions",
    "OK"
  );
  if (followUp === "Open installation instructions") {
    await openGitFilterRepoInstallInstructions();
  }

  return null;
}

/**
 * Entry point for the "Anonymize Repository" command: validates workspace
 * trust and git-filter-repo availability, then creates an anonymized mirror
 * of the current repository and reports the outcome to the user.
 */
export async function runAnonymization(
  context: vscode.ExtensionContext
): Promise<void> {
  const output = getLogChannel();
  if (!vscode.workspace.isTrusted) {
    output.error("Repository anonymization is disabled in untrusted workspaces.");
    vscode.window.showWarningMessage(
      "Trust this workspace before running repository anonymization."
    );
    return;
  }

  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder/workspace before anonymizing the repository."
  );
  if (!repoRoot) {
    return;
  }
  const gitFilterRepoExecutablePath = await ensureGitFilterRepoDependency(
    context
  );
  if (!gitFilterRepoExecutablePath) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  const absolutePathHandling = cfg.get<"none" | "repoOnly" | "all">(
    "absolutePathHandling",
    "repoOnly"
  );

  const result = await anonymizeCurrentRepository(repoRoot, output, {
    absolutePathHandling,
    gitFilterRepoExecutablePath,
  });
  if (!result.ok) {
    output.error(`${result.msg}\n${result.err ?? ""}`);
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME} could not anonymize the repository. ${result.msg}`
    );
    return;
  }

  output.info(`Created anonymized mirror at ${result.destRepoPath}`);
  output.info(
    `Rewrote ${result.anonymizedIdentityCount} unique author/committer identities.`
  );
  vscode.window.showInformationMessage(
    `Created anonymized repository at ${result.destRepoPath}`
  );
}
