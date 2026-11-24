import { gitCmd } from "../utils/git";

export type RecordingHistoryEntry = {
  hash: string;
  shortHash: string;
  authorDate: string;
  author: string;
  subject: string;
  kind: "human" | "assistant" | "git" | "log" | "chat" | "unknown";
  files: string[];
  origins: string[];
  /** Whether the commit is on the saved recording branch; false while it only exists on the running recording's branch. */
  saved: boolean;
};

export type RecordingHistory = {
  branchName: string;
  entries: RecordingHistoryEntry[];
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

export type RecordingPushResult =
  | { ok: true; msg: string }
  | { ok: false; msg: string; err?: string };

function splitLogRecords(output: string): string[] {
  return output.split("\x1e").map((entry) => entry.trim()).filter(Boolean);
}

function parseMetadata(body: string): Record<string, unknown> | null {
  const candidate = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("{") && line.endsWith("}"));

  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function classifySubject(subject: string): RecordingHistoryEntry["kind"] {
  if (subject.startsWith("Flight Recorder: human edits")) {
    return "human";
  }
  if (subject.startsWith("Flight Recorder: assistant")) {
    return "assistant";
  }
  if (subject.startsWith("Flight Recorder: git operation")) {
    return "git";
  }
  if (subject.startsWith("recording stopped:")) {
    return "log";
  }
  if (subject.startsWith("chat export:")) {
    return "chat";
  }
  return "unknown";
}

/**
 * Parses one `git log` record. The subject is taken from the raw message's
 * first line rather than `%s`, because recorder commits put their JSON
 * metadata on the line right after the subject without a blank line, which
 * `%s` would fold into the subject.
 */
function parseHistoryEntry(record: string): RecordingHistoryEntry | null {
  const [hash, shortHash, authorDate, author, rawMessage = ""] =
    record.split("\x1f");
  const [firstLine = "", ...bodyLines] = rawMessage.split("\n");
  const subject = firstLine.trim();
  const body = bodyLines.join("\n");
  if (!hash || !shortHash || !subject) {
    return null;
  }

  const metadata = parseMetadata(body);
  return {
    hash,
    shortHash,
    authorDate,
    author,
    subject,
    kind: classifySubject(subject),
    files: stringArray(metadata?.files),
    origins: stringArray(metadata?.origins),
    saved: true,
  };
}

export async function branchExists(
  repoRoot: string,
  branchName: string
): Promise<boolean> {
  const res = await gitCmd(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    repoRoot
  );
  return res.code === 0;
}

async function readUpstream(
  repoRoot: string,
  branchName: string
): Promise<string | null> {
  const res = await gitCmd(
    ["rev-parse", "--abbrev-ref", `${branchName}@{upstream}`],
    repoRoot
  );
  if (res.code !== 0 || res.out.trim().length === 0) {
    return null;
  }
  return res.out.trim();
}

async function readAheadBehind(
  repoRoot: string,
  branchName: string,
  upstream: string | null
): Promise<{ ahead: number | null; behind: number | null }> {
  if (!upstream) {
    return { ahead: null, behind: null };
  }

  const res = await gitCmd(
    ["rev-list", "--left-right", "--count", `${upstream}...${branchName}`],
    repoRoot
  );
  if (res.code !== 0) {
    return { ahead: null, behind: null };
  }

  const [behindRaw, aheadRaw] = res.out.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw, 10);
  const ahead = Number.parseInt(aheadRaw, 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

/**
 * Reads the recording commits on `branchName`, newest first. With
 * `savedBranchName` (the finalized recording branch), commits not on that
 * branch yet, i.e. those of a running recording, are marked as unsaved.
 */
export async function readRecordingHistory(
  repoRoot: string,
  branchName: string,
  sourceBranchName?: string,
  savedBranchName?: string,
  limit = 50
): Promise<RecordingHistory | null> {
  if (!(await branchExists(repoRoot, branchName))) {
    return null;
  }

  // Hide the source branch's own history, which the recording branch starts from.
  const excludeSource =
    sourceBranchName !== undefined &&
    sourceBranchName !== branchName &&
    (await branchExists(repoRoot, sourceBranchName));
  const log = await gitCmd(
    [
      "log",
      `--max-count=${limit}`,
      "--date=iso-strict",
      "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%B%x1e",
      branchName,
      ...(excludeSource ? ["--not", `refs/heads/${sourceBranchName}`] : []),
      "--",
    ],
    repoRoot
  );
  if (log.code !== 0) {
    return null;
  }

  const unsaved = await readUnsavedCommits(repoRoot, branchName, savedBranchName);
  const upstream = await readUpstream(repoRoot, branchName);
  const { ahead, behind } = await readAheadBehind(repoRoot, branchName, upstream);
  return {
    branchName,
    entries: splitLogRecords(log.out)
      .map(parseHistoryEntry)
      .filter((entry): entry is RecordingHistoryEntry => entry !== null)
      .map((entry) => ({ ...entry, saved: !unsaved.has(entry.hash) })),
    upstream,
    ahead,
    behind,
  };
}

/** Returns the hashes of commits on `branchName` that are not on `savedBranchName` (all of them if it does not exist yet). */
async function readUnsavedCommits(
  repoRoot: string,
  branchName: string,
  savedBranchName?: string
): Promise<Set<string>> {
  if (!savedBranchName || savedBranchName === branchName) {
    return new Set();
  }
  const savedExists = await branchExists(repoRoot, savedBranchName);
  const res = await gitCmd(
    ["rev-list", branchName, ...(savedExists ? ["--not", `refs/heads/${savedBranchName}`] : []), "--"],
    repoRoot
  );
  return new Set(res.code === 0 ? res.out.split("\n").map((line) => line.trim()).filter(Boolean) : []);
}

async function readRemotes(repoRoot: string): Promise<string[]> {
  const res = await gitCmd(["remote"], repoRoot);
  if (res.code !== 0) {
    return [];
  }
  return res.out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Determines where a recording branch should be pushed: its configured
 * remote if it has one, otherwise the repository's remotes for the caller
 * to choose from.
 */
export async function resolvePushRemote(
  repoRoot: string,
  branchName: string
): Promise<{ remote: string } | { choices: string[] }> {
  const configuredRemote = await gitCmd(
    ["config", "--get", `branch.${branchName}.remote`],
    repoRoot
  );
  if (configuredRemote.code === 0 && configuredRemote.out.trim().length > 0) {
    return { remote: configuredRemote.out.trim() };
  }

  const remotes = await readRemotes(repoRoot);
  if (remotes.length === 1) {
    return { remote: remotes[0] };
  }
  return {
    choices: [
      ...remotes.filter((remote) => remote === "origin"),
      ...remotes.filter((remote) => remote !== "origin"),
    ],
  };
}

export async function pushRecordingBranch(
  repoRoot: string,
  branchName: string,
  pushRemote: string
): Promise<RecordingPushResult> {
  if (!(await branchExists(repoRoot, branchName))) {
    return {
      ok: false,
      msg: `Recording branch does not exist: ${branchName}`,
    };
  }

  const res = await gitCmd(
    [
      "push",
      "-u",
      pushRemote,
      `refs/heads/${branchName}:refs/heads/${branchName}`,
    ],
    repoRoot
  );
  if (res.code !== 0) {
    const output = `${res.err}\n${res.out}`;
    const rejectedAsBehind = /non-fast-forward|fetch first|\[rejected\]/.test(output);
    return {
      ok: false,
      msg: rejectedAsBehind
        ? `${pushRemote} already has newer commits on ${branchName}, so the push was rejected. ` +
          "Flight Recorder never force-pushes; merge the remote commits into the recording branch first, or push to another remote."
        : `Failed to push ${branchName} to ${pushRemote}.`,
      err: res.err || res.out,
    };
  }

  return {
    ok: true,
    msg: `Pushed ${branchName} to ${pushRemote}.`,
  };
}
