import * as crypto from "crypto";
import type { RecordingBranchUiState } from "../recording/session";
import { RecordingHistory, RecordingHistoryEntry } from "./history";
import { escapeHtml, formatRelativeTime, SHARED_WEBVIEW_CSS } from "../utils/webview";

const MAX_FILE_CHIPS = 4;

/**
 * Turns an origin like `assistant-tool-edit` into `tool edit`. Edits without
 * a known origin come from shell commands, MCP tools or subagents.
 */
function originLabel(origin: string): string {
  if (origin === "assistant-unknown") {
    return "other tool";
  }
  return origin.replace(/^assistant-/, "").replace(/-/g, " ");
}

/** Returns the card heading for a history entry. */
function kindLabel(entry: RecordingHistoryEntry): string {
  switch (entry.kind) {
    case "human":
      return "Human edit";
    case "assistant":
      return entry.origins.length > 0
        ? `Assistant · ${entry.origins.map(originLabel).join(", ")}`
        : "Assistant edit";
    case "log":
      return "Assistant log";
    case "chat":
      return "Chat export";
    case "unknown":
    default:
      return entry.subject;
  }
}

/** Renders one history entry as a card; details that are the same for every entry go into its tooltip. */
function buildEntryHtml(entry: RecordingHistoryEntry, now: number): string {
  const tooltip = `${entry.shortHash} · ${new Date(entry.authorDate).toLocaleString()} · ${entry.author || "unknown author"}\n${entry.subject}`;
  const chips = entry.files.slice(0, MAX_FILE_CHIPS)
    .map((file) => `<span class="chip" title="${escapeHtml(file)}">${escapeHtml(file.split("/").pop() || file)}</span>`)
    .join("");
  const more = entry.files.length > MAX_FILE_CHIPS
    ? `<span class="chip" title="${escapeHtml(entry.files.slice(MAX_FILE_CHIPS).join("\n"))}">+${entry.files.length - MAX_FILE_CHIPS}</span>`
    : "";

  return `<li class="entry ${entry.kind}" title="${escapeHtml(tooltip)}">
    <div class="entry-top">
      <span class="kind">${escapeHtml(kindLabel(entry))}</span>
      <span class="time">${escapeHtml(formatRelativeTime(Date.parse(entry.authorDate), now))}</span>
    </div>
    ${chips || more ? `<div class="chips">${chips}${more}</div>` : ""}
  </li>`;
}

/** Renders a titled list of entries, or nothing if it is empty. */
function buildSectionHtml(title: string, entries: RecordingHistoryEntry[], now: number): string {
  if (entries.length === 0) {
    return "";
  }
  return `<section>
    <h2><span>${title}</span><span class="count" title="${entries.length} commit(s)">${entries.length}</span></h2>
    <ul class="entries">${entries.map((entry) => buildEntryHtml(entry, now)).join("")}</ul>
  </section>`;
}

/** Renders the recording state, branch and remote status. */
function buildStatusHtml(
  state: RecordingBranchUiState,
  history: RecordingHistory | null
): string {
  const assistant = state.assistantDisplayName ? ` with ${escapeHtml(state.assistantDisplayName)}` : "";
  const [stateClass, stateText] = state.isRecording
    ? ["recording", `Recording${assistant}`]
    : state.finalized
      ? ["saved", "Recording saved"]
      : ["idle", "Recording not finalized"];

  if (state.commitMode === "currentBranch") {
    return `<header class="status">
      <div class="state ${stateClass}"><span class="dot"></span>${stateText}</div>
      <div class="hint">Commits go directly onto your current branch; see Source Control.</div>
    </header>`;
  }

  const branch = state.finalBranchName ?? state.displayBranchName ?? "none";
  let remote: string;
  if (!history?.upstream) {
    remote = state.finalized && !state.isRecording
      ? `Not pushed yet. Push it like any branch, e.g. <code>git push -u origin ${escapeHtml(branch)}</code>`
      : "Not pushed yet";
  } else {
    const counts = history.ahead === null || history.behind === null
      ? ""
      : history.ahead === 0 && history.behind === 0
        ? " · up to date"
        : ` · ${history.ahead} ahead, ${history.behind} behind`;
    remote = `Pushed to <code>${escapeHtml(history.upstream)}</code>${counts}`;
  }

  const visualize = history && history.entries.length > 0
    ? `<button id="visualize" title="Color the lines of the open file by the recording commit that last changed them">Show edit history in editor</button>`
    : "";
  return `<header class="status">
    <div class="state ${stateClass}"><span class="dot"></span>${stateText}</div>
    <div class="row"><span class="label">Branch</span><code>${escapeHtml(branch)}</code></div>
    <div class="row"><span class="label">Remote</span><span>${remote}</span></div>
    ${visualize}
  </header>`;
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

/** Builds the main content: the commit sections, or a hint about what to do next. */
function buildBodyHtml(
  state: RecordingBranchUiState | null,
  history: RecordingHistory | null,
  unfinishedCount: number,
  now: number
): string {
  if (!state) {
    return unfinishedCount > 0
      ? ""
      : `<div class="empty">No recording for this branch yet. Click <b>Start Flight Recorder</b> in the status bar to begin.</div>`;
  }
  if (state.commitMode === "currentBranch") {
    return "";
  }
  const entries = history?.entries ?? [];
  if (entries.length === 0) {
    return `<div class="empty">${state.isRecording ? "Waiting for the first change." : "This recording has no commits."}</div>`;
  }

  return buildSectionHtml("Current recording", entries.filter((entry) => !entry.saved), now) +
    buildSectionHtml("Saved", entries.filter((entry) => entry.saved), now);
}

/** Builds the complete webview HTML for the recording history panel. */
export function buildHtml(
  state: RecordingBranchUiState | null,
  history: RecordingHistory | null,
  message: string | null,
  unfinishedCount: number,
  cspSource: string,
  now = Date.now()
): string {
  const nonce = crypto.randomBytes(16).toString("base64");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <style>
${SHARED_WEBVIEW_CSS}
      body {
        background: var(--vscode-sideBar-background);
        color: var(--vscode-sideBar-foreground);
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
        background: var(--vscode-descriptionForeground);
      }
      .recording .dot { background: var(--vscode-charts-red); }
      .saved .dot { background: var(--vscode-charts-green); }
      .notice {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 6px;
        padding: 8px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .entry.human { border-left-color: var(--vscode-charts-blue); }
      .entry.assistant { border-left-color: var(--vscode-charts-purple); }
      #visualize {
        justify-self: start;
        margin-top: 4px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      #visualize:hover {
        background: var(--vscode-button-hoverBackground);
      }
    </style>
  </head>
  <body>
    ${state ? buildStatusHtml(state, history) : ""}
    ${buildUnfinishedHtml(unfinishedCount, !!state?.isRecording)}
    ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}
    ${buildBodyHtml(state, history, unfinishedCount, now)}
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById("recover")?.addEventListener("click", () => {
        vscode.postMessage({ type: "recover" });
      });
      document.getElementById("visualize")?.addEventListener("click", () => {
        vscode.postMessage({ type: "visualize" });
      });
    </script>
  </body>
</html>`;
}
