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
