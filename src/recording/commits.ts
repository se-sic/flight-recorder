import * as fs from "fs";
import * as path from "path";
import { CompletionEvent, formatEventJson } from "./event";
import { gitCmd, GitCommandResult } from "../utils/git";
import { LOG_EXPORT_PATH } from "../utils/paths";
import { EXTENSION_NAME } from "../utils/constants";

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


function isGitNotFoundResult(res: GitCommandResult): boolean {
  if (!res.spawnError) {
    return false;
  }

  const nodeErr = res.spawnError as NodeJS.ErrnoException;
  return nodeErr.code === "ENOENT";
}

function isIdentityNotConfiguredText(text: string): boolean {
  return (
    text.includes("Please tell me who you are") ||
    text.includes("unable to auto-detect email address") ||
    text.includes("git config --global user.email") ||
    text.includes("git config --global user.name")
  );
}

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

  if (stage === "commit" && isIdentityNotConfiguredText(combined)) {
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

export async function listAllChangedFiles(repoRoot: string): Promise<string[]> {
  const st = await gitCmd(["status", "--porcelain"], repoRoot);
  if (st.code !== 0) {
    return [];
  }
  return parsePorcelainNames(st.out);
}

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

function getCommitMessage(
  evs: CompletionEvent[]
): string {
  const header = evs.length === 1
    ? `${EXTENSION_NAME}: ${evs[0].origin} event`
    : `${EXTENSION_NAME}: ${evs.length} events`;
  const perEventMessages = evs.map((ev) => formatEventJson(ev));
  return [header, ...perEventMessages].join("\n");
}

async function stageAndCommit(
  repoRoot: string,
  msg: string,
  ts: string,
  relFiles: string[],
  addAll: boolean,
  allowEmpty: boolean,
  dryRun: boolean
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

export async function commitForEvent(
  repoRoot: string,
  ev: CompletionEvent,
  addAll: boolean,
  allowEmpty: boolean,
  dryRun: boolean
): Promise<GitActionResult> {
  return commitForEvents(repoRoot, [ev], addAll, allowEmpty, dryRun);
}

export async function commitForEvents(
  repoRoot: string,
  evs: CompletionEvent[],
  addAll: boolean,
  allowEmpty: boolean,
  dryRun: boolean
): Promise<GitActionResult> {
  if (evs.length === 0) {
    return { ok: false, skipped: true, msg: "No events to commit" };
  }

  const absRepo = path.resolve(repoRoot);
  const allAbsPaths = Array.from(
    new Set(evs.flatMap((ev) => ev.files).map((p) => path.resolve(p)))
  );
  const relFiles = allAbsPaths
    .filter((abs) => abs === absRepo || abs.startsWith(absRepo + path.sep))
    .map((abs) => path.relative(repoRoot, abs));
  const msg = getCommitMessage(evs);
  const lastTs = evs[evs.length - 1].timestamp;
  return stageAndCommit(repoRoot, msg, lastTs, relFiles, addAll, allowEmpty, dryRun);
}

/**
 * Copies the current Copilot logfile into the repository, stages it, and
 * creates a final shutdown commit so the raw session log is preserved.
 */
export async function commitCopilotLogSnapshot(
  repoRoot: string,
  sourceLogFile: string,
  dryRun: boolean,
  forceAdd: boolean
): Promise<GitActionResult & { snapshotPath?: string }> {
  const stamp = (new Date()).toISOString().replace(/:/g, "-").replace(/\./g, "-");
  const relSnapshotPath = path.join(LOG_EXPORT_PATH, `copilot-${stamp}.log`);
  const absSnapshotPath = path.join(repoRoot, relSnapshotPath);

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

  // Persist a timestamped copy of the current Copilot logfile inside the repo.
  fs.mkdirSync(path.dirname(absSnapshotPath), { recursive: true });
  const rawLogContent = fs.readFileSync(sourceLogFile, "utf8");
  fs.writeFileSync(absSnapshotPath, rawLogContent, "utf8");

  // Optionally force-stage the copied logfile snapshot so common ignore rules
  // like ".log/" or "*.log" do not prevent the final session snapshot commit.
  const addArgs = forceAdd
    ? ["add", "-f", "--", relSnapshotPath]
    : ["add", "--", relSnapshotPath];
  const addRes = await gitCmd(addArgs, repoRoot);
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
  const commitRes = await gitCmd(["commit", "-m", msg], repoRoot);
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
  forceAdd: boolean
): Promise<GitActionResult> {
  const relChatExportDir = path.relative(repoRoot, chatExportDir);

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
  const addRes = await gitCmd(addArgs, repoRoot);
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
    repoRoot
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
  const commitRes = await gitCmd(["commit", "-m", msg], repoRoot);
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
