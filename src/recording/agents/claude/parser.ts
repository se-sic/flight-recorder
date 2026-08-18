import * as path from "path";
import {
  AssistantCapability,
  AssistantEvent,
  FileOperation,
} from "../../event";

type ClaudeHookEventPayload = {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  file_path?: string;
  event?: string;
  cwd?: string;
};

type ClaudeTranscriptEntry = Record<string, unknown>;

/** Extracts and resolves file path strings from a tool input value, checking common path-like field names and a `file_paths` array. */
function collectStringPaths(input: unknown): string[] {
  if (typeof input === "string" && input.trim()) {
    return [path.resolve(input)];
  }

  if (typeof input !== "object" || input === null) {
    return [];
  }

  const filePaths = new Set<string>();
  const inputObj = input as Record<string, unknown>;

  for (const key of [
    "file_path",
    "filePath",
    "path",
    "target_file",
    "targetFile",
    "new_path",
    "newPath",
    "old_path",
    "oldPath",
  ]) {
    const value = inputObj[key];
    if (typeof value === "string" && value.trim()) {
      filePaths.add(path.resolve(value));
    }
  }

  if (Array.isArray(inputObj.file_paths)) {
    for (const candidate of inputObj.file_paths) {
      if (typeof candidate === "string" && candidate.trim()) {
        filePaths.add(path.resolve(candidate));
      }
    }
  }

  return Array.from(filePaths).sort((left, right) => left.localeCompare(right));
}

/** Maps a Claude tool name to its assistant capability category (file edit, command, or generic tool call). */
function mapToolNameToCapability(toolName: string): AssistantCapability {
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return "file-edit";
  }
  if (toolName === "Bash") {
    return "command";
  }
  if (toolName.startsWith("mcp__")) {
    return "tool-call";
  }
  return "tool-call";
}

/** Infers file operations from a tool call's input paths, classifying the operation kind by tool name (Edit/MultiEdit -> update, Write/NotebookEdit -> unknown/update, other -> unknown). */
function inferFileOperationsFromTool(
  toolName: string,
  toolInput: Record<string, unknown> | undefined
): FileOperation[] {
  const paths = collectStringPaths(toolInput);
  const fileOperations: FileOperation[] = [];

  if (toolName === "Edit" || toolName === "MultiEdit") {
    for (const filePath of paths) {
      fileOperations.push({ kind: "update", path: filePath });
    }
    return fileOperations;
  }

  if (toolName === "Write") {
    for (const filePath of paths) {
      fileOperations.push({ kind: "unknown", path: filePath });
    }
    return fileOperations;
  }

  if (toolName === "NotebookEdit") {
    for (const filePath of paths) {
      fileOperations.push({ kind: "update", path: filePath });
    }
    return fileOperations;
  }

  for (const filePath of paths) {
    fileOperations.push({ kind: "unknown", path: filePath });
  }

  return fileOperations;
}

/** Maps a `FileChanged` hook payload's filesystem-watcher event type (add/unlink/change) to a file operation. */
function mapHookFileChangedOperation(payload: ClaudeHookEventPayload): FileOperation[] {
  if (!payload.file_path) {
    return [];
  }

  const resolved = path.resolve(payload.file_path);
  switch (payload.event) {
    case "add":
      return [{ kind: "create", path: resolved }];
    case "unlink":
      return [{ kind: "delete", path: resolved }];
    case "change":
      return [{ kind: "update", path: resolved }];
    default:
      return [{ kind: "unknown", path: resolved }];
  }
}

/**
 * Maps a `PostToolUse` hook's tool response to a confirmed file operation,
 * using the response's own file path/type fields when present, and
 * falling back to inferring from the tool's input otherwise.
 */
function mapHookToolResponseOperation(
  toolResponse: Record<string, unknown> | undefined,
  fallbackToolName: string,
  fallbackToolInput: Record<string, unknown> | undefined
): FileOperation[] {
  const responseFilePath =
    typeof toolResponse?.filePath === "string"
      ? toolResponse.filePath
      : typeof (toolResponse?.file as { filePath?: unknown } | undefined)?.filePath ===
          "string"
        ? ((toolResponse?.file as { filePath: string }).filePath)
        : undefined;

  if (!responseFilePath) {
    return inferFileOperationsFromTool(fallbackToolName, fallbackToolInput);
  }

  const resolved = path.resolve(responseFilePath);
  const responseType =
    typeof toolResponse?.type === "string" ? toolResponse.type : undefined;

  switch (responseType) {
    case "create":
      return [{ kind: "create", path: resolved }];
    case "update":
    case "replace":
      return [{ kind: "update", path: resolved }];
    case "delete":
      return [{ kind: "delete", path: resolved }];
    default:
      if (typeof toolResponse?.originalFile === "string") {
        return [{ kind: "update", path: resolved }];
      }
      return [{ kind: "unknown", path: resolved }];
  }
}

/** Builds an assistant event for a transcript `tool_use` block that is not a file-edit tool requiring deferred confirmation. */
function normalizeTranscriptToolUseEvent(
  timestamp: string,
  sessionId: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  rawSignal: string
): AssistantEvent {
  return {
    timestamp,
    kind: toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit"
      ? "edit-applied"
      : "tool-called",
    capability: mapToolNameToCapability(toolName),
    source: {
      assistantId: "claude-code",
      adapterId: "claude-transcript-parser",
      rawSignal,
    },
    fileOperations: inferFileOperationsFromTool(toolName, toolInput),
    sessionId,
    toolName,
    metadata: toolInput ? { toolInput } : undefined,
  };
}

/** Infers a file operation kind from a transcript `toolUseResult` object's shape. */
function inferOperationKindFromToolResult(
  toolResult: Record<string, unknown>
): FileOperation["kind"] {
  if (typeof toolResult.oldString === "string" && typeof toolResult.newString === "string") {
    return "update";
  }

  if (typeof toolResult.originalFile === "string") {
    return "update";
  }

  return "unknown";
}

/** Parses Claude Code events from either hook-log JSONL payloads or transcript JSONL entries, fed incrementally as raw text chunks. */
export class ClaudeCodeParser {
  private partialLine = "";

  /** Converts one hook-log JSON payload (FileChanged, PreToolUse, PostToolUse, PostToolUseFailure) into an assistant event, or null for unhandled hook events. */
  private eventFromHookPayload(payload: ClaudeHookEventPayload): AssistantEvent | null {
    const timestamp = new Date().toISOString();

    if (payload.hook_event_name === "FileChanged") {
      return {
        timestamp,
        kind: "edit-applied",
        capability: "file-edit",
        source: {
          assistantId: "claude-code",
          adapterId: "claude-hook-log-parser",
          rawSignal: "FileChanged",
        },
        fileOperations: mapHookFileChangedOperation(payload),
        sessionId: payload.session_id,
        metadata: {
          transcriptPath: payload.transcript_path,
          cwd: payload.cwd,
          event: payload.event,
        },
      };
    }

    if (
      payload.hook_event_name === "PreToolUse" ||
      payload.hook_event_name === "PostToolUse" ||
      payload.hook_event_name === "PostToolUseFailure"
    ) {
      const toolName = payload.tool_name ?? "unknown";
      const isFileEditTool =
        toolName === "Edit" ||
        toolName === "Write" ||
        toolName === "MultiEdit" ||
        toolName === "NotebookEdit";

      if (payload.hook_event_name === "PreToolUse" && isFileEditTool) {
        return {
          timestamp,
          kind: "tool-called",
          capability: "tool-call",
          source: {
            assistantId: "claude-code",
            adapterId: "claude-hook-log-parser",
            rawSignal: payload.hook_event_name,
          },
          fileOperations: inferFileOperationsFromTool(toolName, payload.tool_input),
          sessionId: payload.session_id,
          toolName,
          metadata: {
            transcriptPath: payload.transcript_path,
            cwd: payload.cwd,
            toolInput: payload.tool_input,
          },
        };
      }

      if (payload.hook_event_name === "PostToolUse" && isFileEditTool) {
        return {
          timestamp,
          kind: "edit-applied",
          capability: "file-edit",
          source: {
            assistantId: "claude-code",
            adapterId: "claude-hook-log-parser",
            rawSignal: payload.hook_event_name,
          },
          fileOperations: mapHookToolResponseOperation(
            payload.tool_response,
            toolName,
            payload.tool_input
          ),
          sessionId: payload.session_id,
          toolName,
          metadata: {
            transcriptPath: payload.transcript_path,
            cwd: payload.cwd,
            toolInput: payload.tool_input,
            toolResponse: payload.tool_response,
          },
        };
      }

      return {
        timestamp,
        kind: "tool-called",
        capability: mapToolNameToCapability(toolName),
        source: {
          assistantId: "claude-code",
          adapterId: "claude-hook-log-parser",
          rawSignal: payload.hook_event_name,
        },
        fileOperations: inferFileOperationsFromTool(toolName, payload.tool_input),
        sessionId: payload.session_id,
        toolName,
        metadata: {
          transcriptPath: payload.transcript_path,
          cwd: payload.cwd,
          toolInput: payload.tool_input,
        },
      };
    }

    return null;
  }

  /**
   * Converts one transcript JSONL entry into zero or more assistant
   * events: a confirmed `edit-applied` event from a successful
   * `toolUseResult`, plus `tool_use` content blocks (deferred for
   * file-edit tools until their result confirms success).
   */
  private eventFromTranscriptEntry(entry: unknown): AssistantEvent[] {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const result: AssistantEvent[] = [];
    const entryObj = entry as ClaudeTranscriptEntry;
    const sessionId =
      typeof entryObj.sessionId === "string"
        ? entryObj.sessionId
        : typeof entryObj.session_id === "string"
          ? entryObj.session_id
          : undefined;
    const timestampValue =
      typeof entryObj.timestamp === "string"
        ? entryObj.timestamp
        : typeof entryObj.timestamp === "number"
          ? new Date(entryObj.timestamp).toISOString()
          : typeof entryObj.createdAt === "string"
            ? entryObj.createdAt
            : new Date().toISOString();

    const toolUseResult =
      typeof entryObj.toolUseResult === "object" && entryObj.toolUseResult !== null
        ? (entryObj.toolUseResult as Record<string, unknown>)
        : null;
    const toolResultContent = Array.isArray(
      (entryObj.message as { role?: unknown; content?: unknown } | undefined)?.content
    )
      ? (
          (entryObj.message as { content: unknown[] }).content.find(
            (block) =>
              typeof block === "object" &&
              block !== null &&
              (block as { type?: unknown }).type === "tool_result"
          ) as Record<string, unknown> | undefined
        )
      : undefined;

    const toolResultFilePath =
      typeof toolUseResult?.filePath === "string"
        ? toolUseResult.filePath
        : typeof (toolUseResult?.file as { filePath?: unknown } | undefined)?.filePath ===
            "string"
          ? ((toolUseResult?.file as { filePath: string }).filePath)
          : undefined;

    const toolResultRejected =
      entryObj.toolDenialKind === "user-rejected" ||
      toolResultContent?.is_error === true;

    if (toolUseResult && toolResultFilePath && !toolResultRejected) {
      result.push({
        timestamp: timestampValue,
        kind: "edit-applied",
        capability: "file-edit",
        source: {
          assistantId: "claude-code",
          adapterId: "claude-transcript-parser",
          rawSignal: "transcript.tool_result",
        },
        fileOperations: [
          {
            kind: inferOperationKindFromToolResult(toolUseResult),
            path: path.resolve(toolResultFilePath),
          },
        ],
        sessionId,
        metadata: {
          structuredPatch: toolUseResult.structuredPatch,
          userModified: toolUseResult.userModified,
          replaceAll: toolUseResult.replaceAll,
        },
      });
    }

    const contentCandidates: unknown[] = [];
    if (Array.isArray(entryObj.content)) {
      contentCandidates.push(...entryObj.content);
    }
    if (
      typeof entryObj.message === "object" &&
      entryObj.message !== null &&
      Array.isArray((entryObj.message as { content?: unknown }).content)
    ) {
      contentCandidates.push(
        ...((entryObj.message as { content: unknown[] }).content)
      );
    }

    for (const candidate of contentCandidates) {
      if (typeof candidate !== "object" || candidate === null) {
        continue;
      }
      const block = candidate as Record<string, unknown>;
      if (block.type !== "tool_use") {
        continue;
      }

      const toolName =
        typeof block.name === "string" ? block.name : "unknown";
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : undefined;

      // File-edit tool requests become concrete edit events only after the
      // corresponding transcript tool_result confirms success. Still include
      // their target paths here so the staging tracker can move overlapping
      // workspace edits out of the open human bucket before the confirmed
      // tool_result arrives.
      if (
        toolName === "Edit" ||
        toolName === "Write" ||
        toolName === "MultiEdit" ||
        toolName === "NotebookEdit"
      ) {
        result.push({
          timestamp: timestampValue,
          kind: "tool-called",
          capability: "tool-call",
          source: {
            assistantId: "claude-code",
            adapterId: "claude-transcript-parser",
            rawSignal: "transcript.tool_use",
          },
          fileOperations: inferFileOperationsFromTool(toolName, toolInput),
          sessionId,
          toolName,
          metadata: toolInput ? { toolInput } : undefined,
        });
        continue;
      }

      result.push(
        normalizeTranscriptToolUseEvent(
          timestampValue,
          sessionId,
          toolName,
          toolInput,
          "transcript.tool_use"
        )
      );
    }

    if (
      result.length === 0 &&
      typeof entryObj.tool_name === "string"
    ) {
      result.push(
        normalizeTranscriptToolUseEvent(
          timestampValue,
          sessionId,
          entryObj.tool_name,
          typeof entryObj.tool_input === "object" && entryObj.tool_input !== null
            ? (entryObj.tool_input as Record<string, unknown>)
            : undefined,
          "transcript.tool_entry"
        )
      );
    }

    return result;
  }

  /** Feeds a raw text chunk (partial lines are buffered across calls) and yields the assistant events parsed from any complete lines. */
  *feed(chunk: string): Generator<AssistantEvent> {
    const combined = this.partialLine + chunk;
    const lines = combined.split(/\r?\n/);
    this.partialLine = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!payload) {
        continue;
      }

      if (
        typeof payload === "object" &&
        payload !== null &&
        "hook_event_name" in payload
      ) {
        const hookEvent = this.eventFromHookPayload(
          payload as ClaudeHookEventPayload
        );
        if (hookEvent) {
          yield hookEvent;
        }
        continue;
      }

      yield* this.eventFromTranscriptEntry(payload);
    }
  }
}
