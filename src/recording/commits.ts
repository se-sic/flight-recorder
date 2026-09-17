import * as fs from "fs";
import * as path from "path";
import {
  formatWindowCommitMessage,
  WindowCommit,
} from "./staging-tracker";
import { gitCmd, GitCommandResult } from "../utils/git";
import { LOG_EXPORT_PATH } from "../utils/paths";

export type GitFailureKind =
  | "git_not_found"
  | "not_a_repo"
  | "identity_not_configured"
  | "add_failed"
  | "commit_failed"
  | "unknown_git_error";

export type GitFailure = {
  kind: GitFailureKind;
  msg: string;
  err: string;
};

export type GitActionResult =
  | { ok: true; skipped: false; msg: string; err?: string }
  | { ok: false; skipped: true; msg: string }
  | { ok: false; skipped: boolean; msg: string; err: string; kind?: GitFailureKind };

export type GitValidationResult =
  | { ok: true }
  | { ok: false; kind: GitFailureKind; msg: string; err: string };

export type RecordingCommitMode = "currentBranch" | "trackingWorktree";

export type RecordingCommitTarget =
  | {
      mode: "currentBranch";
      sourceRoot: string;
      commitRoot: string;
    }
  | {
      mode: "trackingWorktree";
      sourceRoot: string;
      commitRoot: string;
      branchName: string;
      sourceBranchName: string;
    };

export type RecordingCommitTargetOptions = {
  mode: RecordingCommitMode;
  trackingBranchPrefix: string;
};

/** Returns whether a failed git command result was caused by git not being installed/found. */
function isGitNotFoundResult(res: GitCommandResult): boolean {
  if (!res.spawnError) {
    return false;
  }

  const nodeErr = res.spawnError as NodeJS.ErrnoException;
  return nodeErr.code === "ENOENT";
}

/** Classifies a failed git command result into a specific failure kind and message for the given operation stage. */
function classifyGitFailure(
  stage: "run" | "add" | "commit" | "validate",
  res: GitCommandResult,
  fallbackMsg: string
): GitFailure {
  const combined = `${res.err}\n${res.out}\n${res.spawnError?.message ?? ""}`.trim();

  if (isGitNotFoundResult(res)) {
    return {
      kind: "git_not_found",
      msg: "Git is not installed or not available in PATH.",
      err: combined || fallbackMsg,
    };
  }

  if (combined.includes("not a git repository")) {
    return {
      kind: "not_a_repo",
      msg: "The opened folder is not a git repository.",
      err: combined || fallbackMsg,
    };
  }

  const isIdentityNotConfiguredText =
    combined.includes("Please tell me who you are") ||
    combined.includes("unable to auto-detect email address") ||
    combined.includes("git config --global user.email") ||
    combined.includes("git config --global user.name");
  if (stage === "commit" && isIdentityNotConfiguredText) {
    return {
      kind: "identity_not_configured",
      msg: "Git user.name and/or user.email are not configured.",
      err: combined || fallbackMsg,
    };
  }

  return {
    kind:
      stage === "add"
        ? "add_failed"
        : stage === "commit"
          ? "commit_failed"
          : "unknown_git_error",
    msg: fallbackMsg,
    err: combined || fallbackMsg,
  };
}

/** Reads the resolved author or committer identity git would use for a commit in this repo. */
async function readGitIdent(
  repoRoot: string,
  key: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT"
): Promise<GitCommandResult> {
  return gitCmd(["var", key], repoRoot);
}

/**
 * Verifies that recording can safely create git commits for this workspace.
 * The checks run in startup order: git executable available, workspace is a
 * git repository, and Git can resolve commit identity unless dry-run is enabled.
 */
export async function validateGitRecordingReadiness(
  repoRoot: string,
  dryRun: boolean
): Promise<GitValidationResult> {
  // First make sure the git executable can be launched at all. This catches
  // both "git is not installed" and "git is not available in PATH".
  const gitVersion = await gitCmd(["--version"], repoRoot);
  if (gitVersion.code !== 0 || isGitNotFoundResult(gitVersion)) {
    const failure = classifyGitFailure(
      "validate",
      gitVersion,
      "Failed to run git."
    );
    return { ok: false, ...failure };
  }

  // Then verify that the opened workspace folder is actually inside a git
  // repository, because recording relies on staging and committing changes.
  const repoCheck = await gitCmd(["rev-parse", "--show-toplevel"], repoRoot);
  if (repoCheck.code !== 0) {
    const failure = classifyGitFailure(
      "validate",
      repoCheck,
      "Failed to validate the git repository."
    );
    return { ok: false, ...failure };
  }

  // Dry-run mode never creates commits, so missing git identity is acceptable.
  if (dryRun) {
    return { ok: true };
  }

  // In normal mode, ask Git for the resolved author and committer identities
  // it would actually use for commits. This is less strict than requiring
  // explicit user.name/user.email config and matches real commit behavior
  // better, because Git may derive a valid identity from other sources.
  const [authorIdent, committerIdent] = await Promise.all([
    readGitIdent(repoRoot, "GIT_AUTHOR_IDENT"),
    readGitIdent(repoRoot, "GIT_COMMITTER_IDENT"),
  ]);

  const hasAuthorIdent =
    authorIdent.code === 0 && authorIdent.out.trim().length > 0;
  const hasCommitterIdent =
    committerIdent.code === 0 && committerIdent.out.trim().length > 0;

  if (!hasAuthorIdent || !hasCommitterIdent) {
    return {
      ok: false,
      kind: "identity_not_configured",
      msg: "Git could not determine a usable author/committer identity for commits.",
      err: [
        hasAuthorIdent
          ? ""
          : `git var GIT_AUTHOR_IDENT failed: ${authorIdent.err || authorIdent.out || "no output"}`,
        hasCommitterIdent
          ? ""
          : `git var GIT_COMMITTER_IDENT failed: ${committerIdent.err || committerIdent.out || "no output"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return { ok: true };
}

function sanitizeRefSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.+$/g, "")
    .replace(/\.lock$/i, "");

  return sanitized.length > 0 ? sanitized : "unnamed";
}

function sanitizeTrackingBranchPrefix(value: string): string {
  const segments = value
    .split("/")
    .map((segment) => sanitizeRefSegment(segment))
    .filter((segment) => segment.length > 0);

  return segments.length > 0 ? segments.join("/") : "flight-recorder";
}

function trackingWorktreeDirectoryName(branchName: string): string {
  return sanitizeRefSegment(branchName.replace(/\//g, "__"));
}

async function readSourceBranchName(repoRoot: string): Promise<string> {
  const branch = await gitCmd(["branch", "--show-current"], repoRoot);
  const currentBranch = branch.out.trim();
  if (branch.code === 0 && currentBranch.length > 0) {
    return currentBranch;
  }

  const shortHead = await gitCmd(["rev-parse", "--short", "HEAD"], repoRoot);
  if (shortHead.code === 0 && shortHead.out.trim().length > 0) {
    return `detached-${shortHead.out.trim()}`;
  }

  return "detached-head";
}

async function readCommonGitDir(repoRoot: string): Promise<GitCommandResult> {
  const res = await gitCmd(["rev-parse", "--git-common-dir"], repoRoot);
  if (res.code !== 0) {
    return res;
  }

  const rawPath = res.out.trim();
  res.out = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(repoRoot, rawPath);
  return res;
}

async function gitBranchExists(
  repoRoot: string,
  branchName: string
): Promise<boolean> {
  const res = await gitCmd(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    repoRoot
  );
  return res.code === 0;
}

/**
 * Resolves where Flight Recorder should create commits. In tracking-worktree
 * mode this creates or reuses a hidden worktree on a dedicated branch under
 * the repository's common git directory, so user branch/index state is isolated.
 */
export async function prepareRecordingCommitTarget(
  repoRoot: string,
  dryRun: boolean,
  options: RecordingCommitTargetOptions
): Promise<
  | { ok: true; target: RecordingCommitTarget }
  | { ok: false; kind: GitFailureKind; msg: string; err: string }
> {
  const sourceRoot = path.resolve(repoRoot);
  if (options.mode === "currentBranch") {
    return {
      ok: true,
      target: {
        mode: "currentBranch",
        sourceRoot,
        commitRoot: sourceRoot,
      },
    };
  }

  const sourceBranchName = await readSourceBranchName(sourceRoot);
  const prefix = sanitizeTrackingBranchPrefix(options.trackingBranchPrefix);
  const branchName = `${prefix}/${sanitizeRefSegment(sourceBranchName)}`;
  const commonGitDir = await readCommonGitDir(sourceRoot);
  if (commonGitDir.code !== 0) {
    const failure = classifyGitFailure(
      "validate",
      commonGitDir,
      "Failed to locate the repository git directory."
    );
    return { ok: false, ...failure };
  }

  const commitRoot = path.join(
    commonGitDir.out.trim(),
    "flight-recorder-worktrees",
    trackingWorktreeDirectoryName(branchName)
  );

  if (dryRun) {
    return {
      ok: true,
      target: {
        mode: "trackingWorktree",
        sourceRoot,
        commitRoot,
        branchName,
        sourceBranchName,
      },
    };
  }

  if (!fs.existsSync(commitRoot)) {
    fs.mkdirSync(path.dirname(commitRoot), { recursive: true });
    const branchExists = await gitBranchExists(sourceRoot, branchName);
    const addArgs = branchExists
      ? ["worktree", "add", commitRoot, branchName]
      : ["worktree", "add", "-b", branchName, commitRoot, "HEAD"];
    const addRes = await gitCmd(addArgs, sourceRoot);
    if (addRes.code !== 0) {
      const failure = classifyGitFailure(
        "validate",
        addRes,
        `Failed to prepare Flight Recorder tracking worktree at ${commitRoot}.`
      );
      return { ok: false, ...failure };
    }
  } else {
    const worktreeCheck = await gitCmd(
      ["rev-parse", "--is-inside-work-tree"],
      commitRoot
    );
    if (worktreeCheck.code !== 0 || worktreeCheck.out.trim() !== "true") {
      return {
        ok: false,
        kind: "unknown_git_error",
        msg: `Flight Recorder tracking path exists but is not a git worktree: ${commitRoot}`,
        err: worktreeCheck.err || worktreeCheck.out,
      };
    }

    const currentBranch = await gitCmd(["branch", "--show-current"], commitRoot);
    if (
      currentBranch.code !== 0 ||
      currentBranch.out.trim() !== branchName
    ) {
      return {
        ok: false,
        kind: "unknown_git_error",
        msg: `Flight Recorder tracking worktree is not on expected branch ${branchName}.`,
        err: currentBranch.err || currentBranch.out,
      };
    }
  }

  return {
    ok: true,
    target: {
      mode: "trackingWorktree",
      sourceRoot,
      commitRoot,
      branchName,
      sourceBranchName,
    },
  };
}

/** Extracts file paths from `git status --porcelain` output, using the new-name side of renames. */
function parsePorcelainNames(porcelain: string): string[] {
  // status --porcelain lines look like:
  // " M path", "?? path", "A  path", "R  old -> new" etc.
  const lines = porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  const names: string[] = [];
  for (const line of lines) {
    // rename format: "R  old -> new"
    const mRename = line.match(/^[A-Z?]{1,2}\s+(.*)\s+->\s+(.*)$/);
    if (mRename) {
      names.push(mRename[2]);
      continue;
    }

    const m = line.match(/^[A-Z?]{1,2}\s+(.*)$/);
    if (m) {
      names.push(m[1]);
    }
  }
  return names;
}

/** Lists every changed (tracked or untracked) file path in the repo's working tree. */
export async function listAllChangedFiles(repoRoot: string): Promise<string[]> {
  const st = await gitCmd(["status", "--porcelain"], repoRoot);
  if (st.code !== 0) {
    return [];
  }
  return parsePorcelainNames(st.out);
}

function createCurrentBranchTarget(repoRoot: string): RecordingCommitTarget {
  const resolved = path.resolve(repoRoot);
  return {
    mode: "currentBranch",
    sourceRoot: resolved,
    commitRoot: resolved,
  };
}

function targetOrDefault(
  repoRoot: string,
  target?: RecordingCommitTarget
): RecordingCommitTarget {
  return target ?? createCurrentBranchTarget(repoRoot);
}

function normalizeRelativeRepoPath(rel: string): string | null {
  const normalized = path.normalize(rel);
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  return normalized;
}

function copySnapshotIntoCommitTarget(
  sourceRoot: string,
  commitRoot: string,
  rel: string
): void {
  const normalizedRel = normalizeRelativeRepoPath(rel);
  if (!normalizedRel) {
    return;
  }

  const sourcePath = path.join(sourceRoot, normalizedRel);
  const targetPath = path.join(commitRoot, normalizedRel);

  if (!fs.existsSync(sourcePath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  }

  const sourceStat = fs.lstatSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.rmSync(targetPath, { recursive: true, force: true });

  if (sourceStat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(sourcePath);
    fs.symlinkSync(linkTarget, targetPath);
    return;
  }

  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: false,
    force: true,
  });
}

async function changedFilesForCommit(
  sourceRoot: string,
  relFiles: string[],
  addAll: boolean
): Promise<string[]> {
  if (addAll || relFiles.length === 0) {
    return listAllChangedFiles(sourceRoot);
  }

  const changedFiles: string[] = [];
  for (const rel of relFiles) {
    const changed = await fileHasChanges(sourceRoot, rel);
    if (changed) {
      changedFiles.push(rel);
    }
  }
  return changedFiles;
}

/** Returns whether a file differs from HEAD in the working tree, or is untracked. */
export async function fileHasChanges(
  repoRoot: string,
  rel: string
): Promise<boolean> {
  // True if file differs from HEAD in working tree (tracked changes) OR is untracked.
  const tracked = await gitCmd(
    ["diff", "--name-only", "HEAD", "--", rel],
    repoRoot
  );
  if (tracked.code === 0 && tracked.out.trim().length > 0) {
    return true;
  }

  const untracked = await gitCmd(
    ["ls-files", "--others", "--exclude-standard", "--", rel],
    repoRoot
  );
  if (untracked.code === 0 && untracked.out.trim().length > 0) {
    return true;
  }

  return false;
}

/**
 * Stages the given files (or all changes, if `addAll`/no files given) and
 * creates a commit with the given message. In dry-run mode, reports what
 * would be staged and committed without touching the repository.
 */
async function stageAndCommit(
  repoRoot: string,
  msg: string,
  ts: string,
  relFiles: string[],
  addAll: boolean,
  allowEmpty: boolean,
  dryRun: boolean,
  target = createCurrentBranchTarget(repoRoot)
): Promise<GitActionResult> {
  if (dryRun) {
    let wouldStage: string[] = [];

    if (addAll) {
      wouldStage = await listAllChangedFiles(repoRoot);
    } else if (relFiles.length > 0) {
      const changedFiles: string[] = [];
      for (const rel of relFiles) {
        const changed = await fileHasChanges(repoRoot, rel);
        if (changed) {
          changedFiles.push(rel);
        }
      }
      wouldStage = changedFiles;
    } else {
      wouldStage = await listAllChangedFiles(repoRoot);
    }

    const wouldCommit = wouldStage.length > 0 || allowEmpty;
    if (!wouldCommit) {
      return {
        ok: false,
        skipped: true,
        msg: `No relevant changes; would not commit for ${ts}`,
      };
    }

    const stagedPart =
      wouldStage.length > 0
        ? wouldStage.join(", ")
        : "(no changes; would be empty commit)";
    const addPart = addAll
      ? "git add -A"
      : relFiles.length > 0
        ? `git add -- ${relFiles.join(" ")}`
        : "git add -A";
    const allowEmptyPart = allowEmpty ? " --allow-empty" : "";

    return {
      ok: true,
      skipped: false,
      msg:
        `[dry-run] would run: ${addPart}\n` +
        `[dry-run] would run: git commit -m "${msg}"${allowEmptyPart}\n` +
        `[dry-run] would include: ${stagedPart}`,
      err: "",
    };
  }

  if (target.mode === "trackingWorktree") {
    const effectiveRelFiles = await changedFilesForCommit(
      target.sourceRoot,
      relFiles,
      addAll
    );

    for (const rel of effectiveRelFiles) {
      copySnapshotIntoCommitTarget(
        target.sourceRoot,
        target.commitRoot,
        rel
      );
    }

    if (effectiveRelFiles.length > 0) {
      const addRes = await gitCmd(
        ["add", "-A", "--", ...effectiveRelFiles],
        target.commitRoot
      );
      if (addRes.code !== 0) {
        const failure = classifyGitFailure(
          "add",
          addRes,
          `Failed to stage tracking worktree changes for ${effectiveRelFiles.join(", ")}.`
        );
        return { ok: false, skipped: false, ...failure };
      }
    }

    const diffCached = await gitCmd(
      ["diff", "--cached", "--name-only"],
      target.commitRoot
    );
    const stagedAny = diffCached.out.trim().length > 0;

    if (!stagedAny && !allowEmpty) {
      return { ok: false, skipped: true, msg: `No staged changes for ${ts}` };
    }

    const args = ["commit", "-m", msg];
    if (allowEmpty && !stagedAny) {
      args.splice(1, 0, "--allow-empty");
    }

    const res = await gitCmd(args, target.commitRoot);
    if (res.code !== 0) {
      const failure = classifyGitFailure(
        "commit",
        res,
        `Failed to create tracking worktree commit for ${ts}.`
      );
      return { ok: false, skipped: false, ...failure };
    }

    return {
      ok: true,
      skipped: false,
      msg: `${msg}\ntrackingBranch: ${target.branchName}`,
      err: res.err,
    };
  }

  // === Real mode (staging + commit) ===
  if (addAll) {
    const addRes = await gitCmd(["add", "-A"], repoRoot);
    if (addRes.code !== 0) {
      const failure = classifyGitFailure(
        "add",
        addRes,
        "Failed to stage repository changes."
      );
      return { ok: false, skipped: false, ...failure };
    }
  } else {
    if (relFiles.length > 0) {
      const addRes = await gitCmd(["add", "--", ...relFiles], repoRoot);
      if (addRes.code !== 0) {
        const failure = classifyGitFailure(
          "add",
          addRes,
          `Failed to stage changes for ${relFiles.join(", ")}.`
        );
        return { ok: false, skipped: false, ...failure };
      }
    } else {
      const addRes = await gitCmd(["add", "-A"], repoRoot);
      if (addRes.code !== 0) {
        const failure = classifyGitFailure(
          "add",
          addRes,
          "Failed to stage repository changes."
        );
        return { ok: false, skipped: false, ...failure };
      }
    }
  }

  const diffCached = await gitCmd(
    ["diff", "--cached", "--name-only"],
    repoRoot
  );
  const stagedAny = diffCached.out.trim().length > 0;

  if (!stagedAny && !allowEmpty) {
    return { ok: false, skipped: true, msg: `No staged changes for ${ts}` };
  }

  const args = ["commit", "-m", msg];
  if (allowEmpty && !stagedAny) {
    args.splice(1, 0, "--allow-empty");
  }

  const res = await gitCmd(args, repoRoot);
  if (res.code !== 0) {
    const failure = classifyGitFailure(
      "commit",
      res,
      `Failed to create commit for ${ts}.`
    );
    return { ok: false, skipped: false, ...failure };
  }

  return { ok: true, skipped: false, msg, err: res.err };
}

/** Stages a window commit's files and commits them with a message built from the window's metadata and events. */
export async function commitTrackedWindow(
  repoRoot: string,
  commit: WindowCommit,
  addAll: boolean,
  allowEmpty: boolean,
  dryRun: boolean,
  target?: RecordingCommitTarget
): Promise<GitActionResult> {
  const commitTarget = targetOrDefault(repoRoot, target);
  const absRepo = path.resolve(repoRoot);
  const relFiles = Array.from(
    new Set(
      commit.files
        .map((filePath) => path.resolve(filePath))
        .filter((abs) => abs === absRepo || abs.startsWith(absRepo + path.sep))
        .map((abs) => path.relative(repoRoot, abs))
    )
  );

  const msg = formatWindowCommitMessage(commit, repoRoot);
  const ts = new Date(commit.endedAt).toISOString();
  return stageAndCommit(
    repoRoot,
    msg,
    ts,
    relFiles,
    addAll,
    allowEmpty,
    dryRun,
    commitTarget
  );
}

/**
 * Copies the current assistant logfile into the repository, stages it, and
 * creates a final shutdown commit so the raw session log is preserved.
 */
export async function commitAssistantLogSnapshot(
  repoRoot: string,
  sourceLogFile: string,
  snapshotPrefix: string,
  dryRun: boolean,
  forceAdd: boolean,
  target?: RecordingCommitTarget
): Promise<GitActionResult & { snapshotPath?: string }> {
  const commitTarget = targetOrDefault(repoRoot, target);
  const stamp = (new Date()).toISOString().replace(/:/g, "-").replace(/\./g, "-");
  const relSnapshotPath = path.join(
    LOG_EXPORT_PATH,
    `${snapshotPrefix}-${stamp}.log`
  );
  const absSnapshotPath = path.join(commitTarget.commitRoot, relSnapshotPath);

  // In dry-run mode, report what would happen without copying or committing.
  if (dryRun) {
    return {
      ok: true,
      skipped: false,
      msg:
        `[dry-run] would copy ${sourceLogFile} -> ${relSnapshotPath}\n` +
        `[dry-run] would run: git add ${forceAdd ? "-f " : ""}-- ${relSnapshotPath}\n` +
        "[dry-run] would commit recording stopped snapshot",
      err: "",
      snapshotPath: absSnapshotPath,
    };
  }

  // Persist a timestamped copy of the current assistant logfile inside the repo.
  fs.mkdirSync(path.dirname(absSnapshotPath), { recursive: true });
  const rawLogContent = fs.readFileSync(sourceLogFile, "utf8");
  fs.writeFileSync(absSnapshotPath, rawLogContent, "utf8");

  // Optionally force-stage the copied logfile snapshot so common ignore rules
  // like ".log/" or "*.log" do not prevent the final session snapshot commit.
  const addArgs = forceAdd
    ? ["add", "-f", "--", relSnapshotPath]
    : ["add", "--", relSnapshotPath];
  const addRes = await gitCmd(addArgs, commitTarget.commitRoot);
  if (addRes.code !== 0) {
    const failure = classifyGitFailure(
      "add",
      addRes,
      `Failed to stage log snapshot ${relSnapshotPath}.`
    );
    return { ok: false, skipped: false, ...failure };
  }

  // Create a dedicated commit for the shutdown snapshot.
  const msg = `recording stopped: ${stamp} | log file: ${relSnapshotPath}`;
  const commitRes = await gitCmd(["commit", "-m", msg], commitTarget.commitRoot);
  if (commitRes.code !== 0) {
    const failure = classifyGitFailure(
      "commit",
      commitRes,
      "Failed to commit the Copilot log snapshot."
    );
    return {
      ok: false,
      skipped: false,
      snapshotPath: absSnapshotPath,
      ...failure,
    };
  }

  return {
    ok: true,
    skipped: false,
    msg,
    err: commitRes.err,
    snapshotPath: absSnapshotPath,
  };
}

/**
 * Stages and commits exported chat session files from the repository's
 * .chat-log directory as a separate commit.
 */
export async function commitChatExportSnapshot(
  repoRoot: string,
  chatExportDir: string,
  dryRun: boolean,
  forceAdd: boolean,
  target?: RecordingCommitTarget
): Promise<GitActionResult> {
  const commitTarget = targetOrDefault(repoRoot, target);
  const relChatExportDir = path.relative(commitTarget.commitRoot, chatExportDir);

  if (dryRun) {
    return {
      ok: true,
      skipped: false,
      msg:
        `[dry-run] would run: git add ${forceAdd ? "-f " : ""}-- ${relChatExportDir}\n` +
        `[dry-run] would run: git commit -m "chat export: ${relChatExportDir}"`,
      err: "",
    };
  }

  const addArgs = forceAdd
    ? ["add", "-f", "--", relChatExportDir]
    : ["add", "--", relChatExportDir];
  const addRes = await gitCmd(addArgs, commitTarget.commitRoot);
  if (addRes.code !== 0) {
    const failure = classifyGitFailure(
      "add",
      addRes,
      `Failed to stage exported chats in ${relChatExportDir}.`
    );
    return { ok: false, skipped: false, ...failure };
  }

  const diffCached = await gitCmd(
    ["diff", "--cached", "--name-only", "--", relChatExportDir],
    commitTarget.commitRoot
  );
  if (diffCached.code !== 0) {
    const failure = classifyGitFailure(
      "run",
      diffCached,
      `Failed to inspect staged exported chats in ${relChatExportDir}.`
    );
    return { ok: false, skipped: false, ...failure };
  }

  if (diffCached.out.trim().length === 0) {
    return {
      ok: false,
      skipped: true,
      msg: `No exported chat changes to commit in ${relChatExportDir}`,
    };
  }

  const msg = `chat export: ${relChatExportDir}`;
  const commitRes = await gitCmd(["commit", "-m", msg], commitTarget.commitRoot);
  if (commitRes.code !== 0) {
    const failure = classifyGitFailure(
      "commit",
      commitRes,
      `Failed to commit exported chats from ${relChatExportDir}.`
    );
    return { ok: false, skipped: false, ...failure };
  }

  return { ok: true, skipped: false, msg, err: commitRes.err };
}
