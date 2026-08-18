import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { gitCmd } from "../utils/git";
import {
  AbsolutePathHandling,
  absolutePathReplacementExpressions,
  generatedLogSanitizationCallback,
} from "./path-sanitization";

export const GIT_FILTER_REPO_INSTALL_URL =
  "https://github.com/newren/git-filter-repo/blob/main/INSTALL.md";
export const GIT_FILTER_REPO_VERSION = "2.47.0";

type CommandResult = {
  code: number;
  out: string;
  err: string;
  spawnError?: Error;
};

type PythonCommandCandidate = {
  command: string;
  argsPrefix: string[];
  label: string;
};

export type AnonymizeRepoResult =
  | { ok: true; destRepoPath: string; anonymizedIdentityCount: number }
  | { ok: false; msg: string; err?: string };

export type GitFilterRepoAvailabilityResult =
  | { ok: true; executablePath: string }
  | { ok: false; msg: string; err?: string };

export type AnonymizeRepoOptions = {
  absolutePathHandling: AbsolutePathHandling;
  gitFilterRepoExecutablePath: string;
};

/** Runs an external command and collects its exit code, stdout, and stderr. */
function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const p = spawn(command, args, { cwd });
    let out = "";
    let err = "";
    let spawnError: Error | undefined;
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (error) => {
      spawnError = error;
    });
    p.on("close", (code) =>
      resolve({ code: code ?? 1, out, err, spawnError })
    );
  });
}

/** Returns the pinned `pip install` package spec for git-filter-repo. */
function gitFilterRepoPackageSpec(): string {
  return `git-filter-repo==${GIT_FILTER_REPO_VERSION}`;
}

/** Root directory under extension global storage where the private git-filter-repo toolchain lives. */
function gitFilterRepoToolRoot(globalStoragePath: string): string {
  return path.join(globalStoragePath, "tools", "git-filter-repo");
}

/** Path to the private Python virtual environment used for git-filter-repo. */
function gitFilterRepoVenvPath(globalStoragePath: string): string {
  return path.join(gitFilterRepoToolRoot(globalStoragePath), "venv");
}

/** Path to the Python interpreter inside the private git-filter-repo virtual environment. */
function gitFilterRepoVenvPythonPath(globalStoragePath: string): string {
  const venvPath = gitFilterRepoVenvPath(globalStoragePath);
  return process.platform === "win32"
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
}

/** Path to the git-filter-repo executable installed inside the private virtual environment. */
function gitFilterRepoExecutablePath(globalStoragePath: string): string {
  const venvPath = gitFilterRepoVenvPath(globalStoragePath);
  return process.platform === "win32"
    ? path.join(venvPath, "Scripts", "git-filter-repo.exe")
    : path.join(venvPath, "bin", "git-filter-repo");
}

/** Lists candidate Python 3 launcher commands to try, in priority order for the current platform. */
function pythonCommandCandidates(): PythonCommandCandidate[] {
  if (process.platform === "win32") {
    return [
      { command: "py", argsPrefix: ["-3"], label: "py -3" },
      { command: "python", argsPrefix: [], label: "python" },
      { command: "python3", argsPrefix: [], label: "python3" },
    ];
  }

  return [
    { command: "python3", argsPrefix: [], label: "python3" },
    { command: "python", argsPrefix: [], label: "python" },
  ];
}

/** Finds the first working Python 3 launcher command on this machine, or null if none work. */
async function findPythonCommand(
  cwd: string
): Promise<PythonCommandCandidate | null> {
  for (const candidate of pythonCommandCandidates()) {
    const res = await runCommand(
      candidate.command,
      [...candidate.argsPrefix, "--version"],
      cwd
    );
    if (res.code === 0) {
      return candidate;
    }
  }

  return null;
}

/** Extracts the `Version:` field from `pip show` output, or null if absent. */
function extractInstalledGitFilterRepoVersion(pipShowOutput: string): string | null {
  const match = /^Version:\s*(.+)$/m.exec(pipShowOutput);
  return match ? match[1].trim() : null;
}

/** Reads the installed git-filter-repo version from the private virtual environment, or null if not installed. */
async function readInstalledGitFilterRepoVersion(
  globalStoragePath: string
): Promise<string | null> {
  const venvPython = gitFilterRepoVenvPythonPath(globalStoragePath);
  if (!fs.existsSync(venvPython)) {
    return null;
  }

  const res = await runCommand(
    venvPython,
    ["-m", "pip", "show", "git-filter-repo"],
    globalStoragePath
  );
  if (res.code !== 0) {
    return null;
  }

  return extractInstalledGitFilterRepoVersion(res.out);
}

/** Checks whether the private git-filter-repo installation exists, matches the pinned version, and runs. */
async function hasUsablePrivateGitFilterRepoInstallation(
  globalStoragePath: string
): Promise<boolean> {
  const executablePath = gitFilterRepoExecutablePath(globalStoragePath);
  if (!fs.existsSync(executablePath)) {
    return false;
  }

  const installedVersion = await readInstalledGitFilterRepoVersion(
    globalStoragePath
  );
  if (installedVersion !== GIT_FILTER_REPO_VERSION) {
    return false;
  }

  const res = await runCommand(executablePath, ["--version"], globalStoragePath);
  return res.code === 0;
}

/**
 * Creates a private Python virtual environment under the extension's global
 * storage and installs the pinned git-filter-repo version into it.
 */
export async function installGitFilterRepo(
  globalStoragePath: string,
  output: vscode.OutputChannel
): Promise<GitFilterRepoAvailabilityResult> {
  await fs.promises.mkdir(gitFilterRepoToolRoot(globalStoragePath), {
    recursive: true,
  });

  const python = await findPythonCommand(globalStoragePath);
  if (!python) {
    return {
      ok: false,
      msg: "Python 3 is required to install the extension-managed git-filter-repo environment.",
      err:
        "Could not find a usable Python 3 interpreter. Tried: " +
        pythonCommandCandidates().map((candidate) => candidate.label).join(", "),
    };
  }

  output.appendLine(
    `[config] Using ${python.label} to create a private git-filter-repo environment.`
  );

  const venvPath = gitFilterRepoVenvPath(globalStoragePath);
  const venvPython = gitFilterRepoVenvPythonPath(globalStoragePath);
  const executablePath = gitFilterRepoExecutablePath(globalStoragePath);

  const createVenvRes = await runCommand(
    python.command,
    [...python.argsPrefix, "-m", "venv", venvPath],
    globalStoragePath
  );
  if (createVenvRes.code !== 0) {
    return {
      ok: false,
      msg: "Failed to create the private Python virtual environment for git-filter-repo.",
      err:
        [createVenvRes.err.trim(), createVenvRes.out.trim()]
          .filter(Boolean)
          .join("\n") || "python -m venv failed.",
    };
  }

  const installRes = await runCommand(
    venvPython,
    [
      "-m",
      "pip",
      "--disable-pip-version-check",
      "install",
      "--upgrade",
      "--force-reinstall",
      gitFilterRepoPackageSpec(),
    ],
    globalStoragePath
  );
  if (installRes.code !== 0) {
    return {
      ok: false,
      msg: `Failed to install ${gitFilterRepoPackageSpec()} into the private extension environment.`,
      err:
        [installRes.err.trim(), installRes.out.trim()]
          .filter(Boolean)
          .join("\n") || "pip install failed.",
    };
  }

  if (!fs.existsSync(executablePath)) {
    return {
      ok: false,
      msg: "git-filter-repo installation completed, but the executable was not found in the private environment.",
      err: `Expected executable path: ${executablePath}`,
    };
  }

  return {
    ok: true,
    executablePath,
  };
}

/** Generates a unique, timestamp-based destination repo name that does not leak the original repo name. */
function anonymizedRepoName(): string {
  // Use a generic timestamp-based name so the anonymized output path does not
  // reveal the original repository name while still remaining unique.
  const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
  return `anonymous-repo-${stamp}`;
}

/** Generates a stable, distinct placeholder author/committer identity for the given index. */
function anonymizedIdentityForIndex(index: number): string {
  // Keep the first placeholder short, then append stable numeric suffixes for
  // additional unique identities so different original people stay distinct.
  const suffix = index === 0 ? "" : ` ${index + 1}`;
  const emailSuffix = index === 0 ? "" : `${index + 1}`;
  return `Anonymous Developer${suffix} <anonymous${emailSuffix}@example.invalid>`;
}

/** Builds a failure result combining a human-readable message with the command's stderr/stdout. */
function formatGitFailure(msg: string, err: string, out: string): AnonymizeRepoResult {
  // Most git commands report useful details on stderr, but some also emit
  // relevant context on stdout, so combine both for the surfaced error.
  const details = [err.trim(), out.trim()].filter(Boolean).join("\n");
  return {
    ok: false,
    msg,
    err: details || msg,
  };
}

/** Best-effort recursive removal of a path, ignoring errors if it does not exist. */
async function removePathIfPresent(targetPath: string): Promise<void> {
  // Best-effort cleanup helper for temp directories or partially created
  // destination repositories after a failed anonymization run.
  await fs.promises.rm(targetPath, { recursive: true, force: true });
}

/** Collects every unique author and committer identity ("Name <email>") across all history in the repo. */
async function collectRepoIdentities(repoPath: string): Promise<Set<string>> {
  // Query every author and committer identity that appears anywhere in history.
  // Using both author and committer fields preserves distinctions introduced by
  // rebases, merges, or commits authored and committed by different people.
  const logRes = await gitCmd(
    ["log", "--all", "--format=%an <%ae>%n%cn <%ce>"],
    repoPath
  );
  if (logRes.code !== 0) {
    throw new Error(
      [logRes.err.trim(), logRes.out.trim()].filter(Boolean).join("\n") ||
        "Failed to read repository identities."
    );
  }

  return new Set(
    logRes.out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

/**
 * Reports whether a usable, correctly versioned git-filter-repo installation
 * already exists in the extension's private storage.
 */
export async function checkGitFilterRepoAvailable(
  globalStoragePath: string
) : Promise<GitFilterRepoAvailabilityResult> {
  const executablePath = gitFilterRepoExecutablePath(globalStoragePath);
  const installedVersion = await readInstalledGitFilterRepoVersion(
    globalStoragePath
  );

  if (installedVersion && installedVersion !== GIT_FILTER_REPO_VERSION) {
    return {
      ok: false,
      msg: `The private git-filter-repo environment contains version ${installedVersion}, but version ${GIT_FILTER_REPO_VERSION} is required.`,
      err: `Expected executable path: ${executablePath}`,
    };
  }

  const usable = await hasUsablePrivateGitFilterRepoInstallation(
    globalStoragePath
  );
  if (usable) {
    return { ok: true, executablePath };
  }

  if (!installedVersion) {
    return {
      ok: false,
      msg: "git-filter-repo is not installed in the extension-managed environment.",
      err:
        `Expected a private installation at ${gitFilterRepoToolRoot(globalStoragePath)}.`,
    };
  }

  return {
    ok: false,
    msg: "The private git-filter-repo installation is present but unusable.",
    err: `Expected executable path: ${executablePath}`,
  };
}

/**
 * Creates an anonymized normal repository in a user-selected destination folder
 * by rewriting all author/committer identities to generated anonymous
 * placeholders in a temporary mirror and then cloning the rewritten result.
 */
export async function anonymizeCurrentRepository(
  repoRoot: string,
  output: vscode.OutputChannel,
  options: AnonymizeRepoOptions
): Promise<AnonymizeRepoResult> {
  // Ask the user only for the parent destination folder. The current workspace
  // is always the source repository, and this command creates a new anonymized
  // mirror repo inside the chosen folder.
  const targetFolderPick = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Select anonymized repo destination",
  });
  const targetFolder = targetFolderPick?.[0]?.fsPath;
  if (!targetFolder) {
    return {
      ok: false,
      msg: "Repository anonymization cancelled because no destination folder was selected.",
    };
  }

  // Confirm that the currently opened workspace is really a git repository
  // before creating temporary state or destination output.
  const repoCheck = await gitCmd(["rev-parse", "--show-toplevel"], repoRoot);
  if (repoCheck.code !== 0) {
    return formatGitFailure(
      "The opened folder is not a git repository.",
      repoCheck.err,
      repoCheck.out
    );
  }

  if (!fs.existsSync(options.gitFilterRepoExecutablePath)) {
    return {
      ok: false,
      msg: "The configured private git-filter-repo executable does not exist.",
      err: options.gitFilterRepoExecutablePath,
    };
  }

  const destRepoPath = path.join(targetFolder, anonymizedRepoName());
  // Avoid rewriting into an existing target, because mirror clones and history
  // rewriting are destructive operations and should always start from a clean
  // destination repository.
  if (fs.existsSync(destRepoPath)) {
    return {
      ok: false,
      msg: `Destination already exists: ${destRepoPath}`,
    };
  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "copilot-recorder-anonymize-")
  );
  const mirrorRepoPath = path.join(tempDir, "rewrite.git");
  const mailmapPath = path.join(tempDir, "mailmap.txt");
  const replaceTextPath = path.join(tempDir, "replace-text.txt");
  let createdDestination = false;
  let succeeded = false;

  try {
    output.appendLine(`Source repo: ${repoRoot}`);
    output.appendLine(`Destination repo: ${destRepoPath}`);

    // Clone the current repository as a temporary bare mirror so the rewrite
    // operates on the full repository history and refs, not just the checked-
    // out branch of a working tree.
    const cloneRes = await gitCmd(
      ["clone", "--mirror", repoRoot, mirrorRepoPath],
      tempDir
    );
    if (cloneRes.code !== 0) {
      return formatGitFailure(
        "Failed to create the mirror clone for anonymization.",
        cloneRes.err,
        cloneRes.out
      );
    }
    // Build one mailmap rule per unique historical identity. Sorting first
    // keeps the anonymized placeholders stable across repeated runs.
    const identities = Array.from(await collectRepoIdentities(mirrorRepoPath)).sort(
      (a, b) => a.localeCompare(b)
    );
    const mailmapContent = identities
      .map((identity, index) => `${anonymizedIdentityForIndex(index)} ${identity}`)
      .join("\n");
    await fs.promises.writeFile(mailmapPath, mailmapContent, "utf8");

    const replaceTextExpressions = absolutePathReplacementExpressions(
      repoRoot,
      options.absolutePathHandling
    );
    if (replaceTextExpressions.length > 0) {
      const replaceTextContent = replaceTextExpressions.join("\n");
      await fs.promises.writeFile(replaceTextPath, replaceTextContent, "utf8");
    }

    const shouldRewriteHistory =
      identities.length > 0 || replaceTextExpressions.length > 0;
    if (shouldRewriteHistory) {
      // Rewrite the cloned mirror in place so all commits, tags, and refs use
      // the generated anonymous identities and, optionally, scrub absolute
      // source-repository paths from file contents and commit/tag messages.
      const filterRepoArgs = ["--force", "--mailmap", mailmapPath];
      if (replaceTextExpressions.length > 0) {
        filterRepoArgs.push("--replace-text", replaceTextPath);
        filterRepoArgs.push("--replace-message", replaceTextPath);
      }

      const filterRepoRes = await runCommand(
        options.gitFilterRepoExecutablePath,
        filterRepoArgs,
        mirrorRepoPath
      );
      if (filterRepoRes.code !== 0) {
        return formatGitFailure(
          "Failed to rewrite repository history with git filter-repo.",
          filterRepoRes.err,
          filterRepoRes.out
        );
      }
    }

    // Generated recorder artifacts should always receive the strongest absolute
    // path scrubbing, regardless of the repository-wide path anonymization mode.
    // Run a second history rewrite limited to .log and .chat-log blobs so the
    // anonymized repository never contains older commits with raw absolute paths
    // in those exported artifacts.
    const generatedLogRewriteRes = await runCommand(
      options.gitFilterRepoExecutablePath,
      ["--force", "--file-info-callback", generatedLogSanitizationCallback(repoRoot)],
      mirrorRepoPath
    );
    if (generatedLogRewriteRes.code !== 0) {
      return formatGitFailure(
        "Failed to sanitize generated log artifacts in repository history.",
        generatedLogRewriteRes.err,
        generatedLogRewriteRes.out
      );
    }

    if (identities.length === 0 && replaceTextExpressions.length === 0) {
      output.appendLine(
        "[skip] Repository history contained no author or committer identities or absolute paths to anonymize."
      );
    }

    // Materialize the rewritten mirror as a normal working-tree repository so
    // the final artifact is easy to inspect and use for downstream analysis.
    const finalCloneRes = await gitCmd(["clone", mirrorRepoPath, destRepoPath], targetFolder);
    if (finalCloneRes.code !== 0) {
      return formatGitFailure(
        "Failed to create the final anonymized working-tree repository.",
        finalCloneRes.err,
        finalCloneRes.out
      );
    }
    createdDestination = true;

    // Remove the original remote so the anonymized repository cannot be pushed
    // back to the source repository by accident.
    const removeOriginRes = await gitCmd(["remote", "remove", "origin"], destRepoPath);
    if (removeOriginRes.code !== 0) {
      output.appendLine(
        `[config] Could not remove origin from anonymized repository: ${removeOriginRes.err || removeOriginRes.out}`
      );
    }

    succeeded = true;
    return {
      ok: true,
      destRepoPath,
      anonymizedIdentityCount: identities.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      msg: "Failed to anonymize the repository.",
      err: msg,
    };
  } finally {
    // Always remove temporary artifacts, and if the rewrite failed after the
    // destination mirror was created, also delete that partial output so the
    // user does not end up with a half-anonymized repository.
    await removePathIfPresent(tempDir);
    if (createdDestination && !succeeded) {
      await removePathIfPresent(destRepoPath);
    }
  }
}
