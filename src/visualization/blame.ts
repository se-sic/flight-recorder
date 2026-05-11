import * as path from "path";
import { gitCmd, GitCommandResult } from "../utils/git";

export const WORKING_TREE_COMMIT = "0000000000000000000000000000000000000000";

export type VisualizationGitFailureKind =
  | "git_not_found"
  | "not_a_repo"
  | "unknown_git_error";

export type VisualizationGitFailure = {
  kind: VisualizationGitFailureKind;
  msg: string;
  err: string;
};

export type CommitMetadata = {
  commitHash: string;
  author: string;
  authorTime: number | null;
  summary: string;
  isUncommitted: boolean;
};

export type AttributedSpan = {
  text: string;
  commitHash: string;
};

export type AttributedLine = {
  spans: AttributedSpan[];
};

export type CommitOwnershipRange = CommitMetadata & {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
};

type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

type Token = {
  text: string;
  start: number;
  end: number;
};

function isGitNotFoundResult(res: GitCommandResult): boolean {
  if (!res.spawnError) {
    return false;
  }

  const nodeErr = res.spawnError as NodeJS.ErrnoException;
  return nodeErr.code === "ENOENT";
}

export function classifyVisualizationGitFailure(
  res: GitCommandResult,
  fallbackMsg: string
): VisualizationGitFailure {
  const combined = `${res.err}\n${res.out}\n${res.spawnError?.message ?? ""}`.trim();

  if (isGitNotFoundResult(res)) {
    return {
      kind: "git_not_found",
      msg: "Git is not installed or not available in PATH.",
      err: combined || fallbackMsg,
    };
  }

  if (combined.includes("not a git repository")) {
    return {
      kind: "not_a_repo",
      msg: "The active file is not inside a git repository.",
      err: combined || fallbackMsg,
    };
  }

  return {
    kind: "unknown_git_error",
    msg: fallbackMsg,
    err: combined || fallbackMsg,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  return text.replace(/\r\n/g, "\n").split("\n");
}

function tokenize(text: string): Token[] {
  // Token-level attribution is the current compromise between "too coarse"
  // (whole-line blame) and "too noisy" (character-by-character provenance).
  //
  // We split into:
  // - whitespace runs
  // - identifier/number-like runs
  // - every remaining single character
  //
  // This lets later edits replace just meaningful parts of a line such as a
  // variable name, operator, or punctuation while preserving neighboring text
  // from older commits when it survives unchanged.
  const tokens: Token[] = [];
  const matches = text.matchAll(/\s+|[A-Za-z0-9_]+|./g);

  for (const match of matches) {
    const tokenText = match[0];
    const start = match.index ?? 0;
    tokens.push({
      text: tokenText,
      start,
      end: start + tokenText.length,
    });
  }

  return tokens;
}

function mergeAdjacentSpans(spans: AttributedSpan[]): AttributedSpan[] {
  const merged: AttributedSpan[] = [];

  for (const span of spans) {
    if (span.text.length === 0) {
      continue;
    }

    const last = merged[merged.length - 1];
    if (last && last.commitHash === span.commitHash) {
      last.text += span.text;
      continue;
    }

    merged.push({ ...span });
  }

  return merged;
}

function createFullLineOwnership(
  text: string,
  commitHash: string
): AttributedLine {
  return {
    spans: text.length === 0 ? [] : [{ text, commitHash }],
  };
}

function sliceLineSpans(
  spans: AttributedSpan[],
  start: number,
  end: number
): AttributedSpan[] {
  if (start >= end) {
    return [];
  }

  const result: AttributedSpan[] = [];
  let cursor = 0;

  for (const span of spans) {
    const spanStart = cursor;
    const spanEnd = cursor + span.text.length;
    cursor = spanEnd;

    if (spanEnd <= start) {
      continue;
    }

    if (spanStart >= end) {
      break;
    }

    const overlapStart = Math.max(start, spanStart);
    const overlapEnd = Math.min(end, spanEnd);
    result.push({
      text: span.text.slice(overlapStart - spanStart, overlapEnd - spanStart),
      commitHash: span.commitHash,
    });
  }

  return mergeAdjacentSpans(result);
}

function buildLcsMatrix<T>(
  left: T[],
  right: T[],
  isEqual: (a: T, b: T) => boolean
): number[][] {
  // Core diff primitive used for both token-level and sequence-level matching.
  //
  // The matrix stores the length of the longest common subsequence from each
  // pair of suffixes. During backtracking we prefer "equal" steps whenever
  // possible, which means unchanged tokens keep their previous commit
  // attribution while only inserted/replaced tokens are reassigned.
  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0)
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      if (isEqual(left[i], right[j])) {
        matrix[i][j] = matrix[i + 1][j + 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
  }

  return matrix;
}

type DiffOp<T> =
  | { type: "equal"; left: T; right: T }
  | { type: "delete"; left: T }
  | { type: "insert"; right: T };

function diffSequence<T>(
  left: T[],
  right: T[],
  isEqual: (a: T, b: T) => boolean
): DiffOp<T>[] {
  // Convert the LCS matrix into a simple edit script.
  //
  // Important for provenance:
  // - "equal"  => keep attribution from the old text
  // - "insert" => assign attribution to the newer commit
  // - "delete" => removed text disappears from the final file entirely
  //
  // We do not need a separate "replace" op here. A replacement appears as a
  // delete+insert pair, which is exactly what we want for provenance because
  // the removed tokens should vanish and the inserted tokens should belong to
  // the newer commit.
  const matrix = buildLcsMatrix(left, right, isEqual);
  const ops: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (isEqual(left[i], right[j])) {
      ops.push({ type: "equal", left: left[i], right: right[j] });
      i += 1;
      j += 1;
      continue;
    }

    if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      ops.push({ type: "delete", left: left[i] });
      i += 1;
    } else {
      ops.push({ type: "insert", right: right[j] });
      j += 1;
    }
  }

  while (i < left.length) {
    ops.push({ type: "delete", left: left[i] });
    i += 1;
  }

  while (j < right.length) {
    ops.push({ type: "insert", right: right[j] });
    j += 1;
  }

  return ops;
}

export function mergeLineAttribution(
  previousLine: AttributedLine,
  nextText: string,
  commitHash: string
): AttributedLine {
  // This is the key within-line attribution step.
  //
  // Input:
  // - previousLine: the old line, already split into spans that each carry the
  //   commit that last introduced that piece of text
  // - nextText: the new textual content of the line in the next snapshot
  // - commitHash: the commit responsible for this snapshot transition
  //
  // Goal:
  // Build a new span list for the final line such that:
  // - unchanged tokens inherit their old commit ownership
  // - newly inserted/replaced tokens are owned by the current commit
  //
  // Example:
  //   old: "const total = value;"   (all owned by commit A)
  //   new: "const total = newValue;" in commit B
  //
  // Result:
  //   "const total = " -> A
  //   "newValue"       -> B
  //   ";"              -> A
  //
  // This is reconstructed provenance, not a Git-native truth source. It is an
  // inference from adjacent snapshots.
  const previousText = previousLine.spans.map((span) => span.text).join("");
  if (previousText === nextText) {
    return previousLine;
  }

  const previousTokens = tokenize(previousText);
  const nextTokens = tokenize(nextText);
  const ops = diffSequence(previousTokens, nextTokens, (left, right) => {
    return left.text === right.text;
  });

  const merged: AttributedSpan[] = [];

  for (const op of ops) {
    if (op.type === "equal") {
      merged.push(
        ...sliceLineSpans(previousLine.spans, op.left.start, op.left.end)
      );
      continue;
    }

    if (op.type === "insert") {
      merged.push({
        text: op.right.text,
        commitHash,
      });
    }
  }

  return {
    spans: mergeAdjacentSpans(merged),
  };
}

function parseDiffHunks(diffText: string): DiffHunk[] {
  // We only need hunk coordinates, not the full patch body, because the actual
  // text for each side comes from complete file snapshots. The hunk metadata is
  // enough to tell us which line intervals changed between two revisions.
  const lines = diffText.split(/\r?\n/);
  const hunks: DiffHunk[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of lines) {
    const match = hunkRe.exec(line);
    if (!match) {
      continue;
    }

    hunks.push({
      oldStart: parseInt(match[1], 10),
      oldCount: match[2] === undefined ? 1 : parseInt(match[2], 10),
      newStart: parseInt(match[3], 10),
      newCount: match[4] === undefined ? 1 : parseInt(match[4], 10),
    });
  }

  return hunks;
}

function applyChangedBlock(
  previousBlock: AttributedLine[],
  nextBlock: string[],
  commitHash: string
): AttributedLine[] {
  // Apply provenance to one changed diff block.
  //
  // Cases:
  // - pure insertion: all new lines belong to the current commit
  // - pure deletion: block disappears from the final file
  // - line-for-line replacement: merge each old/new line pair with
  //   mergeLineAttribution so unchanged tokens survive with their old owner
  // - old/new block length mismatch: pair as many lines as possible, then treat
  //   extra new lines as fresh lines owned by the current commit
  //
  // The last case is intentionally approximate. It gives a stable first-pass
  // reconstruction for larger edits without introducing a much heavier
  // alignment algorithm across whole changed blocks.
  if (previousBlock.length === 0) {
    return nextBlock.map((line) => createFullLineOwnership(line, commitHash));
  }

  if (nextBlock.length === 0) {
    return [];
  }

  const pairCount = Math.min(previousBlock.length, nextBlock.length);
  const merged: AttributedLine[] = [];

  for (let index = 0; index < pairCount; index += 1) {
    merged.push(
      mergeLineAttribution(previousBlock[index], nextBlock[index], commitHash)
    );
  }

  for (let index = pairCount; index < nextBlock.length; index += 1) {
    merged.push(createFullLineOwnership(nextBlock[index], commitHash));
  }

  return merged;
}

export function applyPatchToAttributedLines(
  previousLines: AttributedLine[],
  nextPlainLines: string[],
  diffText: string,
  commitHash: string
): AttributedLine[] {
  // Replay one revision transition over the current attribution state.
  //
  // previousLines already represent the file after all earlier commits have
  // been applied. We now patch that attribution state forward to the next
  // revision:
  // - unchanged regions are copied through untouched
  // - each changed hunk is rebuilt by applyChangedBlock
  //
  // After processing all hunks, the returned AttributedLine[] describes the
  // next file snapshot with span-level commit ownership.
  const hunks = parseDiffHunks(diffText);
  if (hunks.length === 0) {
    return previousLines;
  }

  const nextAttributedLines: AttributedLine[] = [];
  let previousCursor = 1;

  for (const hunk of hunks) {
    const unchangedEndExclusive =
      hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;

    if (unchangedEndExclusive >= previousCursor) {
      nextAttributedLines.push(
        ...previousLines.slice(previousCursor - 1, unchangedEndExclusive)
      );
    }

    const previousBlock =
      hunk.oldCount === 0
        ? []
        : previousLines.slice(
            hunk.oldStart - 1,
            hunk.oldStart - 1 + hunk.oldCount
          );
    const nextBlock =
      hunk.newCount === 0
        ? []
        : nextPlainLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newCount);

    nextAttributedLines.push(
      ...applyChangedBlock(previousBlock, nextBlock, commitHash)
    );
    previousCursor =
      hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart + hunk.oldCount;
  }

  if (previousCursor <= previousLines.length) {
    nextAttributedLines.push(...previousLines.slice(previousCursor - 1));
  }

  return nextAttributedLines;
}

function createWorkingTreeMetadata(): CommitMetadata {
  return {
    commitHash: WORKING_TREE_COMMIT,
    author: "Working Tree",
    authorTime: null,
    summary: "Uncommitted changes",
    isUncommitted: true,
  };
}

async function readFileContentAtRevision(
  repoRoot: string,
  commitHash: string,
  repoRelativePath: string
): Promise<
  | { ok: true; content: string }
  | { ok: false; failure: VisualizationGitFailure }
> {
  const revisionPath = `${commitHash}:${repoRelativePath.split(path.sep).join("/")}`;
  const result = await gitCmd(["show", revisionPath], repoRoot);
  if (result.code !== 0) {
    return {
      ok: false,
      failure: classifyVisualizationGitFailure(
        result,
        `Failed to read ${repoRelativePath} at commit ${commitHash}.`
      ),
    };
  }

  return {
    ok: true,
    content: result.out.replace(/\r\n/g, "\n").replace(/\n$/, ""),
  };
}

async function listFileCommits(
  repoRoot: string,
  repoRelativePath: string
): Promise<
  | { ok: true; commits: CommitMetadata[] }
  | { ok: false; failure: VisualizationGitFailure }
> {
  const format = "%H%x09%at%x09%an%x09%s";
  const result = await gitCmd(
    ["log", "--follow", `--format=${format}`, "--", repoRelativePath],
    repoRoot
  );
  if (result.code !== 0) {
    return {
      ok: false,
      failure: classifyVisualizationGitFailure(
        result,
        `Failed to inspect git history for ${repoRelativePath}.`
      ),
    };
  }

  if (result.out.trim().length === 0) {
    return { ok: true, commits: [] };
  }

  return {
    ok: true,
    commits: result.out
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [commitHash, authorTimeRaw, author, ...summaryParts] = line.split("\t");
        const parsedAuthorTime = parseInt(authorTimeRaw, 10);
        return {
          commitHash,
          author,
          authorTime: Number.isFinite(parsedAuthorTime) ? parsedAuthorTime : null,
          summary: summaryParts.join("\t"),
          isUncommitted: false,
        };
      })
      .reverse(),
  };
}

function createMetadataMap(commits: CommitMetadata[]): Map<string, CommitMetadata> {
  return new Map(commits.map((commit) => [commit.commitHash, commit] as const));
}

function buildOwnershipRanges(
  attributedLines: AttributedLine[],
  metadataByCommit: Map<string, CommitMetadata>
): CommitOwnershipRange[] {
  const ranges: CommitOwnershipRange[] = [];

  for (let lineIndex = 0; lineIndex < attributedLines.length; lineIndex += 1) {
    const line = attributedLines[lineIndex];
    let column = 0;

    for (const span of line.spans) {
      if (span.text.length === 0) {
        continue;
      }

      const metadata = metadataByCommit.get(span.commitHash);
      if (!metadata) {
        continue;
      }

      ranges.push({
        ...metadata,
        lineNumber: lineIndex + 1,
        startColumn: column,
        endColumn: column + span.text.length,
      });
      column += span.text.length;
    }
  }

  return ranges;
}

type OwnershipResult =
  | { ok: true; ranges: CommitOwnershipRange[]; metadataByCommit: Map<string, CommitMetadata> }
  | { ok: false; failure: VisualizationGitFailure };

type BlameCacheEntry = { text: string; result: OwnershipResult & { ok: true } };
const blameCache = new Map<string, BlameCacheEntry>();

export async function buildFileOwnershipRanges(
  repoRoot: string,
  repoRelativePath: string,
  currentText: string
): Promise<
  | {
      ok: true;
      ranges: CommitOwnershipRange[];
      metadataByCommit: Map<string, CommitMetadata>;
    }
  | {
      ok: false;
      failure: VisualizationGitFailure;
    }
> {
  // End-to-end provenance reconstruction for the active file.
  //
  // High-level algorithm:
  // 1. Collect the commits that touched this file, oldest -> newest.
  // 2. Load the first file snapshot and assign the entire content to that
  //    first commit.
  // 3. For each later commit:
  //    - load the next snapshot
  //    - diff previous commit vs current commit with zero context
  //    - patch the attribution state forward so only changed tokens move to the
  //      newer commit
  // 4. If the working tree differs from HEAD, do one more patch step and mark
  //    newly introduced spans as uncommitted working-tree ownership.
  // 5. Convert the final span list into editor ranges for visualization.
  //
  // This gives us a practical within-line ownership model that is finer than
  // git blame while still being derived entirely from repository history.
  const cacheKey = `${repoRoot}\0${repoRelativePath}`;
  const cached = blameCache.get(cacheKey);
  if (cached && cached.text === currentText) {
    return cached.result;
  }

  const commitsResult = await listFileCommits(repoRoot, repoRelativePath);
  if (!commitsResult.ok) {
    return commitsResult;
  }

  const commits = commitsResult.commits;
  const metadataByCommit = createMetadataMap(commits);

  const currentNormalized = currentText.replace(/\r\n/g, "\n");

  if (commits.length === 0) {
    const workingTree = createWorkingTreeMetadata();
    metadataByCommit.set(workingTree.commitHash, workingTree);
    const ranges = buildOwnershipRanges(
      splitLines(currentNormalized).map((line) =>
        createFullLineOwnership(line, workingTree.commitHash)
      ),
      metadataByCommit
    );
    const result = { ok: true as const, ranges, metadataByCommit };
    blameCache.set(cacheKey, { text: currentText, result });
    return result;
  }

  // Fan out all git I/O in parallel: content at every revision, every
  // consecutive diff, and the working-tree diff (fetched optimistically).
  const [allContentsResults, allDiffResults, workingTreeDiff] = await Promise.all([
    Promise.all(
      commits.map((c) => readFileContentAtRevision(repoRoot, c.commitHash, repoRelativePath))
    ),
    Promise.all(
      commits.slice(1).map((c, i) =>
        gitCmd(
          ["diff", "--unified=0", "--no-color", commits[i].commitHash, c.commitHash, "--", repoRelativePath],
          repoRoot
        )
      )
    ),
    gitCmd(["diff", "--unified=0", "--no-color", "HEAD", "--", repoRelativePath], repoRoot),
  ]);

  for (const r of allContentsResults) {
    if (!r.ok) { return r; }
  }
  for (let i = 0; i < allDiffResults.length; i++) {
    if (allDiffResults[i].code !== 0) {
      return {
        ok: false,
        failure: classifyVisualizationGitFailure(
          allDiffResults[i],
          `Failed to diff ${repoRelativePath} between ${commits[i].commitHash} and ${commits[i + 1].commitHash}.`
        ),
      };
    }
  }

  const allContents = allContentsResults as Array<{ ok: true; content: string }>;

  let attributedLines = splitLines(allContents[0].content).map((line) =>
    createFullLineOwnership(line, commits[0].commitHash)
  );

  for (let i = 1; i < commits.length; i += 1) {
    attributedLines = applyPatchToAttributedLines(
      attributedLines,
      splitLines(allContents[i].content),
      allDiffResults[i - 1].out,
      commits[i].commitHash
    );
  }

  if (allContents[allContents.length - 1].content !== currentNormalized) {
    if (workingTreeDiff.code !== 0) {
      return {
        ok: false,
        failure: classifyVisualizationGitFailure(
          workingTreeDiff,
          `Failed to diff working tree changes for ${repoRelativePath}.`
        ),
      };
    }
    const workingTree = createWorkingTreeMetadata();
    metadataByCommit.set(workingTree.commitHash, workingTree);
    attributedLines = applyPatchToAttributedLines(
      attributedLines,
      splitLines(currentNormalized),
      workingTreeDiff.out,
      workingTree.commitHash
    );
  }

  const result = {
    ok: true as const,
    ranges: buildOwnershipRanges(attributedLines, metadataByCommit),
    metadataByCommit,
  };
  blameCache.set(cacheKey, { text: currentText, result });
  return result;
}
