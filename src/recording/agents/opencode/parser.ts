import * as crypto from "crypto";
import * as path from "path";
import {
  AssistantCapability,
  AssistantEvent,
  AttributionEvidence,
  FileOperation,
  FileOperationKind,
} from "../../event";
import {
  hunkAddedText,
  hunkOldSideRange,
  parseUnifiedDiffHunks,
  ZeroBasedLineRange,
} from "./diff";

/** One JSONL record written by the generated Flight Recorder OpenCode plugin. */
type OpenCodePluginRecord = {
  fr?: number;
  ts?: number;
  kind?: string;
  tool?: string;
  sessionID?: string;
  messageID?: string;
  callID?: string;
  agent?: string;
  input?: Record<string, unknown>;
  status?: string;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: string;
  directory?: string;
  app?: { name?: string; version?: string; channel?: string };
  files?: unknown[];
  snapshot?: string;
};

/** OpenCode's `FileDiff.Info` as found in edit/patch tool results. */
type OpenCodeFileDiff = {
  file: string;
  patch?: string;
  status?: string;
  additions?: number;
  deletions?: number;
};

const ASSISTANT_ID = "opencode";
const ADAPTER_ID = "opencode-plugin-log-parser";
const FILE_EDIT_TOOLS = new Set(["edit", "write", "patch"]);
const COMMAND_TOOLS = new Set(["shell", "execute"]);

/** Hashes text the same way the staging tracker hashes observed insertions (sha256 hex). */
function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Narrows an unknown value to a plain object record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns a non-empty string value, or undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Maps an OpenCode tool name to its assistant capability category. */
function capabilityForTool(toolName: string): AssistantCapability {
  if (COMMAND_TOOLS.has(toolName)) {
    return "command";
  }
  return "tool-call";
}

/** Maps a `FileDiff.Info` status (added/deleted/modified) to a file operation kind. */
function operationKindFromDiffStatus(status: string | undefined): FileOperationKind {
  switch (status) {
    case "added":
      return "create";
    case "deleted":
      return "delete";
    case "modified":
      return "update";
    default:
      return "unknown";
  }
}

/** Maps a patch tool `applied[].type` (add/update/delete) to a file operation kind. */
function operationKindFromPatchType(type: string | undefined): FileOperationKind {
  switch (type) {
    case "add":
      return "create";
    case "update":
      return "update";
    case "delete":
      return "delete";
    default:
      return "unknown";
  }
}

/** Extracts the `FileDiff.Info` entries from a tool result, preferring metadata over output. */
function collectFileDiffs(record: OpenCodePluginRecord): OpenCodeFileDiff[] {
  const candidates = record.metadata?.files ?? record.output?.files;
  if (!Array.isArray(candidates)) {
    return [];
  }

  const diffs: OpenCodeFileDiff[] = [];
  for (const candidate of candidates) {
    const entry = asRecord(candidate);
    const file = asString(entry?.file);
    if (!entry || !file) {
      continue;
    }
    diffs.push({
      file,
      patch: asString(entry.patch),
      status: asString(entry.status),
      additions: typeof entry.additions === "number" ? entry.additions : undefined,
      deletions: typeof entry.deletions === "number" ? entry.deletions : undefined,
    });
  }
  return diffs;
}

/** Parses the file headers of an OpenCode `patch` tool `patchText` into file operations. */
function operationsFromPatchText(
  patchText: string,
  resolvePath: (candidate: string) => string
): FileOperation[] {
  const operations: FileOperation[] = [];
  const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/;

  for (const line of patchText.split(/\r?\n/)) {
    const match = header.exec(line.trim());
    if (!match) {
      continue;
    }
    const filePath = resolvePath(match[2].trim());
    switch (match[1]) {
      case "Add File":
      case "Move to":
        operations.push({ kind: "create", path: filePath });
        break;
      case "Update File":
        operations.push({ kind: "update", path: filePath });
        break;
      case "Delete File":
        operations.push({ kind: "delete", path: filePath });
        break;
    }
  }
  return operations;
}

/** Removes duplicate file operations (same kind and path) while keeping their order. */
function uniqueOperations(operations: FileOperation[]): FileOperation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    const key = `${operation.kind}\0${operation.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Parses the JSONL log written by the Flight Recorder OpenCode plugin into
 * assistant events. The parser is stateful: it remembers the session
 * directory (to resolve relative paths), which assistant messages ran
 * shell commands, and which files each message already edited through
 * file tools, so step snapshots only add files nothing else accounted for.
 */
export class OpenCodeParser {
  private partialLine = "";
  private directory: string | undefined;
  private opencodeVersion: string | undefined;
  private readonly seenRecords = new Set<string>();
  private readonly messagesWithCommands = new Set<string>();
  private readonly filesEditedByMessage = new Map<string, Set<string>>();

  /** Resolves an OpenCode path (absolute, or relative to the session directory) to an absolute path. */
  private resolvePath(candidate: string): string {
    return this.directory
      ? path.resolve(this.directory, candidate)
      : path.resolve(candidate);
  }

  /** Builds the fields shared by every event derived from one plugin record. */
  private baseEvent(record: OpenCodePluginRecord, rawSignal: string) {
    return {
      timestamp: new Date(record.ts ?? Date.now()).toISOString(),
      source: { assistantId: ASSISTANT_ID, adapterId: ADAPTER_ID, rawSignal },
      requestId: record.messageID,
      sessionId: record.sessionID,
      toolName: record.tool,
    };
  }

  /** Builds the metadata attached to every event, including the OpenCode version and tool-call id. */
  private baseMetadata(
    record: OpenCodePluginRecord,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      opencodeVersion: this.opencodeVersion,
      callId: record.callID,
      agent: record.agent,
      ...extra,
    };
  }

  /** Remembers that an assistant message touched the given files through a file tool. */
  private markEdited(messageId: string | undefined, operations: FileOperation[]): void {
    if (!messageId) {
      return;
    }
    const files = this.filesEditedByMessage.get(messageId) ?? new Set<string>();
    for (const operation of operations) {
      files.add(operation.path);
    }
    this.filesEditedByMessage.set(messageId, files);
  }

  /** Returns true the first time a record with this kind and tool-call id is seen (dedupes concurrent plugin instances). */
  private firstSighting(record: OpenCodePluginRecord): boolean {
    if (!record.callID) {
      return true;
    }
    const key = `${record.kind}\0${record.callID}`;
    if (this.seenRecords.has(key)) {
      return false;
    }
    this.seenRecords.add(key);
    return true;
  }

  /** Infers the file operations a file-edit tool call is about to perform from its input. */
  private operationsFromToolInput(record: OpenCodePluginRecord): FileOperation[] {
    const input = record.input ?? {};
    if (record.tool === "patch") {
      const patchText = asString(input.patchText);
      return patchText
        ? operationsFromPatchText(patchText, (candidate) => this.resolvePath(candidate))
        : [];
    }

    const filePath = asString(input.path) ?? asString(input.filePath);
    if (!filePath) {
      return [];
    }
    return [
      {
        kind: record.tool === "edit" ? "update" : "unknown",
        path: this.resolvePath(filePath),
      },
    ];
  }

  /** Builds attribution evidence (inserted-text hashes and pre-change ranges) for one edited file. */
  private evidenceForFile(
    record: OpenCodePluginRecord,
    filePath: string,
    diff: OpenCodeFileDiff | undefined,
    extraHashes: string[]
  ): AttributionEvidence {
    const editTextHashes = new Set(extraHashes);
    const ranges: ZeroBasedLineRange[] = [];

    for (const hunk of diff?.patch ? parseUnifiedDiffHunks(diff.patch) : []) {
      ranges.push(hunkOldSideRange(hunk));
      const added = hunkAddedText(hunk);
      if (added) {
        editTextHashes.add(hashText(added));
      }
    }

    return {
      type: "opencode-tool-result",
      confidence: editTextHashes.size > 0 || ranges.length > 0 ? "high" : "medium",
      requestId: record.messageID,
      sessionId: record.sessionID,
      path: filePath,
      timestamp: new Date(record.ts ?? Date.now()).toISOString(),
      details: {
        editTextHashes: Array.from(editTextHashes),
        ranges,
        callId: record.callID,
        additions: diff?.additions,
        deletions: diff?.deletions,
      },
    };
  }

  /** Converts a `pre` record (tool about to run) into an assistant event; file tools become deferred boundaries. */
  private eventFromPre(record: OpenCodePluginRecord): AssistantEvent {
    const toolName = record.tool ?? "unknown";
    if (COMMAND_TOOLS.has(toolName) && record.messageID) {
      this.messagesWithCommands.add(record.messageID);
    }

    return {
      ...this.baseEvent(record, `pre:${toolName}`),
      kind: "tool-called",
      capability: capabilityForTool(toolName),
      fileOperations: FILE_EDIT_TOOLS.has(toolName)
        ? this.operationsFromToolInput(record)
        : [],
      metadata: this.baseMetadata(record, { toolInput: record.input }),
    };
  }

  /** Converts a completed file-edit `post` record into a confirmed edit event with per-file evidence. */
  private editEventFromPost(record: OpenCodePluginRecord): AssistantEvent {
    const toolName = record.tool ?? "unknown";
    const input = record.input ?? {};
    const diffs = collectFileDiffs(record);
    const diffByPath = new Map(diffs.map((diff) => [this.resolvePath(diff.file), diff]));
    let operations: FileOperation[] = [];
    const extraHashes: string[] = [];

    if (toolName === "patch") {
      const applied = Array.isArray(record.output?.applied) ? record.output.applied : [];
      for (const candidate of applied) {
        const entry = asRecord(candidate);
        const target = asString(entry?.target) ?? asString(entry?.resource);
        if (target) {
          operations.push({
            kind: operationKindFromPatchType(asString(entry?.type)),
            path: this.resolvePath(target),
          });
        }
      }
    } else if (toolName === "write") {
      const target = asString(record.output?.target) ?? asString(input.path);
      if (target) {
        operations.push({
          kind: record.output?.existed === false ? "create" : "update",
          path: this.resolvePath(target),
        });
      }
      const content = asString(input.content);
      if (content) {
        extraHashes.push(hashText(content));
      }
    } else {
      for (const diff of diffs) {
        operations.push({
          kind: operationKindFromDiffStatus(diff.status),
          path: this.resolvePath(diff.file),
        });
      }
      const newString = asString(input.newString);
      if (newString) {
        extraHashes.push(hashText(newString));
      }
    }

    if (operations.length === 0) {
      operations = this.operationsFromToolInput(record);
    }
    operations = uniqueOperations(operations);
    this.markEdited(record.messageID, operations);

    return {
      ...this.baseEvent(record, `post:${toolName}`),
      kind: "edit-applied",
      capability: "file-edit",
      fileOperations: operations,
      origin: "assistant-tool-edit",
      evidence: operations
        .filter((operation) => operation.kind !== "delete")
        .map((operation) =>
          this.evidenceForFile(
            record,
            operation.path,
            diffByPath.get(operation.path),
            extraHashes
          )
        ),
      metadata: this.baseMetadata(record, {
        toolInput: record.input,
        toolOutput: record.output,
      }),
    };
  }

  /** Converts a `post` record (tool finished) into an assistant event. */
  private eventFromPost(record: OpenCodePluginRecord): AssistantEvent {
    const toolName = record.tool ?? "unknown";

    if (record.status === "completed" && FILE_EDIT_TOOLS.has(toolName)) {
      return this.editEventFromPost(record);
    }

    // Failed tools and non-editing tools carry no file operations; for a
    // failed file tool this also releases the boundary its `pre` opened.
    return {
      ...this.baseEvent(record, `post:${toolName}`),
      kind: "tool-called",
      capability: capabilityForTool(toolName),
      fileOperations: [],
      metadata: this.baseMetadata(record, {
        status: record.status,
        error: record.error,
      }),
    };
  }

  /**
   * Converts a `step` record (files OpenCode's snapshot saw change during
   * one model step) into an edit event, but only for steps that ran shell
   * commands and only for files no file tool already accounted for.
   */
  private eventFromStep(record: OpenCodePluginRecord): AssistantEvent | null {
    if (!record.messageID || !this.messagesWithCommands.has(record.messageID)) {
      return null;
    }

    const alreadyEdited = this.filesEditedByMessage.get(record.messageID) ?? new Set();
    const files = (record.files ?? [])
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map((candidate) => this.resolvePath(candidate))
      .filter((candidate) => !alreadyEdited.has(candidate));
    if (files.length === 0) {
      return null;
    }

    const operations = uniqueOperations(
      files.map((filePath) => ({ kind: "unknown" as const, path: filePath }))
    );

    return {
      ...this.baseEvent(record, "step:snapshot"),
      kind: "edit-applied",
      capability: "command",
      fileOperations: operations,
      origin: "assistant-tool-edit",
      evidence: operations.map((operation) => ({
        type: "opencode-step-snapshot",
        confidence: "medium",
        requestId: record.messageID,
        sessionId: record.sessionID,
        path: operation.path,
        timestamp: new Date(record.ts ?? Date.now()).toISOString(),
        details: { snapshot: record.snapshot },
      })),
      metadata: this.baseMetadata(record, { snapshot: record.snapshot }),
    };
  }

  /** Converts one plugin record into an assistant event, or null for bookkeeping records. */
  private eventFromRecord(record: OpenCodePluginRecord): AssistantEvent | null {
    switch (record.kind) {
      case "setup":
        this.directory = asString(record.directory) ?? this.directory;
        this.opencodeVersion = asString(record.app?.version) ?? this.opencodeVersion;
        return null;
      case "pre":
        return this.firstSighting(record) ? this.eventFromPre(record) : null;
      case "post":
        return this.firstSighting(record) ? this.eventFromPost(record) : null;
      case "step":
        return this.eventFromStep(record);
      default:
        return null;
    }
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

      const record = asRecord(payload);
      if (!record || typeof record.kind !== "string") {
        continue;
      }

      const event = this.eventFromRecord(record as OpenCodePluginRecord);
      if (event) {
        yield event;
      }
    }
  }
}
