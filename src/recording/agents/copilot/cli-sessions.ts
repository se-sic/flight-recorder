import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { AssistantEvent, FileOperation } from "../../event";
import { AssistantRuntimeEventSource } from "../../integration";
import { Tailer } from "../../../utils/tailer";

/** Files copied from each Copilot CLI session-state directory. */
export const COPILOT_CLI_SESSION_FILES = ["events.jsonl", "workspace.yaml"];

/** Copilot CLI tools that write files. */
const COPILOT_CLI_EDIT_TOOLS = new Set(["apply_patch", "create", "edit"]);

/** The parts of a session's `workspace.yaml` that Flight Recorder uses. */
export type CopilotCliWorkspace = {
  /** `cwd` and `git_root`, used to match sessions to a repository. */
  dirs: string[];
  createdAt?: Date;
  name?: string;
};

export type CopilotCliSession = {
  dir: string;
  workspace: CopilotCliWorkspace;
};

/** Returns the Copilot CLI session-state directory, honoring COPILOT_HOME. */
export function getCopilotCliSessionStateDir(): string {
  const copilotHome =
    process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  return path.join(copilotHome, "session-state");
}

/** Normalizes a filesystem path for comparison (resolved, no trailing separator, case-insensitive on Windows). */
function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Parses the top-level keys Flight Recorder needs from a Copilot CLI `workspace.yaml`. */
export function parseCopilotCliWorkspace(yaml: string): CopilotCliWorkspace {
  const lines = yaml.split(/\r?\n/);
  const workspace: CopilotCliWorkspace = { dirs: [] };
  lines.forEach((line, i) => {
    const m = /^(\w+):\s*(.*?)\s*$/.exec(line);
    if (!m) return;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if ((m[1] === "cwd" || m[1] === "git_root") && value) {
      workspace.dirs.push(value);
    } else if (m[1] === "created_at" && !isNaN(Date.parse(value))) {
      workspace.createdAt = new Date(value);
    } else if (m[1] === "name") {
      // Long names are written as a `|-` block; its first line is enough.
      workspace.name = value.startsWith("|") ? lines[i + 1]?.trim() : value;
    }
  });
  return workspace;
}

/** Reads a session directory's `workspace.yaml`, or null if it is missing or unreadable. */
async function readCopilotCliSession(dir: string): Promise<CopilotCliSession | null> {
  try {
    const yaml = await fs.promises.readFile(path.join(dir, "workspace.yaml"), "utf8");
    return { dir, workspace: parseCopilotCliWorkspace(yaml) };
  } catch {
    return null;
  }
}

function isSessionForRepo(session: CopilotCliSession, repoRoot: string): boolean {
  const target = normalizeForCompare(repoRoot);
  return session.workspace.dirs.some((d) => normalizeForCompare(d) === target);
}

/** Lists the names of the session directories in the session-state directory. */
async function listSessionDirNames(sessionStateDir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(sessionStateDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Finds Copilot CLI agent-host sessions (used by newer Copilot Chat builds
 * instead of `workspaceStorage/<id>/chatSessions`) whose working directory
 * or git root is the given repository.
 */
export async function findCopilotCliSessionsForRepo(
  repoRoot: string,
  sessionStateDir = getCopilotCliSessionStateDir()
): Promise<CopilotCliSession[]> {
  const sessions = await Promise.all(
    (await listSessionDirNames(sessionStateDir)).map((name) =>
      readCopilotCliSession(path.join(sessionStateDir, name))
    )
  );
  return sessions.filter(
    (s): s is CopilotCliSession => s !== null && isSessionForRepo(s, repoRoot)
  );
}

/**
 * Resolves a CLI-reported path and lowercases its Windows drive letter, the
 * way VS Code's `Uri.fsPath` does, so it matches workspace change paths.
 */
function toVscodePath(p: string): string {
  return path.resolve(p).replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
}

/** Extracts file operations from a Copilot CLI edit tool's arguments. */
function collectCliToolFileOperations(
  toolName: string,
  args: unknown
): FileOperation[] {
  if (toolName === "apply_patch" && typeof args === "string") {
    const kinds = { Add: "create", Delete: "delete", Update: "update" } as const;
    return Array.from(
      args.matchAll(/^\*\*\* (Update|Add|Delete) File:\s+(.+)$/gm),
      (m) => ({
        kind: kinds[m[1] as keyof typeof kinds],
        path: toVscodePath(m[2].trim()),
      })
    );
  }

  const filePath = (args as { path?: unknown } | null)?.path;
  if (typeof filePath === "string" && filePath.trim()) {
    return [
      { kind: toolName === "create" ? "create" : "update", path: toVscodePath(filePath) },
    ];
  }
  return [];
}

type PendingCliToolCall = {
  toolName: string;
  fileOperations: FileOperation[];
  turnId?: string;
  model?: string;
};

/**
 * Parses Copilot CLI session `events.jsonl` content, fed incrementally, and
 * yields an `edit-applied` event for every file-writing tool call that
 * completed successfully.
 */
export class CopilotCliEventParser {
  private partialLine = "";
  private readonly pending = new Map<string, PendingCliToolCall>();

  constructor(private readonly sessionId?: string) {}

  *feed(chunk: string): Generator<AssistantEvent> {
    const lines = (this.partialLine + chunk).split(/\r?\n/);
    this.partialLine = lines.pop() ?? "";

    for (const line of lines) {
      let entry: {
        type?: unknown;
        timestamp?: unknown;
        data?: Record<string, unknown>;
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const data = entry.data;
      const toolCallId = data?.toolCallId;
      if (!data || typeof toolCallId !== "string") continue;

      if (entry.type === "tool.execution_start") {
        const toolName = data.toolName;
        if (typeof toolName !== "string" || !COPILOT_CLI_EDIT_TOOLS.has(toolName)) {
          continue;
        }
        const fileOperations = collectCliToolFileOperations(toolName, data.arguments);
        if (fileOperations.length > 0) {
          this.pending.set(toolCallId, {
            toolName,
            fileOperations,
            turnId: typeof data.turnId === "string" ? data.turnId : undefined,
            model: typeof data.model === "string" ? data.model : undefined,
          });
        }
        continue;
      }

      if (entry.type !== "tool.execution_complete") continue;
      const call = this.pending.get(toolCallId);
      this.pending.delete(toolCallId);
      if (!call || data.success !== true) continue;

      const timestamp =
        typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
      yield {
        timestamp,
        kind: "edit-applied",
        capability: "file-edit",
        source: {
          assistantId: "github-copilot",
          adapterId: "copilot-cli-event-parser",
          rawSignal: "tool.execution_complete",
        },
        fileOperations: call.fileOperations,
        toolName: call.toolName,
        requestId: toolCallId,
        sessionId: this.sessionId,
        origin: "assistant-tool-edit",
        evidence: [
          {
            type: "copilot-cli-edit-tool",
            confidence: "high",
            requestId: toolCallId,
            sessionId: this.sessionId,
            timestamp,
            details: { toolName: call.toolName, turnId: call.turnId },
          },
        ],
        metadata: { model: call.model },
      };
    }
  }
}

type TailedCliSession = {
  tailer: Tailer;
  parser: CopilotCliEventParser;
};

/**
 * Runtime event source that polls the Copilot CLI session-state directory
 * for sessions belonging to the recorded repository and tails their
 * `events.jsonl` files. Sessions that already exist at start are only
 * followed from their current end, so earlier edits are not replayed.
 */
export class CopilotCliSessionWatcher
  implements AssistantRuntimeEventSource, vscode.Disposable
{
  private readonly sessions = new Map<string, TailedCliSession>();
  /** Session directories whose workspace.yaml was read; their `cwd` never changes. */
  private readonly checked = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly repoRoot: string,
    private readonly sessionStateDir = getCopilotCliSessionStateDir(),
    // Must stay well below ASSISTANT_EVENT_LAG_MS in staging-tracker.ts, or
    // CLI edits land in the editor long before their events are read.
    private readonly pollMs = 200
  ) {}

  async start(onEvent: (event: AssistantEvent) => void): Promise<vscode.Disposable> {
    await this.discoverSessions(true);
    this.pollTimer = setInterval(() => {
      void this.poll(onEvent);
    }, this.pollMs);
    return this;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const session of this.sessions.values()) {
      session.tailer.close();
    }
    this.sessions.clear();
  }

  /** Runs one discovery-and-tail pass; exposed for tests. */
  async poll(onEvent: (event: AssistantEvent) => void): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.discoverSessions(false);
      for (const session of this.sessions.values()) {
        for (const event of session.parser.feed(session.tailer.readNew())) {
          onEvent(event);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** Starts tailing sessions for this repo that have not been checked yet. */
  private async discoverSessions(initial: boolean): Promise<void> {
    for (const name of await listSessionDirNames(this.sessionStateDir)) {
      const dir = path.join(this.sessionStateDir, name);
      if (this.checked.has(dir)) continue;

      // Not marked as checked if unreadable: workspace.yaml may not exist yet.
      const session = await readCopilotCliSession(dir);
      if (!session) continue;
      if (!isSessionForRepo(session, this.repoRoot)) {
        this.checked.add(dir);
        continue;
      }

      const tailer = new Tailer(path.join(dir, "events.jsonl"));
      try {
        tailer.open();
        if (initial) tailer.startFromEnd();
      } catch {
        continue; // events.jsonl not written yet; retry on the next poll.
      }
      this.checked.add(dir);
      this.sessions.set(dir, { tailer, parser: new CopilotCliEventParser(name) });
    }
  }
}
