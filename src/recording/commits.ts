import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  formatWindowCommitMessage,
  WindowCommit,
} from "./staging-tracker";
import { gitCmd, GitCommandResult } from "../utils/git";
import {
  normalizePath,
  realDirectoryPath,
  relativePathInside,
  samePath,
} from "../utils/fs-path";
import { LOG_EXPORT_PATH } from "../utils/constants";

export type GitFailureKind =
  | "git_not_found"
  | "not_a_repo"
  | "no_commits"
  | "identity_not_configured"
  | "add_failed"
  | "commit_failed"
  | "finalize_failed"
  | "push_failed"
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
      activeBranchName: string;
      finalBranchName: string;
      sourceBranchName: string;
      sessionId: string;
    };

/** Command title referenced in recovery guidance messages. */
const RECOVER_COMMAND_TITLE = "Flight Recorder: Recover Unfinished Recordings";

export type GitWorktreeInfo = {
  path: string;
  branchName: string | null;
};

/** An active tracking branch that still has to be published onto its final branch. */
export type PendingTrackingSession = {
  sourceRoot: string;
  activeBranchName: string;
  finalBranchName: string;
  sessionId: string;
  worktreePath: string | null;
};

/** How finalization handles a final branch that is no longer an ancestor of the recording. */
export type DivergedFinalizationMode = "preserve" | "separateBranch";

export type RecordingFinalizationResult =
  | {
      ok: true;
      skipped: false;
      msg: string;
      activeBranchName: string;
      /** The branch the recording was published to (a separate branch when the final branch had diverged). */
      finalBranchName: string;
      head: string;
      warning?: string;
    }
  | {
      ok: true;
      skipped: true;
      msg: string;
    }
  | {
      ok: false;
      skipped: false;
      msg: string;
      err: string;
      kind: GitFailureKind;
      activeBranchName?: string;
      finalBranchName?: string;
      diverged?: boolean;
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

/**
 * Ref namespace of active (not yet finalized) tracking branches. It sits next
 * to `<prefix>/` rather than inside it, so no source branch name (not even
 * `active`) can clash with it.
 */
function activeBranchNamespace(prefix: string): string {
  return `${prefix}-active/`;
}

/** Namespace older versions used for active branches; still scanned for recovery. */
function legacyActiveBranchNamespace(prefix: string): string {
  return `${prefix}/active/`;
}

function trackingWorktreeDirectoryName(branchName: string): string {
  return sanitizeRefSegment(branchName.replace(/\//g, "__"));
}

function createTrackingSessionId(): string {
  const stamp = new Date().toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 8);
  return sanitizeRefSegment(`${stamp}-${suffix}`);
}

/** Returns the name of the finalized recording branch for a source branch, e.g. `flight-recorder/main`. */
export function recordingBranchName(sourceBranchName: string, trackingBranchPrefix: string): string {
  return `${sanitizeTrackingBranchPrefix(trackingBranchPrefix)}/${sanitizeRefSegment(sourceBranchName)}`;
}

/** Returns the checked-out branch, or `detached-<hash>` for a detached HEAD. */
export async function readSourceBranchName(repoRoot: string): Promise<string> {
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
    : normalizePath(repoRoot, rawPath);
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
  const sourceRoot = normalizePath(repoRoot);
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

  // Recording branches start from HEAD, so an empty repository cannot be tracked.
  const head = await gitCmd(["rev-parse", "--verify", "-q", "HEAD"], sourceRoot);
  if (head.code !== 0) {
    return {
      ok: false,
      kind: "no_commits",
      msg: "The repository has no commits yet. Create a first commit before recording.",
      err: head.err,
    };
  }

  const sourceBranchName = await readSourceBranchName(sourceRoot);
  const prefix = sanitizeTrackingBranchPrefix(options.trackingBranchPrefix);
  const sourceBranchSegment = sanitizeRefSegment(sourceBranchName);
  const finalBranchName = recordingBranchName(sourceBranchName, options.trackingBranchPrefix);
  const sessionId = createTrackingSessionId();
  const activeBranchName = `${activeBranchNamespace(prefix)}${sourceBranchSegment}/${sessionId}`;
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
    trackingWorktreeDirectoryName(activeBranchName)
  );

  if (dryRun) {
    return {
      ok: true,
      target: {
        mode: "trackingWorktree",
        sourceRoot,
        commitRoot,
        branchName: activeBranchName,
        activeBranchName,
        finalBranchName,
        sourceBranchName,
        sessionId,
      },
    };
  }

  const legacyRelease = await releaseLegacyTrackingWorktree(
    sourceRoot,
    finalBranchName
  );
  if (!legacyRelease.ok) {
    return {
      ok: false,
      kind: "unknown_git_error",
      msg: legacyRelease.msg,
      err: legacyRelease.err,
    };
  }

  if (!fs.existsSync(commitRoot)) {
    fs.mkdirSync(path.dirname(commitRoot), { recursive: true });
    const finalBranchExists = await gitBranchExists(sourceRoot, finalBranchName);
    const addArgs = [
      "worktree",
      "add",
      "-b",
      activeBranchName,
      commitRoot,
      finalBranchExists ? finalBranchName : "HEAD",
    ];
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
      currentBranch.out.trim() !== activeBranchName
    ) {
      return {
        ok: false,
        kind: "unknown_git_error",
        msg: `Flight Recorder tracking worktree is not on expected branch ${activeBranchName}.`,
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
      branchName: activeBranchName,
      activeBranchName,
      finalBranchName,
      sourceBranchName,
      sessionId,
    },
  };
}

/** Reads the commit hash a branch points at. */
async function readBranchHead(
  repoRoot: string,
  branchName: string
): Promise<GitCommandResult> {
  return gitCmd(["rev-parse", "--verify", branchName], repoRoot);
}

/** Returns whether `ancestorRef` is an ancestor of (or equal to) `descendantRef`. */
async function isAncestor(
  repoRoot: string,
  ancestorRef: string,
  descendantRef: string
): Promise<boolean> {
  const res = await gitCmd(
    ["merge-base", "--is-ancestor", ancestorRef, descendantRef],
    repoRoot
  );
  return res.code === 0;
}

/** Returns whether directory `candidate` is `parent` itself or lies inside it, resolving symlinks in both. */
function isPathInside(candidate: string, parent: string): boolean {
  return relativePathInside(realDirectoryPath(parent), realDirectoryPath(candidate)) !== null;
}

/** Lists the repository's worktrees with the short branch name each one has checked out. */
async function listWorktrees(repoRoot: string): Promise<GitWorktreeInfo[]> {
  const res = await gitCmd(["worktree", "list", "--porcelain"], repoRoot);
  if (res.code !== 0) {
    return [];
  }

  const worktrees: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | null = null;
  for (const line of res.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branchName: null };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branchName = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    }
  }
  return worktrees;
}

/**
 * Removes a clean hidden worktree left behind by the earlier tracking model,
 * which kept the final branch itself checked out under
 * `.git/flight-recorder-worktrees/`. While it exists, git refuses to move the
 * final branch, so finalization would always fail.
 */
async function releaseLegacyTrackingWorktree(
  sourceRoot: string,
  finalBranchName: string
): Promise<{ ok: true } | { ok: false; msg: string; err: string }> {
  const commonGitDir = await readCommonGitDir(sourceRoot);
  if (commonGitDir.code !== 0) {
    return { ok: true };
  }

  const trackingRoot = path.join(
    commonGitDir.out.trim(),
    "flight-recorder-worktrees"
  );
  const legacy = (await listWorktrees(sourceRoot)).find(
    (worktree) =>
      worktree.branchName === finalBranchName &&
      isPathInside(worktree.path, trackingRoot)
  );
  if (!legacy) {
    return { ok: true };
  }

  const status = await gitCmd(["status", "--porcelain"], legacy.path);
  if (status.code !== 0 || status.out.trim().length > 0) {
    return {
      ok: false,
      msg:
        `An older Flight Recorder worktree at ${legacy.path} still has ${finalBranchName} checked out ` +
        "with uncommitted changes. Commit or discard them there, then try again.",
      err: status.err || status.out,
    };
  }

  const removeRes = await gitCmd(
    ["worktree", "remove", legacy.path],
    sourceRoot
  );
  if (removeRes.code !== 0) {
    return {
      ok: false,
      msg: `Failed to remove the older Flight Recorder worktree at ${legacy.path}.`,
      err: removeRes.err || removeRes.out,
    };
  }
  return { ok: true };
}

/**
 * Lists active tracking branches (`<prefix>-active/<source>/<sessionId>`, or
 * the older `<prefix>/active/...`) that were never finalized, e.g. because
 * finalization failed or VS Code exited while recording.
 */
export async function listPendingTrackingSessions(
  repoRoot: string,
  trackingBranchPrefix: string
): Promise<PendingTrackingSession[]> {
  const sourceRoot = normalizePath(repoRoot);
  const prefix = sanitizeTrackingBranchPrefix(trackingBranchPrefix);
  const namespaces = [activeBranchNamespace(prefix), legacyActiveBranchNamespace(prefix)];
  const refs = await gitCmd(
    [
      "for-each-ref",
      "--format=%(refname)",
      ...namespaces.map((namespace) => `refs/heads/${namespace}`),
    ],
    sourceRoot
  );
  if (refs.code !== 0) {
    return [];
  }

  const worktrees = await listWorktrees(sourceRoot);
  const sessions: PendingTrackingSession[] = [];
  for (const ref of refs.out.split("\n").map((line) => line.trim())) {
    const activeBranchName = ref.replace(/^refs\/heads\//, "");
    const activeNamespace = namespaces.find((namespace) =>
      activeBranchName.startsWith(namespace)
    );
    if (!activeNamespace) {
      continue;
    }

    const rest = activeBranchName.slice(activeNamespace.length);
    const slash = rest.lastIndexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      continue;
    }

    sessions.push({
      sourceRoot,
      activeBranchName,
      finalBranchName: `${prefix}/${rest.slice(0, slash)}`,
      sessionId: rest.slice(slash + 1),
      worktreePath:
        worktrees.find((worktree) => worktree.branchName === activeBranchName)
          ?.path ?? null,
    });
  }
  return sessions;
}

/**
 * Publishes an active tracking branch onto its final branch, then releases
 * the hidden worktree and deletes the active branch. The final branch is only
 * created or fast-forwarded. If it has diverged, `divergedMode` decides
 * whether to stop (keeping everything for recovery) or to publish the
 * recording as a separate `<final>-<sessionId>` branch instead. Cleanup
 * failures after publishing are reported as warnings, not failures, because
 * the recorded history is already safe on the final branch.
 */
async function finalizeTrackingSession(
  session: PendingTrackingSession,
  divergedMode: DivergedFinalizationMode
): Promise<RecordingFinalizationResult> {
  const { sourceRoot, activeBranchName, finalBranchName } = session;
  const fail = (
    msg: string,
    err: string,
    diverged = false
  ): RecordingFinalizationResult => ({
    ok: false,
    skipped: false,
    kind: "finalize_failed",
    activeBranchName,
    finalBranchName,
    msg,
    err,
    diverged,
  });

  const worktreePath =
    session.worktreePath && fs.existsSync(session.worktreePath)
      ? session.worktreePath
      : null;
  if (worktreePath) {
    const status = await gitCmd(["status", "--porcelain"], worktreePath);
    if (status.code !== 0) {
      const failure = classifyGitFailure(
        "validate",
        status,
        `Failed to inspect Flight Recorder worktree at ${worktreePath}.`
      );
      return fail(failure.msg, failure.err);
    }
    if (status.out.trim().length > 0) {
      return fail(
        `Flight Recorder hidden worktree at ${worktreePath} has uncommitted changes; preserving it for recovery.`,
        status.out
      );
    }
  }

  const activeHead = await readBranchHead(sourceRoot, activeBranchName);
  if (activeHead.code !== 0 || activeHead.out.trim().length === 0) {
    const failure = classifyGitFailure(
      "validate",
      activeHead,
      `Failed to resolve active Flight Recorder branch ${activeBranchName}.`
    );
    return fail(failure.msg, failure.err);
  }
  const head = activeHead.out.trim();

  const legacyRelease = await releaseLegacyTrackingWorktree(
    sourceRoot,
    finalBranchName
  );
  if (!legacyRelease.ok) {
    return fail(legacyRelease.msg, legacyRelease.err);
  }

  let publishedBranchName = finalBranchName;
  if (!(await gitBranchExists(sourceRoot, finalBranchName))) {
    const createRes = await gitCmd(
      ["branch", finalBranchName, head],
      sourceRoot
    );
    if (createRes.code !== 0) {
      const failure = classifyGitFailure(
        "validate",
        createRes,
        `Failed to create ${finalBranchName} at ${head}.`
      );
      return fail(failure.msg, failure.err);
    }
  } else if (await isAncestor(sourceRoot, activeBranchName, finalBranchName)) {
    // Already published by an earlier attempt whose cleanup failed.
  } else if (await isAncestor(sourceRoot, finalBranchName, activeBranchName)) {
    const holder = (await listWorktrees(sourceRoot)).find(
      (worktree) =>
        worktree.branchName === finalBranchName &&
        (!worktreePath || !samePath(realDirectoryPath(worktree.path), realDirectoryPath(worktreePath)))
    );
    if (holder) {
      return fail(
        `${finalBranchName} is checked out at ${holder.path}, so Flight Recorder cannot move it. ` +
          `Switch that checkout to another branch, then run "${RECOVER_COMMAND_TITLE}".`,
        `${finalBranchName} is checked out in worktree ${holder.path}.`
      );
    }

    const moveRes = await gitCmd(
      ["branch", "-f", finalBranchName, head],
      sourceRoot
    );
    if (moveRes.code !== 0) {
      const failure = classifyGitFailure(
        "validate",
        moveRes,
        `Failed to move ${finalBranchName} to ${head}.`
      );
      return fail(failure.msg, failure.err);
    }
  } else if (divergedMode === "separateBranch") {
    publishedBranchName = `${finalBranchName}-${session.sessionId}`;
    if (await gitBranchExists(sourceRoot, publishedBranchName)) {
      return fail(
        `Cannot save the recording as ${publishedBranchName} because that branch already exists.`,
        `${publishedBranchName} already exists.`
      );
    }
    const createRes = await gitCmd(
      ["branch", publishedBranchName, head],
      sourceRoot
    );
    if (createRes.code !== 0) {
      const failure = classifyGitFailure(
        "validate",
        createRes,
        `Failed to create ${publishedBranchName} at ${head}.`
      );
      return fail(failure.msg, failure.err);
    }
  } else {
    return fail(
      `${finalBranchName} has moved since this recording started, so it cannot be fast-forwarded to ${activeBranchName}. ` +
        `The recording was preserved; run "${RECOVER_COMMAND_TITLE}" to save it.`,
      `${finalBranchName} is not an ancestor of ${activeBranchName}.`,
      true
    );
  }

  const warnings: string[] = [];
  const removeRes = worktreePath
    ? await gitCmd(["worktree", "remove", worktreePath], sourceRoot)
    : await gitCmd(["worktree", "prune"], sourceRoot);
  if (removeRes.code !== 0) {
    warnings.push(
      `Could not remove hidden worktree ${worktreePath ?? "(prune)"}: ${(removeRes.err || removeRes.out).trim()}`
    );
  }

  const deleteRes = await gitCmd(["branch", "-D", activeBranchName], sourceRoot);
  if (deleteRes.code !== 0) {
    warnings.push(
      `Could not delete temporary branch ${activeBranchName}: ${(deleteRes.err || deleteRes.out).trim()}`
    );
  }

  const msgLines = [
    `Finalized Flight Recorder history on ${publishedBranchName} at ${head.slice(0, 12)}.`,
  ];
  if (publishedBranchName !== finalBranchName) {
    msgLines.push(
      `${finalBranchName} had diverged, so the recording was saved as a separate branch.`
    );
  }
  if (worktreePath && removeRes.code === 0) {
    msgLines.push(`Removed hidden worktree ${worktreePath}.`);
  }

  return {
    ok: true,
    skipped: false,
    activeBranchName,
    finalBranchName: publishedBranchName,
    head,
    msg: msgLines.join("\n"),
    warning:
      warnings.length > 0
        ? `${warnings.join("\n")}\nThe recording is safe on ${publishedBranchName}; run "${RECOVER_COMMAND_TITLE}" to retry the cleanup.`
        : undefined,
  };
}

/**
 * Promotes a completed active tracking branch to the normal user-facing
 * recording branch when recording stops. Diverged final branches are never
 * force-updated; the active branch and worktree are kept for recovery.
 */
export async function finalizeRecordingCommitTarget(
  target: RecordingCommitTarget,
  dryRun: boolean
): Promise<RecordingFinalizationResult> {
  if (target.mode !== "trackingWorktree") {
    return {
      ok: true,
      skipped: true,
      msg: "No tracking worktree finalization needed for current-branch recording.",
    };
  }

  if (dryRun) {
    return {
      ok: true,
      skipped: true,
      msg:
        `[dry-run] would fast-forward ${target.finalBranchName} to ${target.activeBranchName}\n` +
        `[dry-run] would remove hidden worktree ${target.commitRoot}\n` +
        `[dry-run] would delete temporary branch ${target.activeBranchName}`,
    };
  }

  return finalizeTrackingSession(
    {
      sourceRoot: target.sourceRoot,
      activeBranchName: target.activeBranchName,
      finalBranchName: target.finalBranchName,
      sessionId: target.sessionId,
      worktreePath: target.commitRoot,
    },
    "preserve"
  );
}

/**
 * Removes the hidden worktree and active branch of a session that never
 * started recording. Only call this before any commit was made on the branch.
 */
export async function discardRecordingCommitTarget(
  target: RecordingCommitTarget,
  dryRun: boolean
): Promise<void> {
  if (target.mode !== "trackingWorktree" || dryRun) {
    return;
  }
  await gitCmd(["worktree", "remove", "--force", target.commitRoot], target.sourceRoot);
  await gitCmd(["worktree", "prune"], target.sourceRoot);
  await gitCmd(["branch", "-D", target.activeBranchName], target.sourceRoot);
}

/** Finalizes a leftover active tracking branch found by `listPendingTrackingSessions`. */
export async function finalizePendingTrackingSession(
  session: PendingTrackingSession,
  divergedMode: DivergedFinalizationMode
): Promise<RecordingFinalizationResult> {
  return finalizeTrackingSession(session, divergedMode);
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
  const resolved = normalizePath(repoRoot);
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

/**
 * Mirrors one file from the visible checkout into the tracking worktree, using
 * the in-memory editor snapshot instead of the file on disk when one is given.
 */
function copySnapshotIntoCommitTarget(
  sourceRoot: string,
  commitRoot: string,
  rel: string,
  snapshot?: string
): void {
  const normalizedRel = normalizeRelativeRepoPath(rel);
  if (!normalizedRel) {
    return;
  }

  const sourcePath = path.join(sourceRoot, normalizedRel);
  const targetPath = path.join(commitRoot, normalizedRel);

  if (snapshot !== undefined) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.writeFileSync(targetPath, snapshot, "utf8");
    return;
  }

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

/** Converts a repo-relative path to git's forward-slash spelling. */
function toGitPath(rel: string): string {
  return rel.split(path.sep).join("/");
}

/** Returns whether `filePath` exists, counting broken symlinks as existing. */
function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops paths that git ignores in `root`, so they are neither staged nor
 * committed. Tracked files are never reported as ignored by git.
 */
async function withoutIgnoredPaths(root: string, rels: string[]): Promise<string[]> {
  if (rels.length === 0) {
    return rels;
  }
  const res = await gitCmd(["check-ignore", "-z", "--stdin"], root, {
    input: rels.map(toGitPath).join("\0") + "\0",
  });
  // Exit code 1 means nothing is ignored; anything else but 0 is an error we
  // let the following git add report.
  if (res.code !== 0) {
    return rels;
  }
  const ignored = new Set(res.out.split("\0").filter(Boolean));
  return rels.filter((rel) => !ignored.has(toGitPath(rel)));
}

/**
 * Drops paths that neither exist in `root` nor are tracked in `trackedRoot`,
 * which `git add` would reject (e.g. a temporary file created and deleted
 * within one window).
 */
async function withoutUnknownMissingPaths(
  root: string,
  rels: string[],
  trackedRoot = root
): Promise<string[]> {
  const missing = rels.filter((rel) => !pathExists(path.join(root, rel)));
  if (missing.length === 0) {
    return rels;
  }
  const tracked = await gitCmd(["ls-files", "-z", "--", ...missing.map(toGitPath)], trackedRoot);
  const trackedPaths = new Set(tracked.out.split("\0").filter(Boolean));
  return rels.filter((rel) => !missing.includes(rel) || trackedPaths.has(toGitPath(rel)));
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
  target = createCurrentBranchTarget(repoRoot),
  snapshots?: Record<string, string>
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
        : "no git add";
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
    // Mirror every named file and let `git diff --cached` against the
    // recording branch decide what changed. Comparing with the visible HEAD
    // instead would miss reverts and files that exist only on the branch.
    const snapshotFor = (rel: string) =>
      snapshots?.[normalizePath(target.sourceRoot, rel)];
    const candidates = addAll
      ? Array.from(new Set([...relFiles, ...(await listAllChangedFiles(target.sourceRoot))]))
      : relFiles;
    const mirrored = await withoutIgnoredPaths(target.commitRoot, candidates);

    for (const rel of mirrored) {
      copySnapshotIntoCommitTarget(
        target.sourceRoot,
        target.commitRoot,
        rel,
        snapshotFor(rel)
      );
    }
    const effectiveRelFiles = await withoutUnknownMissingPaths(target.commitRoot, mirrored);

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
      msg:
        `${msg}\n` +
        `activeTrackingBranch: ${target.activeBranchName}\n` +
        `finalTrackingBranch: ${target.finalBranchName}`,
      err: res.err,
    };
  }

  // === Real mode (staging + commit) ===
  //
  // For path-specific Flight Recorder commits, use `git commit --only -- <paths>`
  // after staging the target paths. A plain `git commit` would also include
  // unrelated changes that were already staged before recording started.
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
    relFiles = await withoutUnknownMissingPaths(repoRoot, relFiles);
    if (relFiles.length === 0) {
      if (!allowEmpty) {
        return { ok: false, skipped: true, msg: `No tracked files for ${ts}` };
      }
    } else {
      const addRes = await gitCmd(["add", "--", ...relFiles], repoRoot);
      if (addRes.code !== 0) {
        const failure = classifyGitFailure(
          "add",
          addRes,
          `Failed to stage changes for ${relFiles.join(", ")}.`
        );
        return { ok: false, skipped: false, ...failure };
      }
    }
  }

  let stagedAny = false;
  if (addAll || relFiles.length > 0) {
    const diffArgs = addAll
      ? ["diff", "--cached", "--name-only"]
      : ["diff", "--cached", "--name-only", "--", ...relFiles];
    const diffCached = await gitCmd(diffArgs, repoRoot);
    stagedAny = diffCached.out.trim().length > 0;
  }

  if (!stagedAny && !allowEmpty) {
    return { ok: false, skipped: true, msg: `No staged changes for ${ts}` };
  }

  const args = ["commit", "-m", msg];
  if (allowEmpty && !stagedAny) {
    args.splice(1, 0, "--allow-empty");
  }
  if (!addAll) {
    args.push("--only");
    if (relFiles.length > 0) {
      args.push("--", ...relFiles);
    }
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
  // Relative paths here keep native separators; git accepts both.
  const relFiles = Array.from(
    new Set(
      commit.files
        .map((filePath) => relativePathInside(repoRoot, filePath))
        .filter((rel): rel is string => !!rel)
        .map((rel) => rel.split("/").join(path.sep))
    )
  );

  const snapshots = commit.kind === "human" ? commit.snapshots : undefined;
  const hasSnapshot = (rel: string) => snapshots?.[normalizePath(repoRoot, rel)] !== undefined;
  // Ignored files (e.g. `.env`) are never recorded; staging them would also
  // fail the whole commit. Transient files (created and removed again within
  // the window) are left out too, unless an editor snapshot holds their text.
  const notIgnored = await withoutIgnoredPaths(commitTarget.commitRoot, relFiles);
  const present = new Set(
    await withoutUnknownMissingPaths(repoRoot, notIgnored, commitTarget.commitRoot)
  );
  const stageableFiles = notIgnored.filter((rel) => present.has(rel) || hasSnapshot(rel));

  // The commit metadata lists only what is actually recorded.
  const recorded = new Set(stageableFiles.map((rel) => normalizePath(repoRoot, rel)));
  const isRecorded = (filePath: string) => recorded.has(normalizePath(filePath));
  const recordedCommit: WindowCommit = commit.kind === "assistant"
    ? {
      ...commit,
      files: commit.files.filter(isRecorded),
      fileAttributions: commit.fileAttributions.filter((attribution) => isRecorded(attribution.path)),
    }
    : { ...commit, files: commit.files.filter(isRecorded) };
  const msg = formatWindowCommitMessage(recordedCommit, repoRoot);
  const ts = new Date(commit.endedAt).toISOString();
  if (snapshots && !dryRun && !addAll && commitTarget.mode === "currentBranch") {
    return commitWithSnapshots(repoRoot, msg, stageableFiles, snapshots);
  }
  return stageAndCommit(
    repoRoot,
    msg,
    ts,
    stageableFiles,
    addAll,
    allowEmpty,
    dryRun,
    commitTarget,
    snapshots
  );
}

/**
 * Commits `relFiles`, taking the content of snapshotted files from memory
 * instead of the working tree. Builds the commit in a temporary index so the
 * working tree and unrelated staged changes stay untouched, then resets the
 * real index entries of the committed paths to the new HEAD.
 */
async function commitWithSnapshots(
  repoRoot: string,
  msg: string,
  relFiles: string[],
  snapshots: Record<string, string>
): Promise<GitActionResult> {
  const env = {
    GIT_INDEX_FILE: path.join(os.tmpdir(), `flight-recorder-${process.pid}-${Date.now()}.index`),
  };
  const fail = (res: GitCommandResult, stage: "add" | "commit", what: string): GitActionResult => ({
    ok: false,
    skipped: false,
    ...classifyGitFailure(stage, res, what),
  });

  try {
    const hasHead = (await gitCmd(["rev-parse", "--verify", "-q", "HEAD"], repoRoot)).code === 0;
    const readTree = await gitCmd(["read-tree", hasHead ? "HEAD" : "--empty"], repoRoot, { env });
    if (readTree.code !== 0) {
      return fail(readTree, "add", "Failed to prepare a temporary index.");
    }

    for (const rel of relFiles) {
      const gitPath = rel.split(path.sep).join("/");
      const snapshot = snapshots[normalizePath(repoRoot, rel)];
      if (snapshot === undefined) {
        if ((await withoutUnknownMissingPaths(repoRoot, [rel])).length === 0) {
          continue;
        }
        const addRes = await gitCmd(["add", "--", rel], repoRoot, { env });
        if (addRes.code !== 0) {
          return fail(addRes, "add", `Failed to stage ${rel}.`);
        }
        continue;
      }

      const blob = await gitCmd(["hash-object", "-w", "--stdin", `--path=${gitPath}`], repoRoot, { input: snapshot });
      const mode = (await gitCmd(["ls-files", "-s", "--", gitPath], repoRoot, { env })).out.split(" ")[0] || "100644";
      const update = await gitCmd(
        ["update-index", "--add", "--cacheinfo", `${mode},${blob.out.trim()},${gitPath}`],
        repoRoot,
        { env }
      );
      if (blob.code !== 0 || update.code !== 0) {
        return fail(blob.code !== 0 ? blob : update, "add", `Failed to stage human edits of ${rel}.`);
      }
    }

    const commitRes = await gitCmd(["commit", "-m", msg], repoRoot, { env });
    if (commitRes.code !== 0) {
      if (`${commitRes.out}${commitRes.err}`.includes("nothing to commit")) {
        return { ok: false, skipped: true, msg: "No staged human changes." };
      }
      return fail(commitRes, "commit", "Failed to commit human edits.");
    }

    await gitCmd(["reset", "-q", "--", ...relFiles], repoRoot);
    return { ok: true, skipped: false, msg, err: commitRes.err };
  } finally {
    await fs.promises.rm(env.GIT_INDEX_FILE, { force: true });
  }
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
  const commitRes = await gitCmd(
    ["commit", "-m", msg, "--only", "--", relSnapshotPath],
    commitTarget.commitRoot
  );
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
  const commitRes = await gitCmd(
    ["commit", "-m", msg, "--only", "--", relChatExportDir],
    commitTarget.commitRoot
  );
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
