import * as path from "path";

export type AssistantCapability =
  | "inline-completion"
  | "file-edit"
  | "tool-call"
  | "chat"
  | "command"
  | "unknown";

export type AssistantEventKind =
  | "suggestion-accepted"
  | "edit-applied"
  | "tool-called"
  | "response-produced"
  | "unknown";

export type FileOperationKind = "create" | "update" | "delete" | "unknown";

export type CursorPosition = {
  line: number;
  column: number;
};

export type FileOperation = {
  kind: FileOperationKind;
  path: string;
};

export type EditOrigin =
  | "human"
  | "assistant-inline-completion"
  | "assistant-agent-chat"
  | "assistant-tool-edit"
  | "assistant-unknown"
  | "mixed";

export type AttributionEvidence = {
  type: string;
  confidence?: "high" | "medium" | "low";
  requestId?: string;
  sessionId?: string;
  path?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
};

export type AssistantSource = {
  assistantId: string;
  adapterId: string;
  rawSignal: string;
};

export type AssistantEvent = {
  timestamp: string;
  kind: AssistantEventKind;
  capability: AssistantCapability;
  source: AssistantSource;
  fileOperations: FileOperation[];
  requestId?: string;
  sessionId?: string;
  toolName?: string;
  cursorPosition?: CursorPosition;
  origin?: EditOrigin;
  evidence?: AttributionEvidence[];
  metadata?: Record<string, unknown>;
};

/** Resolves a path to a normalized absolute form. */
function normalizeFilePath(candidate: string): string {
  return path.resolve(candidate);
}

/** Collects the sorted, deduplicated, absolute file paths touched by an assistant event's file operations. */
export function collectEventFilePaths(ev: AssistantEvent): string[] {
  const filePaths = new Set(
    ev.fileOperations.map((operation) => normalizeFilePath(operation.path))
  );

  return Array.from(filePaths).sort((left, right) => left.localeCompare(right));
}

/** Returns an event's touched file paths relative to the repo root (or absolute if no repo root is given, or a placeholder if none fall under it). */
function relativePathsForEvent(
  ev: AssistantEvent,
  repoRoot?: string
): string[] {
  const absolutePaths = collectEventFilePaths(ev);
  if (!repoRoot) {
    return absolutePaths;
  }

  const absRepo = path.resolve(repoRoot);
  const relFiles = absolutePaths
    .filter((abs) => abs === absRepo || abs.startsWith(absRepo + path.sep))
    .map((abs) => path.relative(repoRoot, abs))
    .map((rel) => rel.split(path.sep).join("/"));

  return relFiles.length > 0 ? relFiles : ["<file-outside-repo>"];
}

/** Formats a single file operation's path for output: relative to the repo root when it falls under it, otherwise absolute. */
function formatFileOperation(
  operation: FileOperation,
  repoRoot?: string
): FileOperation {
  const absolute = normalizeFilePath(operation.path);
  if (!repoRoot) {
    return { kind: operation.kind, path: absolute };
  }

  const absRepo = path.resolve(repoRoot);
  const formattedPath =
    absolute === absRepo || absolute.startsWith(absRepo + path.sep)
      ? path.relative(repoRoot, absolute).split(path.sep).join("/")
      : absolute;

  return { kind: operation.kind, path: formattedPath };
}

/** Serializes an assistant event to the JSON line format used in commit messages, with repo-relative file paths. */
export function formatAssistantEventJson(
  ev: AssistantEvent,
  repoRoot?: string
): string {
  const payload: Record<string, unknown> = {
    timestamp: ev.timestamp,
    kind: ev.kind,
    capability: ev.capability,
    source: ev.source,
    files: relativePathsForEvent(ev, repoRoot),
    fileOperations: ev.fileOperations.map((operation) =>
      formatFileOperation(operation, repoRoot)
    ),
    cursorPosition: ev.cursorPosition,
    origin: ev.origin,
    evidence: ev.evidence,
    requestId: ev.requestId,
    sessionId: ev.sessionId,
    toolName: ev.toolName,
    metadata: ev.metadata,
  };

  return JSON.stringify(payload);
}
