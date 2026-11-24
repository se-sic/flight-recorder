import * as fs from "fs";
import { gitCmd } from "../utils/git";
import { normalizePath } from "../utils/fs-path";

/**
 * A git command that changed the working tree while recording. `paths` are
 * the absolute paths it wrote or deleted, `startedAt` roughly when it began.
 */
export type GitOperation =
  | { kind: "branch-switch"; from: string; to: string; description: string; paths: string[]; startedAt: number }
  | { kind: "operation"; description: string; paths: string[]; startedAt: number };

type ReflogEntry = { oldSha: string; newSha: string; at: number; message: string };

/** A path a git command touched, and the blob it should now hold (null: deleted). */
type TargetPath = { path: string; blob: string | null };

const REFLOG_LINE = /^([0-9a-f]+) ([0-9a-f]+) .*? (\d+) [+-]\d{4}\t(.*)$/;
const SWITCH_MESSAGE = /^checkout: moving from (.+) to (.+)$/;
const MAX_DESCRIPTION_LENGTH = 200;

/** Parses one reflog line, or returns null for a line in another format. */
export function parseReflogLine(line: string): ReflogEntry | null {
  const match = REFLOG_LINE.exec(line);
  if (!match) {
    return null;
  }
  return { oldSha: match[1], newSha: match[2], at: Number(match[3]) * 1000, message: match[4] };
}

/** Whether a sha is git's all-zero placeholder for "no object". */
function isNullSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

/** Reads a file's size and modification time, or null if it does not exist. */
function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Detects git commands that change the working tree (pull, merge, reset,
 * rebase, stash, checkout of another branch) by reading the reflogs of HEAD
 * and of the stash. Commits and the recorder's own commits change no files
 * and are ignored. Only files whose content now matches what the command
 * produced count as its changes, so a soft or mixed reset, which leaves the
 * files alone, changes nothing.
 */
export class GitOperationWatcher {
  private headOffset: number;
  private stashKey: string;
  private stashShas: string[];
  private polling = false;

  private constructor(
    private readonly sourceRoot: string,
    private readonly headLog: string,
    private readonly stashLog: string
  ) {
    this.headOffset = statOrNull(headLog)?.size ?? 0;
    this.stashKey = this.readStashKey();
    this.stashShas = this.readStashShas();
  }

  /** Creates a watcher for the repository at `sourceRoot`, starting from its current state; null if git cannot locate the reflogs. */
  static async create(sourceRoot: string): Promise<GitOperationWatcher | null> {
    const res = await gitCmd(["rev-parse", "--git-path", "logs/HEAD", "--git-path", "logs/refs/stash"], sourceRoot);
    const [headLog, stashLog] = res.out.split("\n").map((line) => line.trim());
    if (res.code !== 0 || !headLog || !stashLog) {
      return null;
    }
    return new GitOperationWatcher(sourceRoot, normalizePath(sourceRoot, headLog), normalizePath(sourceRoot, stashLog));
  }

  /** Returns the git operations since the last poll, oldest first. Overlapping calls return nothing. */
  async poll(): Promise<GitOperation[]> {
    if (this.polling) {
      return [];
    }
    this.polling = true;
    try {
      return [...await this.headOperations(), ...await this.stashOperations()];
    } finally {
      this.polling = false;
    }
  }

  /** Reads the reflog lines appended to HEAD's log since the last poll. */
  private readNewHeadEntries(): ReflogEntry[] {
    const size = statOrNull(this.headLog)?.size ?? 0;
    if (size <= this.headOffset) {
      // Unchanged, or rewritten (e.g. `git reflog expire`): start over from its end.
      this.headOffset = size;
      return [];
    }
    const fd = fs.openSync(this.headLog, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - this.headOffset);
      fs.readSync(fd, buffer, 0, buffer.length, this.headOffset);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    this.headOffset += Buffer.byteLength(complete);
    return complete.split("\n").map(parseReflogLine).filter((entry): entry is ReflogEntry => entry !== null);
  }

  /** Turns new HEAD reflog entries into operations; consecutive entries of one command (e.g. a rebase) become one. */
  private async headOperations(): Promise<GitOperation[]> {
    const operations: GitOperation[] = [];
    let group: ReflogEntry[] = [];
    const flushGroup = async () => {
      if (group.length === 0) {
        return;
      }
      const first = group[0];
      const last = group[group.length - 1];
      group = [];
      const description = last.message.slice(0, MAX_DESCRIPTION_LENGTH);
      const changes = await this.diffTargets(first.oldSha, last.newSha, "new");
      const operation = await this.toOperation(changes, first.at);
      if (operation) {
        operations.push({ kind: "operation", description, ...operation });
      }
    };

    for (const entry of this.readNewHeadEntries()) {
      if (entry.message.startsWith("commit")) {
        // Commits (also amends and the recorder's own commits) leave the files as they are.
        await flushGroup();
        continue;
      }
      const switched = SWITCH_MESSAGE.exec(entry.message);
      if (switched) {
        await flushGroup();
        if (switched[1] !== switched[2]) {
          const changes = await this.diffTargets(entry.oldSha, entry.newSha, "new");
          const operation = await this.toOperation(changes, entry.at);
          operations.push({
            kind: "branch-switch",
            from: switched[1],
            to: switched[2],
            description: entry.message,
            paths: operation?.paths ?? [],
            startedAt: operation?.startedAt ?? entry.at,
          });
        }
        continue;
      }
      group.push(entry);
    }
    await flushGroup();
    return operations;
  }

  /** A cheap fingerprint of the stash reflog, to skip reading it while unchanged. */
  private readStashKey(): string {
    const stat = statOrNull(this.stashLog);
    return stat ? `${stat.size}:${stat.mtimeMs}` : "";
  }

  /** The stash entries' commits, oldest first. */
  private readStashShas(): string[] {
    try {
      return fs.readFileSync(this.stashLog, "utf8").split("\n").map(parseReflogLine)
        .filter((entry): entry is ReflogEntry => entry !== null)
        .map((entry) => entry.newSha);
    } catch {
      return [];
    }
  }

  /** Detects stashing (files go back to the stash's base) and popping (files get the stash's content). */
  private async stashOperations(): Promise<GitOperation[]> {
    const key = this.readStashKey();
    if (key === this.stashKey) {
      return [];
    }
    this.stashKey = key;
    const previous = this.stashShas;
    const current = this.readStashShas();
    this.stashShas = current;

    const operations: GitOperation[] = [];
    const stat = statOrNull(this.stashLog);
    const at = stat?.mtimeMs ?? Date.now();
    for (const sha of current.filter((candidate) => !previous.includes(candidate))) {
      const changes = await this.stashTargets(sha, "base");
      const operation = await this.toOperation(changes, at);
      if (operation) {
        operations.push({ kind: "operation", description: "stash", ...operation });
      }
    }
    for (const sha of previous.filter((candidate) => !current.includes(candidate))) {
      // A dropped entry changes no files; only a pop or apply passes the content check.
      const changes = await this.stashTargets(sha, "stash");
      const operation = await this.toOperation(changes, Date.now());
      if (operation) {
        operations.push({ kind: "operation", description: "stash pop", ...operation });
      }
    }
    return operations;
  }

  /** The files that differ between two commits, with the blob of the given side. */
  private async diffTargets(from: string, to: string, side: "old" | "new"): Promise<TargetPath[]> {
    if (isNullSha(from) || isNullSha(to) || from === to) {
      return [];
    }
    const res = await gitCmd(["diff", "--raw", "--no-abbrev", "--no-renames", "-z", from, to], this.sourceRoot);
    if (res.code !== 0) {
      return [];
    }
    const parts = res.out.split("\0");
    const targets: TargetPath[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      // ":<old mode> <new mode> <old sha> <new sha> <status>", then the path.
      const [oldMode, newMode, oldSha, newSha] = parts[i].replace(/^:/, "").split(" ");
      if (oldMode === "160000" || newMode === "160000") {
        continue;
      }
      const blob = side === "new" ? newSha : oldSha;
      targets.push({ path: parts[i + 1], blob: blob && !isNullSha(blob) ? blob : null });
    }
    return targets;
  }

  /** The files a stash entry holds: tracked changes, plus untracked files when stashed with `-u`. */
  private async stashTargets(sha: string, side: "base" | "stash"): Promise<TargetPath[]> {
    const tracked = await this.diffTargets(`${sha}^1`, sha, side === "base" ? "old" : "new");
    const untracked = await gitCmd(["ls-tree", "-r", "-z", `${sha}^3`], this.sourceRoot);
    if (untracked.code !== 0) {
      return tracked;
    }
    const files = untracked.out.split("\0").filter(Boolean).map((line) => {
      const [meta, filePath] = line.split("\t");
      return { path: filePath, blob: side === "base" ? null : meta.split(" ")[2] };
    });
    return [...tracked, ...files];
  }

  /**
   * Keeps the files whose content matches what the command produced (or that
   * are gone, for deletions) and estimates when it started from their
   * modification times. Returns null when no file matches.
   */
  private async toOperation(targets: TargetPath[], at: number): Promise<{ paths: string[]; startedAt: number } | null> {
    if (targets.length === 0) {
      return null;
    }
    const absolute = (rel: string) => normalizePath(this.sourceRoot, rel);
    const existing = targets.filter((target) => target.blob !== null && statOrNull(absolute(target.path))?.isFile());
    const hashes = existing.length > 0
      ? (await gitCmd(["hash-object", "--stdin-paths"], this.sourceRoot, {
        input: existing.map((target) => target.path).join("\n") + "\n",
      })).out.split("\n")
      : [];
    const written = existing.filter((target, i) => hashes[i]?.trim() === target.blob);
    const deleted = targets.filter((target) => target.blob === null && !statOrNull(absolute(target.path)));
    const paths = [...written, ...deleted].map((target) => absolute(target.path));
    if (paths.length === 0) {
      return null;
    }
    // The reflog only has whole seconds, so the files' times are more precise.
    const mtimes = written.map((target) => statOrNull(absolute(target.path))?.mtimeMs ?? at);
    const startedAt = Math.min(at + 999, ...mtimes);
    return { paths: paths.sort((left, right) => left.localeCompare(right)), startedAt };
  }
}
