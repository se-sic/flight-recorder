import * as vscode from "vscode";
import { shortCommitHash } from "./ownership";
import type { CommitOwnershipRange } from "./blame";
import type { CommitAgeEntry } from "./ownership";
import { rankPalette, type CommitDecorationPalette } from "./coloring";
import type { SequentialPalette } from "./palettes";

export type VisualOwnershipRange = {
  commitHash: string;
  author: string;
  authorTime: number | null;
  summary: string;
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
};

export type DecorationVariant =
  | "inline"
  | "blockSingle"
  | "blockStart"
  | "blockMiddle"
  | "blockEnd";

export type DecorationBucket = {
  decorationType: vscode.TextEditorDecorationType;
  options: vscode.DecorationOptions[];
};

function formatAuthorDate(authorTime: number | null): string {
  if (authorTime === null) {
    return "unknown date";
  }
  return new Date(authorTime * 1000).toLocaleString();
}

export function buildHoverMessage(
  commitHash: string,
  summary: string,
  author: string,
  authorTime: number | null,
  startLineNumber: number,
  endLineNumber: number
): vscode.MarkdownString {
  const hover = new vscode.MarkdownString();
  const rangeLabel =
    startLineNumber === endLineNumber
      ? `Line ${startLineNumber}`
      : `Lines ${startLineNumber}-${endLineNumber}`;

  hover.appendMarkdown(`**Commit**: \`${shortCommitHash(commitHash)}\`\n\n`);
  hover.appendMarkdown(`**Summary**: ${summary || "_No summary_"}\n\n`);
  hover.appendMarkdown(`**Author**: ${author}\n\n`);
  hover.appendMarkdown(`**Date**: ${formatAuthorDate(authorTime)}\n\n`);
  hover.appendMarkdown(`**Range**: ${rangeLabel}`);
  return hover;
}

export function createDecorationType(
  palette: CommitDecorationPalette,
  variant: DecorationVariant,
  emphasized = false
): vscode.TextEditorDecorationType {
  const b = emphasized ? "2px" : "1px";

  const borderWidths: Record<DecorationVariant, string> = {
    inline:      b,
    blockSingle: b,
    blockStart:  `${b} ${b} 0 ${b}`,
    blockMiddle: `0 ${b} 0 ${b}`,
    blockEnd:    `0 ${b} ${b} ${b}`,
  };

  const borderRadii: Record<DecorationVariant, string | undefined> = {
    inline:      "2px",
    blockSingle: "4px",
    blockStart:  "4px 4px 0 0",
    blockMiddle: undefined,
    blockEnd:    "0 0 4px 4px",
  };

  return vscode.window.createTextEditorDecorationType({
    isWholeLine: variant !== "inline",
    backgroundColor: palette.backgroundColor,
    borderWidth: borderWidths[variant],
    borderStyle: "solid",
    borderColor: palette.borderColor,
    borderRadius: borderRadii[variant],
    overviewRulerColor: palette.overviewRulerColor,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
}

export function buildVisualOwnershipRanges(
  editor: vscode.TextEditor,
  ranges: CommitOwnershipRange[]
): VisualOwnershipRange[] {
  const visualRanges: VisualOwnershipRange[] = [];

  for (const range of ranges) {
    const lineText = editor.document.lineAt(range.lineNumber - 1).text;
    const isWholeLine =
      range.startColumn === 0 && range.endColumn === lineText.length;

    const previous = visualRanges[visualRanges.length - 1];
    const canMergeWithPrevious =
      !!previous &&
      isWholeLine &&
      previous.commitHash === range.commitHash &&
      previous.endLineNumber + 1 === range.lineNumber &&
      previous.startColumn === 0 &&
      previous.endColumn ===
        editor.document.lineAt(previous.endLineNumber - 1).text.length;

    if (canMergeWithPrevious) {
      previous.endLineNumber = range.lineNumber;
      previous.endColumn = range.endColumn;
      continue;
    }

    visualRanges.push({
      commitHash: range.commitHash,
      author: range.author,
      authorTime: range.authorTime,
      summary: range.summary,
      startLineNumber: range.lineNumber,
      endLineNumber: range.lineNumber,
      startColumn: range.startColumn,
      endColumn: range.endColumn,
    });
  }

  return visualRanges;
}

function isWholeLineRange(
  editor: vscode.TextEditor,
  range: VisualOwnershipRange
): boolean {
  if (range.startLineNumber !== range.endLineNumber) {
    return (
      range.startColumn === 0 &&
      range.endColumn ===
        editor.document.lineAt(range.endLineNumber - 1).text.length
    );
  }
  return (
    range.startColumn === 0 &&
    range.endColumn ===
      editor.document.lineAt(range.startLineNumber - 1).text.length
  );
}

export function decorationVariantForRange(
  editor: vscode.TextEditor,
  range: VisualOwnershipRange
): DecorationVariant {
  if (!isWholeLineRange(editor, range)) {
    return "inline";
  }
  if (range.startLineNumber === range.endLineNumber) {
    return "blockSingle";
  }
  return "blockStart";
}

function buildDecorationRange(
  editor: vscode.TextEditor,
  range: VisualOwnershipRange,
  variant: DecorationVariant
): vscode.Range {
  if (variant === "inline" || variant === "blockSingle") {
    return new vscode.Range(
      range.startLineNumber - 1, range.startColumn,
      range.endLineNumber - 1,  range.endColumn
    );
  }
  if (variant === "blockStart") {
    return new vscode.Range(
      range.startLineNumber - 1, 0,
      range.startLineNumber - 1, editor.document.lineAt(range.startLineNumber - 1).text.length
    );
  }
  if (variant === "blockMiddle") {
    return new vscode.Range(
      range.startLineNumber - 1, 0,
      range.endLineNumber - 1,  editor.document.lineAt(range.endLineNumber - 1).text.length
    );
  }
  return new vscode.Range(
    range.endLineNumber - 1, 0,
    range.endLineNumber - 1, editor.document.lineAt(range.endLineNumber - 1).text.length
  );
}

export function findCommitAtPosition(
  ranges: VisualOwnershipRange[],
  position: vscode.Position
): string | null {
  const lineNumber = position.line + 1;
  const column = position.character;

  for (const range of ranges) {
    if (lineNumber < range.startLineNumber || lineNumber > range.endLineNumber) {
      continue;
    }
    if (range.startLineNumber === range.endLineNumber) {
      if (column >= range.startColumn && column <= range.endColumn) {
        return range.commitHash;
      }
      continue;
    }
    if (lineNumber === range.startLineNumber) {
      if (column >= range.startColumn) { return range.commitHash; }
      continue;
    }
    if (lineNumber === range.endLineNumber) {
      if (column <= range.endColumn) { return range.commitHash; }
      continue;
    }
    return range.commitHash;
  }

  return null;
}

export function buildDecorationBuckets(
  editor: vscode.TextEditor,
  visualRanges: VisualOwnershipRange[],
  paletteByCommit: Map<string, CommitDecorationPalette>,
  ageEntryByCommit: Map<string, CommitAgeEntry>,
  isDark: boolean,
  seqPalette: SequentialPalette
): Map<string, Map<DecorationVariant, DecorationBucket>> {
  const decorationsByCommit = new Map<string, Map<DecorationVariant, DecorationBucket>>();

  for (const range of visualRanges) {
    const commitAgeEntry = ageEntryByCommit.get(range.commitHash);
    if (!commitAgeEntry) {
      continue;
    }

    const commitBuckets =
      decorationsByCommit.get(range.commitHash) ??
      (() => {
        const created = new Map<DecorationVariant, DecorationBucket>();
        decorationsByCommit.set(range.commitHash, created);
        return created;
      })();

    const palette =
      paletteByCommit.get(range.commitHash) ??
      rankPalette(commitAgeEntry.rank, commitAgeEntry.total, isDark, seqPalette);

    const hoverMessage = buildHoverMessage(
      range.commitHash, range.summary, range.author, range.authorTime,
      range.startLineNumber, range.endLineNumber
    );

    const pushDecoration = (variant: DecorationVariant, decorationRange: vscode.Range): void => {
      const bucket =
        commitBuckets.get(variant) ??
        (() => {
          const created: DecorationBucket = {
            decorationType: createDecorationType(palette, variant),
            options: [],
          };
          commitBuckets.set(variant, created);
          return created;
        })();
      bucket.options.push({ range: decorationRange, hoverMessage });
    };

    const variant = decorationVariantForRange(editor, range);

    if (variant === "inline") {
      pushDecoration("inline", new vscode.Range(
        range.startLineNumber - 1, range.startColumn,
        range.endLineNumber - 1,  range.endColumn
      ));
      continue;
    }

    if (variant === "blockSingle") {
      if (editor.document.lineAt(range.startLineNumber - 1).text.length > 0) {
        pushDecoration("blockSingle", new vscode.Range(
          range.startLineNumber - 1, 0,
          range.startLineNumber - 1, editor.document.lineAt(range.startLineNumber - 1).text.length
        ));
      }
      continue;
    }

    // Multi-line block: group consecutive non-empty lines into sub-runs so that
    // empty lines are left undecorated and each sub-run gets correct border shape.
    const nonEmptyLines: number[] = [];
    for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
      if (editor.document.lineAt(line - 1).text.length > 0) {
        nonEmptyLines.push(line);
      }
    }

    let runStart = 0;
    while (runStart < nonEmptyLines.length) {
      let runEnd = runStart;
      while (
        runEnd + 1 < nonEmptyLines.length &&
        nonEmptyLines[runEnd + 1] === nonEmptyLines[runEnd] + 1
      ) {
        runEnd += 1;
      }

      const firstLine = nonEmptyLines[runStart];
      const lastLine = nonEmptyLines[runEnd];

      if (firstLine === lastLine) {
        pushDecoration("blockSingle", new vscode.Range(
          firstLine - 1, 0,
          firstLine - 1, editor.document.lineAt(firstLine - 1).text.length
        ));
      } else {
        pushDecoration("blockStart", new vscode.Range(
          firstLine - 1, 0,
          firstLine - 1, editor.document.lineAt(firstLine - 1).text.length
        ));
        for (let line = firstLine + 1; line < lastLine; line += 1) {
          pushDecoration("blockMiddle", new vscode.Range(
            line - 1, 0,
            line - 1, editor.document.lineAt(line - 1).text.length
          ));
        }
        pushDecoration("blockEnd", new vscode.Range(
          lastLine - 1, 0,
          lastLine - 1, editor.document.lineAt(lastLine - 1).text.length
        ));
      }

      runStart = runEnd + 1;
    }
  }

  return decorationsByCommit;
}

export function buildSelectedDecorationBuckets(
  editor: vscode.TextEditor,
  selectedRanges: VisualOwnershipRange[],
  palette: CommitDecorationPalette
): Map<DecorationVariant, DecorationBucket> {
  const buckets = new Map<DecorationVariant, DecorationBucket>();

  for (const range of selectedRanges) {
    const hoverMessage = buildHoverMessage(
      range.commitHash, range.summary, range.author, range.authorTime,
      range.startLineNumber, range.endLineNumber
    );
    const variant = decorationVariantForRange(editor, range);

    const pushDecoration = (bucketVariant: DecorationVariant, bucketRange: vscode.Range): void => {
      const bucket =
        buckets.get(bucketVariant) ??
        (() => {
          const created: DecorationBucket = {
            decorationType: createDecorationType(palette, bucketVariant, true),
            options: [],
          };
          buckets.set(bucketVariant, created);
          return created;
        })();
      bucket.options.push({ range: bucketRange, hoverMessage });
    };

    if (variant === "inline" || variant === "blockSingle") {
      pushDecoration(variant, buildDecorationRange(editor, range, variant));
      continue;
    }

    pushDecoration("blockStart", buildDecorationRange(editor, range, "blockStart"));
    for (
      let lineNumber = range.startLineNumber + 1;
      lineNumber < range.endLineNumber;
      lineNumber += 1
    ) {
      pushDecoration("blockMiddle", new vscode.Range(
        lineNumber - 1, 0,
        lineNumber - 1, editor.document.lineAt(lineNumber - 1).text.length
      ));
    }
    pushDecoration("blockEnd", buildDecorationRange(editor, range, "blockEnd"));
  }

  return buckets;
}
