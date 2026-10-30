import { gitCmd } from "../utils/git";

export type RecordingHistoryEntry = {
  hash: string;
  shortHash: string;
  authorDate: string;
  author: string;
  subject: string;
  kind: "human" | "assistant" | "log" | "chat" | "unknown";
  files: string[];
  origins: string[];
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
  if (subject.startsWith("recording stopped:")) {
    return "log";
  }
  if (subject.startsWith("chat export:")) {
    return "chat";
  }
  return "unknown";
}

function parseHistoryEntry(record: string): RecordingHistoryEntry | null {
  const [hash, shortHash, authorDate, author, subject, body = ""] =
    record.split("\x1f");
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

export async function readRecordingHistory(
  repoRoot: string,
  branchName: string,
  limit = 50
): Promise<RecordingHistory | null> {
  if (!(await branchExists(repoRoot, branchName))) {
    return null;
  }

  const log = await gitCmd(
    [
      "log",
      `--max-count=${limit}`,
      "--date=iso-strict",
      "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%b%x1e",
      branchName,
      "--",
    ],
    repoRoot
  );
  if (log.code !== 0) {
    return null;
  }

  const upstream = await readUpstream(repoRoot, branchName);
  const { ahead, behind } = await readAheadBehind(repoRoot, branchName, upstream);
  return {
    branchName,
    entries: splitLogRecords(log.out)
      .map(parseHistoryEntry)
      .filter((entry): entry is RecordingHistoryEntry => entry !== null),
    upstream,
    ahead,
    behind,
  };
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
    return {
      ok: false,
      msg: `Failed to push ${branchName} to ${pushRemote}.`,
      err: res.err || res.out,
    };
  }

  return {
    ok: true,
    msg: `Pushed ${branchName} to ${pushRemote}.`,
  };
}
