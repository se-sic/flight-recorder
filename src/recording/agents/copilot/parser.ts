import * as path from "path";
import { URL } from "url";
import {
  AssistantEvent,
  FileOperation,
} from "../../event";

const TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(\w+)\] \[([^\]]+)\] (.*)$/;
const ACCEPTED_RE = /\bghostText\.accepted\b(?:.*\bchoiceIndex:\s*(\d+)\b)?/;
const GET_COMPLETIONS_FILE_RE = /\bRequesting for\s+(file:\/\/\S+)/;
const GET_COMPLETIONS_LOCATION_RE = /\bat\s+(\d+):(\d+)\b/;

/** Converts a `file://` URI to a filesystem path (stripping the leading slash on Windows drive paths), or returns the input unchanged if it's not a valid file URI. */
export function fileUriToPath(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") {
      return uri;
    }

    // URL pathname is already decoded-ish; keep it robust
    let p = decodeURIComponent(u.pathname);

    // Windows: /C:/... => C:/...
    if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(p)) {
      p = p.slice(1);
    }
    return p;
  } catch {
    return uri;
  }
}

/** Parses GitHub Copilot Chat events (agent edit-tool patches and inline completion acceptances) from its debug log text, fed incrementally as raw chunks. */
export class CopilotLogParser {
  private lastRequestedFileUri: string | null = null;
  private lastRequestedCursorLine: number | null = null;
  private lastRequestedCursorColumn: number | null = null;
  private partialLine = "";

  /** Extracts the edit-tool payload JSON and request ID from a log line's tag/message, whichever of the two known formats it uses. */
  private getEditToolPayload(tag: string, msg: string): { payload: string; requestId: string } | null {
    if (tag.startsWith("edit-tool:")) {
      return { payload: msg, requestId: tag.slice("edit-tool:".length) };
    }

    const match = msg.match(/^\[edit-tool:([^\]]+)\]\s*(\[.*)$/);
    return match ? { requestId: match[1], payload: match[2] } : null;
  }

  /**
   * Extracts file operations from an edit-tool entry's input, which
   * different Copilot models emit in different shapes: a "*** Begin
   * Patch"-style string (parsed via regex), an object with explicit
   * path-like fields, or (as a last resort) any object whose string
   * values look like file paths.
   */
  private collectEditToolFileOperations(input: unknown): FileOperation[] {
    const operations: FileOperation[] = [];

    if (typeof input === "string") {
      const fileRe = /^\*\*\* (Update|Add|Delete) File:\s+(.+)$/gm;
      let match: RegExpExecArray | null;

      while ((match = fileRe.exec(input)) !== null) {
        const opKind = match[1];
        const candidate = match[2].trim();
        if (!candidate) {
          continue;
        }
        operations.push({
          kind:
            opKind === "Add"
              ? "create"
              : opKind === "Delete"
                ? "delete"
                : "update",
          path: path.resolve(candidate),
        });
      }

      return operations;
    }

    if (typeof input !== "object" || input === null) {
      return operations;
    }

    const inputObj = input as Record<string, unknown>;
    for (const key of ["filePath", "file", "path"]) {
      const val = inputObj[key];
      if (typeof val === "string" && val.trim()) {
        operations.push({
          kind: "update",
          path: path.resolve(val),
        });
      }
    }

    if (operations.length > 0) {
      return operations;
    }

    for (const val of Object.values(inputObj)) {
      if (typeof val === "string" && val.trim()) {
        if (val.includes(path.sep) || val.includes("/") || /\.\w+$/.test(val)) {
          operations.push({
            kind: "unknown",
            path: path.resolve(val),
          });
        }
      }
    }

    return operations;
  }

  /**
   * Yields one `edit-applied` event per edit-tool patch entry. Agent
   * edit-tool logs are explicit patch operations and must never be
   * treated as inline completions; unrecognized entry formats are
   * gracefully skipped rather than erroring.
   */
  private *parseEditToolEvents(ts: string, msg: string, requestId: string): Generator<AssistantEvent> {
    let payload: unknown;
    try {
      payload = JSON.parse(msg);
    } catch {
      return;
    }

    if (!Array.isArray(payload)) {
      return;
    }

    for (const entry of payload) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const input = (entry as { input?: unknown }).input;
      const fileOperations = this.collectEditToolFileOperations(input);
      if (fileOperations.length === 0) {
        continue;
      }

      yield {
        timestamp: ts,
        kind: "edit-applied",
        capability: "file-edit",
        source: {
          assistantId: "github-copilot",
          adapterId: "copilot-log-parser",
          rawSignal: "edit-tool",
        },
        fileOperations,
        requestId,
      };
    }
  }

  /** Yields a `suggestion-accepted` event when the message reports an accepted ghost-text completion, using the most recently requested file/cursor position. */
  private *parseInlineEvents(ts: string, msg: string): Generator<AssistantEvent> {
    const acceptedMatch = ACCEPTED_RE.exec(msg);
    if (!acceptedMatch) {
      return;
    }

    const cursorLine = this.lastRequestedCursorLine;
    const cursorColumn = this.lastRequestedCursorColumn;

    const ev: AssistantEvent = {
      timestamp: ts,
      kind: "suggestion-accepted",
      capability: "inline-completion",
      source: {
        assistantId: "github-copilot",
        adapterId: "copilot-log-parser",
        rawSignal: "ghostText.accepted",
      },
      fileOperations: [
        {
          kind: "update",
          path: fileUriToPath(
            this.lastRequestedFileUri ?? "unknown://copilot/no-file-context"
          ),
        },
      ],
      cursorPosition:
        cursorLine !== null
          ? {
              line: cursorLine,
              column: cursorColumn ?? 1,
            }
          : undefined,
    };

    yield ev;
  }

  /** Feeds a raw log text chunk (partial lines are buffered across calls) and yields the assistant events parsed from any complete lines. */
  *feed(chunk: string): Generator<AssistantEvent> {
    const combined = this.partialLine + chunk;
    const lines = combined.split(/\r?\n/);
    this.partialLine = lines.pop() ?? "";

    for (const line of lines) {
      const m = TS_RE.exec(line);
      if (!m) {
        continue;
      }

      const ts = m[1];
      const tag = m[3];
      const msg = m[4];

      const editToolPayload = this.getEditToolPayload(tag, msg);
      if (editToolPayload) {
        yield* this.parseEditToolEvents(ts, editToolPayload.payload, editToolPayload.requestId);
        continue;
      }

      if (tag === "getCompletions") {
        const reqFileMatch = GET_COMPLETIONS_FILE_RE.exec(msg);
        if (reqFileMatch) {
          this.lastRequestedFileUri = reqFileMatch[1].replace(/\.+$/, "");
        }

        const locationMatch = GET_COMPLETIONS_LOCATION_RE.exec(msg);
        if (locationMatch) {
          this.lastRequestedCursorLine = parseInt(locationMatch[1], 10) + 1;
          this.lastRequestedCursorColumn = parseInt(locationMatch[2], 10) + 1;
        }
      }

      if (tag === "postInsertion") {
        yield* this.parseInlineEvents(ts, msg);
      }
    }
  }
}
