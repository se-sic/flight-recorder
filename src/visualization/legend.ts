import * as path from "path";
import * as vscode from "vscode";
import { shortCommitHash } from "./ownership";
import type { buildCommitAgeEntriesFromRanges } from "./ownership";
import {
  COLORING_MODE_OPTIONS,
  type CommitDecorationPalette,
  type VisualizationColoringMode,
  eventOriginLabel,
  type EventOriginKind,
} from "./coloring";
import { SEQUENTIAL_PALETTES, QUALITATIVE_PALETTES } from "./palettes";

export type { VisualizationColoringMode, CommitDecorationPalette, EventOriginKind };

export type LegendPanelCallbacks = {
  onColoringModeChange: (mode: VisualizationColoringMode) => void;
  onPaletteChange: (value: string) => void;
  onDispose: () => void;
};

/** Formats a Unix author timestamp (seconds) as a locale date string, or "unknown date" if absent. */
function formatAuthorDate(authorTime: number | null): string {
  if (authorTime === null) {
    return "unknown date";
  }
  return new Date(authorTime * 1000).toLocaleString();
}

/** Escapes text for safe embedding in the legend webview's HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pluralizes a line count for display (e.g. "1 line" vs "3 lines"). */
function lineLabel(lineCount: number): string {
  return lineCount === 1 ? "1 line" : `${lineCount} lines`;
}

/** Describes a commit's position within the ranked commit list in human terms (oldest/newest/Nth of total). */
function rankLabel(rank: number, total: number): string {
  if (total <= 1) {
    return "only commit in file";
  }
  if (rank === 0) {
    return "oldest visible commit";
  }
  if (rank === total - 1) {
    return "newest visible commit";
  }
  return `${rank + 1} of ${total}`;
}

/** Builds the legend webview HTML for the empty state (no active visualization), showing the given reason. */
export function buildLegendEmptyHtml(reason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px;
      }
      .hint {
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <div class="hint">${escapeHtml(reason)}</div>
  </body>
</html>`;
}

/**
 * Builds the full legend webview HTML: the commit list (with swatches,
 * hashes, summaries, and authorship), the coloring-mode and palette
 * selectors, and the client-side script that posts selection changes back
 * to the extension and keeps the selected commit scrolled into view.
 */
export function buildLegendHtml(
  filePath: string,
  commits: ReturnType<typeof buildCommitAgeEntriesFromRanges>,
  paletteByCommit: Map<string, CommitDecorationPalette>,
  kindByCommit: Map<string, EventOriginKind> | null,
  coloringMode: VisualizationColoringMode,
  selectedPaletteValue: string,
  selectedCommitHash: string | null = null
): string {
  const items = commits.map((entry) => {
    const palette = paletteByCommit.get(entry.commitHash)!;
    const entryLabel = kindByCommit
      ? eventOriginLabel(kindByCommit.get(entry.commitHash) ?? "unknown")
      : rankLabel(entry.rank, entry.total);
    const itemClass =
      entry.commitHash === selectedCommitHash ? "item item-selected" : "item";
    return `<div class="${itemClass}">
      <div class="swatch" style="background:${palette.backgroundColor}; border-color:${palette.borderColor};"></div>
      <div class="meta">
        <div class="top">
          <span class="hash">${escapeHtml(shortCommitHash(entry.commitHash))}</span>
          <span class="rank">${escapeHtml(entryLabel)}</span>
        </div>
        <div class="summary">${escapeHtml(entry.summary || "No summary")}</div>
        <div class="detail">${escapeHtml(entry.author)} · ${escapeHtml(formatAuthorDate(entry.authorTime))}</div>
        <div class="detail">${escapeHtml(lineLabel(entry.lineCount))}</div>
      </div>
    </div>`;
  });

  const modeOptionsHtml = COLORING_MODE_OPTIONS
    .map(({ value, label, tooltip }) => {
      const selected = coloringMode === value ? "selected" : "";
      return `<option value="${value}" title="${escapeHtml(tooltip)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const paletteList = coloringMode === "event" ? QUALITATIVE_PALETTES : SEQUENTIAL_PALETTES;
  const paletteOptionsHtml = paletteList
    .map(({ value, label }) => {
      const selected = selectedPaletteValue === value ? "selected" : "";
      return `<option value="${value}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 12px;
      }
      .header {
        margin-bottom: 12px;
      }
      .title {
        font-weight: 600;
        margin-bottom: 4px;
      }
      .subtitle {
        color: var(--vscode-descriptionForeground);
        line-height: 1.4;
        word-break: break-word;
      }
      .controls {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 8px;
        align-items: center;
        margin-top: 10px;
      }
      .controls label {
        display: contents;
      }
      .controls label span {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        white-space: nowrap;
      }
      .controls select {
        min-width: 0;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        color: var(--vscode-input-foreground);
        font-size: 12px;
        padding: 2px 6px;
      }
      .item {
        display: grid;
        grid-template-columns: 18px 1fr;
        gap: 10px;
        align-items: start;
        padding: 8px 8px;
        border-top: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
      }
      .item:first-of-type {
        border-top: none;
      }
      .item-selected {
        background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 18%, transparent);
        outline: 1px solid color-mix(in srgb, var(--vscode-list-activeSelectionForeground) 38%, transparent);
        outline-offset: -1px;
      }
      .item-selected .hash,
      .item-selected .summary {
        color: var(--vscode-list-activeSelectionForeground);
      }
      .item-selected .rank,
      .item-selected .detail {
        color: color-mix(in srgb, var(--vscode-list-activeSelectionForeground) 82%, transparent);
      }
      .swatch {
        width: 18px;
        height: 18px;
        border: 1px solid;
        border-radius: 4px;
        margin-top: 2px;
      }
      .top {
        display: flex;
        gap: 8px;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .hash {
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
      }
      .rank, .detail, .subtitle {
        font-size: 12px;
      }
      .rank, .detail {
        color: var(--vscode-descriptionForeground);
      }
      .summary {
        margin-top: 2px;
        line-height: 1.35;
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="title">Edit History</div>
      <div class="subtitle">${escapeHtml(path.basename(filePath))}</div>
      <div class="controls">
        <label><span>Coloring</span><select id="coloring-mode">${modeOptionsHtml}</select></label>
        <label><span>Palette</span><select id="theme">${paletteOptionsHtml}</select></label>
      </div>
    </div>
    ${items.join("")}
    <script>
      const vscode = acquireVsCodeApi();
      const modeSelect = document.getElementById("coloring-mode");
      if (modeSelect) {
        modeSelect.addEventListener("change", () => {
          vscode.postMessage({ type: "setColoringMode", value: modeSelect.value });
        });
      }
      const themeSelect = document.getElementById("theme");
      if (themeSelect) {
        themeSelect.addEventListener("change", () => {
          vscode.postMessage({ type: "setPalette", value: themeSelect.value });
        });
      }
      requestAnimationFrame(() => {
        const selectedItem = document.querySelector(".item-selected");
        if (selectedItem) {
          const rect = selectedItem.getBoundingClientRect();
          if (rect.top < 0) {
            window.scrollBy({ top: rect.top, behavior: "instant" });
          } else if (rect.bottom > window.innerHeight) {
            window.scrollBy({ top: rect.bottom - window.innerHeight, behavior: "instant" });
          }
        }
      });
    </script>
  </body>
</html>`;
}

/** Sets the legend webview panel's HTML content, if the panel exists. */
export function setLegendHtml(
  panel: vscode.WebviewPanel | null,
  html: string
): void {
  if (!panel) {
    return;
  }
  panel.webview.html = html;
}

/**
 * Returns the existing legend panel, or creates and wires up a new one
 * (message handling for coloring-mode/palette changes, disposal callback)
 * if none exists yet.
 */
export function ensureLegendPanel(
  panel: vscode.WebviewPanel | null,
  extensionContext: vscode.ExtensionContext | null,
  callbacks: LegendPanelCallbacks
): vscode.WebviewPanel | null {
  if (panel) {
    return panel;
  }

  if (!extensionContext) {
    return null;
  }

  const created = vscode.window.createWebviewPanel(
    "flightRecorderEditHistoryLegend",
    "Edit History",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      enableFindWidget: false,
      retainContextWhenHidden: true,
    }
  );

  created.webview.onDidReceiveMessage((message) => {
    if (message?.type === "setColoringMode") {
      if (COLORING_MODE_OPTIONS.some((opt) => opt.value === message.value)) {
        callbacks.onColoringModeChange(message.value);
      }
    } else if (message?.type === "setPalette") {
      const allPalettes = [...SEQUENTIAL_PALETTES, ...QUALITATIVE_PALETTES];
      if (allPalettes.some((p) => p.value === message.value)) {
        callbacks.onPaletteChange(message.value);
      }
    }
  });

  created.onDidDispose(() => {
    callbacks.onDispose();
  });

  extensionContext.subscriptions.push(created);
  return created;
}
