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

export type FileOperationKind =
  | "create"
  | "update"
  | "delete"
  | "rename"
  | "unknown";

export type CursorPosition = {
  line: number;
  column: number;
};

export type FileOperation = {
  kind: FileOperationKind;
  path?: string;
  oldPath?: string;
  newPath?: string;
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
  metadata?: Record<string, unknown>;
};

function normalizeFilePath(candidate: string): string {
  return path.resolve(candidate);
}

export function collectEventFilePaths(ev: AssistantEvent): string[] {
  const filePaths = new Set<string>();

  for (const operation of ev.fileOperations) {
    if (operation.path) {
      filePaths.add(normalizeFilePath(operation.path));
    }
    if (operation.oldPath) {
      filePaths.add(normalizeFilePath(operation.oldPath));
    }
    if (operation.newPath) {
      filePaths.add(normalizeFilePath(operation.newPath));
    }
  }

  return Array.from(filePaths).sort((left, right) => left.localeCompare(right));
}

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

function formatFileOperation(
  operation: FileOperation,
  repoRoot?: string
): FileOperation {
  const normalizeForOutput = (candidate?: string): string | undefined => {
    if (!candidate) {
      return undefined;
    }

    if (!repoRoot) {
      return normalizeFilePath(candidate);
    }

    const absolute = normalizeFilePath(candidate);
    const absRepo = path.resolve(repoRoot);
    if (absolute === absRepo || absolute.startsWith(absRepo + path.sep)) {
      return path.relative(repoRoot, absolute).split(path.sep).join("/");
    }

    return absolute;
  };

  return {
    kind: operation.kind,
    path: normalizeForOutput(operation.path),
    oldPath: normalizeForOutput(operation.oldPath),
    newPath: normalizeForOutput(operation.newPath),
  };
}

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
    requestId: ev.requestId,
    sessionId: ev.sessionId,
    toolName: ev.toolName,
    metadata: ev.metadata,
  };

  return JSON.stringify(payload);
}
