import * as fs from "fs";
import * as path from "path";
import { URL, pathToFileURL } from "url";
import { CompletionEvent } from "./event";

const TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(\w+)\] \[([^\]]+)\] (.*)$/;
const ACCEPTED_RE = /\bghostText\.accepted\b(?:.*\bchoiceIndex:\s*(\d+)\b)?/;
const GET_COMPLETIONS_FILE_RE = /\bRequesting for\s+(file:\/\/\S+)/;
const GET_COMPLETIONS_LOCATION_RE = /\bat\s+(\d+):(\d+)\b/;

export function fileUriToPath(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") return uri;

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

export class CopilotLogParser {
  private lastRequestedFileUri: string | null = null;
  private lastRequestedCursorLine: number | null = null;
  private lastRequestedCursorColumn: number | null = null;
  private partialLine = "";

  private getEditToolPayload(tag: string, msg: string): { payload: string; requestId: string } | null {
    if (tag.startsWith("edit-tool:")) {
      return { payload: msg, requestId: tag.slice("edit-tool:".length) };
    }

    const match = msg.match(/^\[edit-tool:([^\]]+)\]\s*(\[.*)$/);
    return match ? { requestId: match[1], payload: match[2] } : null;
  }

  private collectEditToolPaths(input: unknown): Set<string> {
    const filePaths = new Set<string>();

    if (typeof input === "string") {
      const fileRe = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm;
      let match: RegExpExecArray | null;

      while ((match = fileRe.exec(input)) !== null) {
        const candidate = match[1].trim();
        if (!candidate) continue;
        filePaths.add(path.resolve(candidate));
      }

      return filePaths;
    }

    if (typeof input !== "object" || input === null) {
      return filePaths;
    }

    const inputObj = input as Record<string, unknown>;
    for (const key of ["filePath", "file", "path"]) {
      const val = inputObj[key];
      if (typeof val === "string" && val.trim()) {
        filePaths.add(path.resolve(val));
      }
    }

    if (filePaths.size > 0) {
      return filePaths;
    }

    for (const val of Object.values(inputObj)) {
      if (typeof val === "string" && val.trim()) {
        if (val.includes(path.sep) || val.includes("/") || /\.\w+$/.test(val)) {
          filePaths.add(path.resolve(val));
        }
      }
    }

    return filePaths;
  }

  private getInlinePayload(tag: string, msg: string): string | null {
    if (tag !== "postInsertion") {
      return null;
    }

    return msg;
  }

  // Agent edit-tool logs are explicit patch operations and must never be treated
  // as inline completions. Each patch entry is emitted as one event that can
  // include multiple files via files.
  //
  // Different LLM models emit different payload formats:
  // - Some produce string payloads with "*** Begin Patch" format (extract files from regex)
  // - Others produce object payloads with {filePath, oldString, newString} (extract filePath directly)
  // - Fallback: search any object for string values that look like file paths
  // The parser adapts transparently; unrecognized formats are gracefully skipped.
  private *parseEditToolEvents(ts: string, msg: string, requestId: string): Generator<CompletionEvent> {
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
      const filePaths = this.collectEditToolPaths(input);

      const files = Array.from(filePaths).sort((a, b) => a.localeCompare(b));
      if (files.length === 0) {
        continue;
      }

      const primaryPath = files[0];
      yield {
        timestamp: ts,
        fileUri: pathToFileURL(primaryPath).toString(),
        files,
        origin: "agent-edit",
        signal: "edit-tool",
        requestId,
      };
    }
  }

  private *parseInlineEvents(ts: string, msg: string): Generator<CompletionEvent> {
    const acceptedMatch = ACCEPTED_RE.exec(msg);
    if (!acceptedMatch) {
      return;
    }

    const fileUri =
      this.lastRequestedFileUri ?? "unknown://copilot/no-file-context";
    const filePath = fileUriToPath(fileUri);
    const files = [filePath];
    const cursorLine = this.lastRequestedCursorLine;
    const cursorColumn = this.lastRequestedCursorColumn;

    const ev: CompletionEvent = {
      timestamp: ts,
      fileUri,
      files,
      origin: "inline-completion",
      signal: "ghostText.accepted",
      ...(cursorLine !== null ? { cursorLine } : {}),
      ...(cursorColumn !== null ? { cursorColumn } : {}),
    };

    yield ev;
  }

  *feed(chunk: string): Generator<CompletionEvent> {
    const combined = this.partialLine + chunk;
    const lines = combined.split(/\r?\n/);
    this.partialLine = lines.pop() ?? "";

    for (const line of lines) {
      const m = TS_RE.exec(line);
      if (!m) continue;

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

      const inlinePayload = this.getInlinePayload(tag, msg);
      if (inlinePayload) {
        yield* this.parseInlineEvents(ts, inlinePayload);
      }
    }
  }
}

export class Tailer {
  private fd: number | null = null;
  private offset = 0;

  constructor(private filePath: string) {}

  startFromEnd() {
    const st = fs.statSync(this.filePath);
    this.offset = st.size;
  }

  open() {
    this.fd = fs.openSync(this.filePath, "r");
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  readNew(): string {
    if (this.fd === null) return "";
    const st = fs.statSync(this.filePath);
    if (st.size < this.offset) {
      // rotated/truncated
      this.offset = 0;
    }
    const len = st.size - this.offset;
    if (len <= 0) return "";

    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, this.offset);
    this.offset = st.size;
    return buf.toString("utf8");
  }
}

