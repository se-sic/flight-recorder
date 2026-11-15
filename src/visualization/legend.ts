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
import { escapeHtml, formatRelativeTime, SHARED_WEBVIEW_CSS } from "../utils/webview";

export type { VisualizationColoringMode, CommitDecorationPalette, EventOriginKind };

export type LegendPanelCallbacks = {
  onColoringModeChange: (mode: VisualizationColoringMode) => void;
  onPaletteChange: (value: string) => void;
  onDispose: () => void;
};

/**
 * Shortens a commit subject for a card heading: drops the "Flight Recorder:"
 * prefix, the file count and the JSON metadata git folds into the subject.
 */
function commitTitle(summary: string): string {
  const title = summary
    .replace(/\s*\{.*$/, "")
    .replace(/^Flight Recorder:\s*/, "")
    .replace(/\s*\(\d+ files?\)$/, "")
    .trim();
  return title ? title[0].toUpperCase() + title.slice(1) : "No summary";
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
${SHARED_WEBVIEW_CSS}
      body { background: var(--vscode-editor-background); }
    </style>
  </head>
  <body>
    <div class="empty">${escapeHtml(reason)}</div>
  </body>
</html>`;
}

/**
 * Builds the full legend webview HTML: the commit list (cards with a swatch drawn
 * like the editor decoration, with hash, author and date in the tooltip), the coloring-mode and palette
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
  selectedCommitHash: string | null = null,
  revision = "HEAD"
): string {
  const now = Date.now();
  const items = commits.map((entry) => {
    const palette = paletteByCommit.get(entry.commitHash)!;
    const entryLabel = kindByCommit
      ? eventOriginLabel(kindByCommit.get(entry.commitHash) ?? "unknown")
      : rankLabel(entry.rank, entry.total);
    const authorTime = entry.authorTime === null ? null : entry.authorTime * 1000;
    const tooltip = `${shortCommitHash(entry.commitHash)} · ${authorTime === null ? "unknown date" : new Date(authorTime).toLocaleString()} · ${entry.author}
${entry.summary}`;
    const selected = entry.commitHash === selectedCommitHash ? " selected" : "";
    return `<li class="entry${selected}" title="${escapeHtml(tooltip)}">
      <span class="swatch" style="background:${palette.backgroundColor}; border-color:${palette.borderColor};"></span>
      <div class="entry-body">
        <div class="entry-top">
          <span class="kind">${escapeHtml(commitTitle(entry.summary))}</span>
          <span class="time">${escapeHtml(formatRelativeTime(authorTime, now))}</span>
        </div>
        <div class="meta">${escapeHtml(entryLabel)} · ${escapeHtml(lineLabel(entry.lineCount))}</div>
      </div>
    </li>`;
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
${SHARED_WEBVIEW_CSS}
      body { background: var(--vscode-editor-background); }
      .entry {
        display: grid;
        grid-template-columns: 16px 1fr;
        gap: 8px;
        align-items: start;
        border-left: none;
        padding-left: 6px;
      }
      .swatch {
        width: 14px;
        height: 14px;
        margin-top: 1px;
        border: 1px solid;
        border-radius: 4px;
        box-sizing: border-box;
      }
      .entry-body { min-width: 0; }
      .meta {
        margin-top: 2px;
        font-size: 0.9em;
        color: var(--vscode-foreground);
        opacity: 0.8;
      }
      .entry.selected {
        background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
        color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }
      .entry.selected .time, .entry.selected .meta {
        color: inherit;
      }
    </style>
  </head>
  <body>
    <header class="status">
      <div class="state">Edit history</div>
      <div class="row"><span class="label">File</span><code>${escapeHtml(path.basename(filePath))}</code></div>
      <div class="row"><span class="label">Branch</span><span>${revision === "HEAD" ? "Checked-out branch" : `<code>${escapeHtml(revision)}</code>`}</span></div>
      <div class="row"><label class="label" for="coloring-mode">Coloring</label><select id="coloring-mode">${modeOptionsHtml}</select></div>
      <div class="row"><label class="label" for="theme">Palette</label><select id="theme">${paletteOptionsHtml}</select></div>
    </header>
    <h2><span>Commits</span><span class="count">${commits.length}</span></h2>
    <ul class="entries">${items.join("")}</ul>
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
        const selectedItem = document.querySelector(".entry.selected");
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
