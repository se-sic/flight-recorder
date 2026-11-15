// Shared helpers and styles for Flight Recorder's webviews (the recording
// history side panel and the edit history legend), so both look the same.

/** Escapes text for safe use in HTML content and attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Formats a timestamp (ms) relative to `now` ("just now", "5 min ago", ...), falling back to the local date for older ones. */
export function formatRelativeTime(time: number | null, now: number): string {
  if (time === null || Number.isNaN(time)) {
    return "unknown time";
  }
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  if (minutes < 24 * 60) {
    return `${Math.round(minutes / 60)} h ago`;
  }
  return new Date(time).toLocaleDateString();
}

/**
 * Styles shared by all Flight Recorder webviews: a header block with label
 * rows, section headings with a count badge, and a list of entry cards with
 * chips. Each webview sets its own `body` background.
 */
export const SHARED_WEBVIEW_CSS = `
      body {
        margin: 0;
        padding: 8px 12px 12px;
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }
      code {
        font-family: var(--vscode-editor-font-family);
        font-size: 0.95em;
        overflow-wrap: anywhere;
      }
      button {
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        padding: 2px 8px;
        border-radius: 2px;
        font: inherit;
        cursor: pointer;
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      select {
        min-width: 0;
        max-width: 100%;
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border);
        color: var(--vscode-dropdown-foreground);
        font: inherit;
        padding: 1px 4px;
        border-radius: 2px;
      }
      .status {
        display: grid;
        gap: 4px;
        padding-bottom: 10px;
        margin-bottom: 4px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .state {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
      }
      .row {
        display: grid;
        grid-template-columns: 60px 1fr;
        gap: 6px;
        align-items: center;
        min-width: 0;
      }
      .label, .time, .hint, .empty {
        color: var(--vscode-descriptionForeground);
      }
      h2 {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 14px 0 6px;
      }
      .count {
        font-size: 10px;
        letter-spacing: 0;
        line-height: 16px;
        min-width: 16px;
        padding: 0 4px;
        box-sizing: border-box;
        text-align: center;
        border-radius: 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .entries {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 4px;
      }
      .entry {
        padding: 5px 8px;
        border-left: 3px solid var(--vscode-descriptionForeground);
        border-radius: 2px;
        background: var(--vscode-list-hoverBackground, transparent);
      }
      .entry-top {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 2px 8px;
      }
      .kind { font-weight: 600; }
      .time { font-size: 0.9em; }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .chip {
        font-size: 0.85em;
        padding: 0 5px;
        border-radius: 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .empty {
        line-height: 1.45;
        padding-top: 8px;
      }
`;
