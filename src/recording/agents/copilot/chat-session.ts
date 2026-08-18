import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { AssistantEvent, FileOperation } from "../../event";
import { AssistantRuntimeEventSource } from "../../integration";
import { fileUriToPath } from "./parser";

type JsonObject = Record<string, unknown>;

type TraversalContext = {
  sessionId?: string;
  requestId?: string;
  timestamp?: string;
  prompt?: string;
};

type ProposedRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

const PATH_KEYS = new Set([
  "file",
  "filePath",
  "fileUri",
  "path",
  "resource",
  "resourceUri",
  "target",
  "uri",
]);

const TEXT_KEYS = new Set([
  "insertText",
  "newText",
  "replacementText",
  "text",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function firstString(obj: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function updateContextFromObject(
  ctx: TraversalContext,
  obj: JsonObject
): TraversalContext {
  return {
    sessionId:
      firstString(obj, [
        "sessionId",
        "session_id",
        "session",
        "chatId",
        "conversationId",
      ]) ?? ctx.sessionId,
    requestId:
      firstString(obj, ["requestId", "request_id", "turnId", "id"]) ??
      ctx.requestId,
    timestamp:
      normalizeTimestamp(
        obj.timestamp ??
          obj.createdAt ??
          obj.completedAt ??
          obj.responseCompletedAt ??
          obj.lastModified
      ) ?? ctx.timestamp,
    prompt:
      firstString(obj, ["prompt", "messageText", "userMessage", "input"]) ??
      ctx.prompt,
  };
}

function looksLikeFileReference(value: string): boolean {
  return (
    value.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    (value.includes("/") && /\.[A-Za-z0-9_-]+(?:[#?].*)?$/.test(value))
  );
}

function collectPathCandidates(value: unknown, parentKey = ""): string[] {
  const paths = new Set<string>();

  const visit = (candidate: unknown, key: string) => {
    if (typeof candidate === "string") {
      if (PATH_KEYS.has(key) && looksLikeFileReference(candidate)) {
        paths.add(fileUriToPath(candidate));
      }
      return;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, key);
      }
      return;
    }

    if (!isObject(candidate)) {
      return;
    }

    for (const [childKey, childValue] of Object.entries(candidate)) {
      visit(childValue, childKey);
    }
  };

  visit(value, parentKey);
  return Array.from(paths).sort((left, right) => left.localeCompare(right));
}

function collectInsertedTexts(value: unknown, parentKey = ""): string[] {
  const texts: string[] = [];

  const visit = (candidate: unknown, key: string) => {
    if (typeof candidate === "string") {
      if (TEXT_KEYS.has(key) && candidate.length > 0) {
        texts.push(candidate);
      }
      return;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, key);
      }
      return;
    }

    if (!isObject(candidate)) {
      return;
    }

    for (const [childKey, childValue] of Object.entries(candidate)) {
      visit(childValue, childKey);
    }
  };

  visit(value, parentKey);
  return texts;
}

function normalizeRangeObject(value: unknown): ProposedRange | null {
  if (!isObject(value)) {
    return null;
  }

  const start = isObject(value.start) ? value.start : undefined;
  const end = isObject(value.end) ? value.end : undefined;

  const startLine =
    typeof value.startLineNumber === "number"
      ? value.startLineNumber - 1
      : typeof value.startLine === "number"
        ? value.startLine
        : typeof start?.line === "number"
          ? start.line
          : typeof start?.lineNumber === "number"
            ? start.lineNumber - 1
            : undefined;
  const startColumn =
    typeof value.startColumn === "number"
      ? value.startColumn - 1
      : typeof value.startCharacter === "number"
        ? value.startCharacter
        : typeof start?.character === "number"
          ? start.character
          : typeof start?.column === "number"
            ? start.column - 1
            : undefined;
  const endLine =
    typeof value.endLineNumber === "number"
      ? value.endLineNumber - 1
      : typeof value.endLine === "number"
        ? value.endLine
        : typeof end?.line === "number"
          ? end.line
          : typeof end?.lineNumber === "number"
            ? end.lineNumber - 1
            : startLine;
  const endColumn =
    typeof value.endColumn === "number"
      ? value.endColumn - 1
      : typeof value.endCharacter === "number"
        ? value.endCharacter
        : typeof end?.character === "number"
          ? end.character
          : typeof end?.column === "number"
            ? end.column - 1
            : startColumn;

  if (
    startLine === undefined ||
    startColumn === undefined ||
    endLine === undefined ||
    endColumn === undefined
  ) {
    return null;
  }

  return { startLine, startColumn, endLine, endColumn };
}

function collectRanges(value: unknown, parentKey = ""): ProposedRange[] {
  const ranges: ProposedRange[] = [];

  const visit = (candidate: unknown, key: string) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, key);
      }
      return;
    }

    if (!isObject(candidate)) {
      return;
    }

    if (key === "range" || key === "ranges" || key === "edit") {
      const normalized = normalizeRangeObject(candidate);
      if (normalized) {
        ranges.push(normalized);
      }
    }

    for (const [childKey, childValue] of Object.entries(candidate)) {
      visit(childValue, childKey);
    }
  };

  visit(value, parentKey);
  return ranges;
}

function isTextEditGroup(obj: JsonObject): boolean {
  return obj.kind === "textEditGroup" || obj.type === "textEditGroup";
}

function parseJsonPayloads(content: string): unknown[] {
  try {
    return [JSON.parse(content)];
  } catch {
    const payloads: unknown[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        payloads.push(JSON.parse(line));
      } catch {
        // Partially written JSONL lines are normal while VS Code flushes.
      }
    }
    return payloads;
  }
}

export class CopilotChatSessionParser {
  private readonly seenEventIds = new Set<string>();

  parse(content: string, sourcePath?: string): AssistantEvent[] {
    const events: AssistantEvent[] = [];
    for (const payload of parseJsonPayloads(content)) {
      this.collectEvents(payload, {}, events, sourcePath);
    }
    return events;
  }

  private collectEvents(
    value: unknown,
    ctx: TraversalContext,
    events: AssistantEvent[],
    sourcePath?: string
  ): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectEvents(item, ctx, events, sourcePath);
      }
      return;
    }

    if (!isObject(value)) {
      return;
    }

    const nextCtx = updateContextFromObject(ctx, value);

    if (isTextEditGroup(value)) {
      const filePaths = collectPathCandidates(value);
      if (filePaths.length > 0) {
        const insertedTexts = collectInsertedTexts(value);
        const editTextHashes = insertedTexts.map(hashText);
        const ranges = collectRanges(value);
        const timestamp = nextCtx.timestamp ?? new Date().toISOString();
        const eventId = hashText(
          JSON.stringify({
            sourcePath,
            sessionId: nextCtx.sessionId,
            requestId: nextCtx.requestId,
            timestamp,
            filePaths,
            editTextHashes,
            ranges,
          })
        );

        if (!this.seenEventIds.has(eventId)) {
          this.seenEventIds.add(eventId);
          events.push(
            this.eventFromTextEditGroup(
              value,
              filePaths,
              editTextHashes,
              ranges,
              timestamp,
              nextCtx,
              sourcePath
            )
          );
        }
      }
    }

    for (const child of Object.values(value)) {
      this.collectEvents(child, nextCtx, events, sourcePath);
    }
  }

  private eventFromTextEditGroup(
    rawTextEditGroup: JsonObject,
    filePaths: string[],
    editTextHashes: string[],
    ranges: ProposedRange[],
    timestamp: string,
    ctx: TraversalContext,
    sourcePath?: string
  ): AssistantEvent {
    const fileOperations: FileOperation[] = filePaths.map((filePath) => ({
      kind: "update",
      path: path.resolve(filePath),
    }));

    return {
      timestamp,
      kind: "edit-applied",
      capability: "file-edit",
      source: {
        assistantId: "github-copilot",
        adapterId: "copilot-chat-session-parser",
        rawSignal: "textEditGroup",
      },
      fileOperations,
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      origin: "assistant-agent-chat",
      evidence: [
        {
          type: "copilot-chat-text-edit-group",
          confidence: editTextHashes.length > 0 ? "high" : "medium",
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          timestamp,
          details: {
            editTextHashes,
            ranges,
            fileCount: filePaths.length,
            sourcePath,
            done: rawTextEditGroup.done,
            state: rawTextEditGroup.state,
          },
        },
      ],
      metadata: {
        prompt: ctx.prompt,
        sourcePath,
        textEditGroupKind: rawTextEditGroup.kind ?? rawTextEditGroup.type,
      },
    };
  }
}

export class CopilotChatSessionWatcher
  implements AssistantRuntimeEventSource, vscode.Disposable
{
  private readonly parser = new CopilotChatSessionParser();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly debounceMs = 1000
  ) {}

  start(onEvent: (event: AssistantEvent) => void): vscode.Disposable {
    const chatSessionsDir = this.getChatSessionsDir();
    if (!chatSessionsDir) {
      return this;
    }

    if (fs.existsSync(chatSessionsDir)) {
      this.primeExistingSessions(chatSessionsDir);
      this.watchDirectory(chatSessionsDir, onEvent);
    } else {
      this.pollTimer = setInterval(() => {
        if (fs.existsSync(chatSessionsDir)) {
          this.clearPollTimer();
          this.primeExistingSessions(chatSessionsDir);
          this.watchDirectory(chatSessionsDir, onEvent);
        }
      }, 5000);
    }

    return this;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    this.clearPollTimer();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private getChatSessionsDir(): string | null {
    const storageUri = this.context.storageUri;
    if (!storageUri) {
      return null;
    }

    return path.join(path.dirname(storageUri.fsPath), "chatSessions");
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private primeExistingSessions(dir: string): void {
    for (const filePath of this.listSessionFiles(dir)) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        this.parser.parse(content, filePath);
      } catch {
        // Existing chat files are best-effort context; startup should not fail.
      }
    }
  }

  private watchDirectory(
    dir: string,
    onEvent: (event: AssistantEvent) => void
  ): void {
    if (this.disposed || this.watcher) {
      return;
    }

    this.watcher = fs.watch(dir, (_eventType, filename) => {
      if (!filename) {
        return;
      }

      const filePath = path.join(dir, filename.toString());
      if (!this.isSessionFile(filePath)) {
        return;
      }
      this.scheduleParse(filePath, onEvent);
    });
  }

  private scheduleParse(
    filePath: string,
    onEvent: (event: AssistantEvent) => void
  ): void {
    const existing = this.timers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timers.delete(filePath);
      this.parseFile(filePath, onEvent);
    }, this.debounceMs);
    this.timers.set(filePath, timer);
  }

  private parseFile(
    filePath: string,
    onEvent: (event: AssistantEvent) => void
  ): void {
    if (this.disposed) {
      return;
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      for (const event of this.parser.parse(content, filePath)) {
        onEvent(event);
      }
    } catch (err) {
      void err;
    }
  }

  private listSessionFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir)
        .map((name) => path.join(dir, name))
        .filter((filePath) => this.isSessionFile(filePath));
    } catch {
      return [];
    }
  }

  private isSessionFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith(".json") || lower.endsWith(".jsonl");
  }
}
