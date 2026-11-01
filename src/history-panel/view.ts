import * as crypto from "crypto";
import type { RecordingBranchUiState } from "../recording/session";
import { RecordingHistory, RecordingHistoryEntry } from "./history";

/** Escapes text for safe use in HTML content and attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Formats an ISO date for display, tolerating invalid input. */
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }
  return date.toLocaleString();
}

/** Returns the card heading for a history entry. */
function kindLabel(entry: RecordingHistoryEntry): string {
  switch (entry.kind) {
    case "human":
      return "Human";
    case "assistant":
      return entry.origins.length > 0
        ? `Assistant: ${entry.origins.join(", ")}`
        : "Assistant";
    case "log":
      return "Log snapshot";
    case "chat":
      return "Chat export";
    case "unknown":
    default:
      return "Other";
  }
}

/** Summarizes an entry's files as one label. */
function fileLabel(files: string[]): string {
  if (files.length === 0) {
    return "No file metadata";
  }
  if (files.length === 1) {
    return files[0];
  }
  return `${files.length} files`;
}

/** Renders one history entry as a card. */
function buildEntryHtml(entry: RecordingHistoryEntry): string {
  const filePreview = entry.files.slice(0, 4)
    .map((file) => `<span class="file">${escapeHtml(file)}</span>`)
    .join("");
  const moreFiles = entry.files.length > 4
    ? `<span class="file muted">+${entry.files.length - 4} more</span>`
    : "";

  return `<article class="entry ${entry.kind}">
    <div class="entry-top">
      <span class="kind">${escapeHtml(kindLabel(entry))}</span>
      <span class="hash">${escapeHtml(entry.shortHash)}</span>
    </div>
    <div class="subject">${escapeHtml(entry.subject)}</div>
    <div class="meta">${escapeHtml(formatDate(entry.authorDate))} by ${escapeHtml(entry.author || "unknown author")}</div>
    <div class="meta">${escapeHtml(fileLabel(entry.files))}</div>
    <div class="files">${filePreview}${moreFiles}</div>
  </article>`;
}

/** Renders the branch, push and remote status block. */
function buildStatusHtml(
  state: RecordingBranchUiState,
  history: RecordingHistory | null
): string {
  const branch = state.displayBranchName ?? state.finalBranchName ?? "none";
  const status = state.isRecording
    ? "Recording"
    : state.finalized
      ? "Finalized"
      : "Idle";
  const pushStatus = state.isRecording
    ? "Push available after recording stops"
    : state.finalized
      ? "Ready to push"
      : "No finalized recording branch";
  const upstream = history?.upstream ?? "no upstream";
  const aheadBehind = history?.ahead === null || history?.behind === null
    ? "ahead/behind unknown"
    : `${history?.ahead ?? 0} ahead, ${history?.behind ?? 0} behind`;

  return `<section class="status">
    <div><span class="label">State</span><span>${escapeHtml(status)}</span></div>
    <div><span class="label">Branch</span><code>${escapeHtml(branch)}</code></div>
    <div><span class="label">Push</span><span>${escapeHtml(pushStatus)}</span></div>
    <div><span class="label">Remote</span><span>${escapeHtml(upstream)} (${escapeHtml(aheadBehind)})</span></div>
  </section>`;
}

/** Builds a notice with a Recover button when earlier recordings were never finalized. */
function buildUnfinishedHtml(
  unfinishedCount: number,
  isRecording: boolean
): string {
  if (unfinishedCount === 0) {
    return "";
  }

  return `<div class="notice unfinished">
    <span>${unfinishedCount} earlier recording(s) were not finalized.</span>
    <button id="recover" ${isRecording ? "disabled" : ""} title="${isRecording ? "Available after recording stops" : "Finalize unfinished recordings"}">Recover</button>
  </div>`;
}

/** Builds the complete webview HTML for the recording history panel. */
export function buildHtml(
  state: RecordingBranchUiState | null,
  history: RecordingHistory | null,
  message: string | null,
  unfinishedCount: number,
  cspSource: string,
  pushInProgress: boolean
): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const canPush = !!state && !state.isRecording && state.finalized && !!state.finalBranchName && !pushInProgress;
  const entries = history?.entries ?? [];
  const body = !state
    ? unfinishedCount > 0
      ? ""
      : `<div class="empty">Start a recording to see Flight Recorder history.</div>`
    : history === null
      ? `<div class="empty">No recording branch found yet.</div>`
      : entries.length === 0
        ? `<div class="empty">No recording commits found on this branch yet.</div>`
        : entries.map(buildEntryHtml).join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <style>
      body {
        margin: 0;
        padding: 12px;
        background: var(--vscode-sideBar-background);
        color: var(--vscode-sideBar-foreground);
        font-family: var(--vscode-font-family);
      }
      .toolbar {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 6px;
        align-items: center;
        margin-bottom: 10px;
      }
      .title {
        font-weight: 600;
        min-width: 0;
      }
      button {
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        padding: 3px 8px;
        border-radius: 4px;
        font: inherit;
        cursor: pointer;
      }
      button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      .status {
        display: grid;
        gap: 4px;
        padding: 8px 0 10px;
        border-bottom: 1px solid var(--vscode-panel-border);
        margin-bottom: 6px;
        font-size: 12px;
      }
      .status div {
        display: grid;
        grid-template-columns: 54px 1fr;
        gap: 8px;
        min-width: 0;
      }
      .label, .meta, .muted {
        color: var(--vscode-descriptionForeground);
      }
      code, .hash {
        font-family: var(--vscode-editor-font-family);
      }
      code {
        word-break: break-word;
      }
      .notice {
        color: var(--vscode-descriptionForeground);
        border-bottom: 1px solid var(--vscode-panel-border);
        padding-bottom: 8px;
        margin-bottom: 8px;
      }
      .unfinished {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      .entry {
        padding: 9px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .entry-top {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: baseline;
      }
      .kind {
        font-weight: 600;
      }
      .subject {
        line-height: 1.35;
        margin-top: 3px;
      }
      .meta {
        font-size: 12px;
        margin-top: 3px;
      }
      .files {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }
      .file {
        font-size: 11px;
        border: 1px solid var(--vscode-badge-background);
        border-radius: 4px;
        padding: 1px 5px;
        max-width: 100%;
        overflow-wrap: anywhere;
      }
      .empty {
        color: var(--vscode-descriptionForeground);
        line-height: 1.45;
        padding-top: 10px;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <div class="title">Recording History</div>
      <button id="refresh" title="Refresh">Refresh</button>
      <button id="push" class="primary" ${canPush ? "" : "disabled"} title="${canPush ? "Push finalized recording branch" : "Push is available after recording stops"}">Push</button>
    </div>
    ${state ? buildStatusHtml(state, history) : ""}
    ${buildUnfinishedHtml(unfinishedCount, !!state?.isRecording)}
    ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}
    ${body}
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById("refresh")?.addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });
      document.getElementById("push")?.addEventListener("click", () => {
        vscode.postMessage({ type: "push" });
      });
      document.getElementById("recover")?.addEventListener("click", () => {
        vscode.postMessage({ type: "recover" });
      });
    </script>
  </body>
</html>`;
}
