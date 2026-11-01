export type UnifiedDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: string[];
  removedLines: string[];
};

export type ZeroBasedLineRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the hunks of a unified diff (as produced by jsdiff's `createTwoFilesPatch`), ignoring file headers. */
export function parseUnifiedDiffHunks(patch: string): UnifiedDiffHunk[] {
  const hunks: UnifiedDiffHunk[] = [];
  let current: UnifiedDiffHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of patch.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        addedLines: [],
        removedLines: [],
      };
      oldRemaining = current.oldLines;
      newRemaining = current.newLines;
      hunks.push(current);
      continue;
    }

    // Body lines are only consumed while the header's line counts are not
    // exhausted, so file headers of a following diff are never misread.
    if (!current || (oldRemaining <= 0 && newRemaining <= 0)) {
      continue;
    }

    if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
      newRemaining--;
    } else if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
      oldRemaining--;
    } else if (line.startsWith(" ")) {
      oldRemaining--;
      newRemaining--;
    }
  }

  return hunks;
}

/**
 * Converts a hunk's old-side line span into a zero-based range in the
 * pre-change document, matching the coordinates VS Code reports for
 * `TextDocumentContentChangeEvent.range`.
 */
export function hunkOldSideRange(hunk: UnifiedDiffHunk): ZeroBasedLineRange {
  // For pure insertions (oldLines 0), oldStart names the line *after which*
  // text is inserted, so the empty range sits at the start of the next line.
  const startLine = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
  return {
    startLine,
    startColumn: 0,
    endLine: startLine + hunk.oldLines,
    endColumn: 0,
  };
}

/** Joins a hunk's added lines into the text block a line-based editor update would insert. */
export function hunkAddedText(hunk: UnifiedDiffHunk): string | null {
  if (hunk.addedLines.length === 0) {
    return null;
  }
  return hunk.addedLines.join("\n") + "\n";
}
