export type CommitLineOwnership = {
  commitHash: string;
  finalLineNumber: number;
  author: string;
  authorTime: number | null;
  summary: string;
  isUncommitted: boolean;
};

export type CommitOwnershipSegment = {
  commitHash: string;
  startLineNumber: number;
  endLineNumber: number;
  author: string;
  authorTime: number | null;
  summary: string;
  isUncommitted: boolean;
};

export type CommitAgeEntry = {
  commitHash: string;
  author: string;
  authorTime: number | null;
  summary: string;
  isUncommitted: boolean;
  lineCount: number;
  rank: number;
  total: number;
};

export type CommitRangeLike = {
  commitHash: string;
  lineNumber: number;
  author: string;
  authorTime: number | null;
  summary: string;
  isUncommitted: boolean;
};

type PendingOwnership = {
  commitHash: string;
  finalLineNumber: number;
  author: string;
  authorTime: number | null;
  summary: string;
  isUncommitted: boolean;
};

const BLAME_HEADER_RE =
  /^(\^?[0-9a-f]{40}|0{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/i;

/** Creates an in-progress ownership record for a blame header line, before its author/summary fields are filled in. */
function createPendingOwnership(
  commitHash: string,
  finalLineNumber: number
): PendingOwnership {
  return {
    commitHash,
    finalLineNumber,
    author: "Unknown Author",
    authorTime: null,
    summary: "",
    isUncommitted: /^0{40}$/.test(commitHash),
  };
}

/** Shortens a commit hash for display, rendering the all-zero working-tree hash as "working-tree". */
export function shortCommitHash(commitHash: string): string {
  if (/^0{40}$/.test(commitHash)) {
    return "working-tree";
  }

  return commitHash.replace(/^\^/, "").slice(0, 8);
}

/** Parses `git blame --porcelain` output into a per-line list of commit ownership records. */
export function parseGitBlamePorcelain(
  porcelain: string
): CommitLineOwnership[] {
  const result: CommitLineOwnership[] = [];
  const lines = porcelain.split(/\r?\n/);
  let pending: PendingOwnership | null = null;

  for (const line of lines) {
    const headerMatch = BLAME_HEADER_RE.exec(line);
    if (headerMatch) {
      pending = createPendingOwnership(
        headerMatch[1],
        parseInt(headerMatch[2], 10)
      );
      continue;
    }

    if (!pending) {
      continue;
    }

    if (line.startsWith("author ")) {
      pending.author = line.slice("author ".length).trim() || "Unknown Author";
      continue;
    }

    if (line.startsWith("author-time ")) {
      const parsed = parseInt(line.slice("author-time ".length).trim(), 10);
      pending.authorTime = Number.isFinite(parsed) ? parsed : null;
      continue;
    }

    if (line.startsWith("summary ")) {
      pending.summary = line.slice("summary ".length).trim();
      continue;
    }

    if (line.startsWith("\t")) {
      result.push({
        commitHash: pending.commitHash,
        finalLineNumber: pending.finalLineNumber,
        author: pending.author,
        authorTime: pending.authorTime,
        summary: pending.summary,
        isUncommitted: pending.isUncommitted,
      });
      pending = null;
    }
  }

  return result.sort((a, b) => a.finalLineNumber - b.finalLineNumber);
}

/** Groups consecutive per-line ownership records sharing the same commit into contiguous line-range segments. */
export function groupCommitOwnershipSegments(
  ownership: CommitLineOwnership[]
): CommitOwnershipSegment[] {
  if (ownership.length === 0) {
    return [];
  }

  const segments: CommitOwnershipSegment[] = [];
  let current: CommitOwnershipSegment | null = null;

  for (const line of ownership) {
    if (
      current &&
      current.commitHash === line.commitHash &&
      current.endLineNumber + 1 === line.finalLineNumber
    ) {
      current.endLineNumber = line.finalLineNumber;
      continue;
    }

    current = {
      commitHash: line.commitHash,
      startLineNumber: line.finalLineNumber,
      endLineNumber: line.finalLineNumber,
      author: line.author,
      authorTime: line.authorTime,
      summary: line.summary,
      isUncommitted: line.isUncommitted,
    };
    segments.push(current);
  }

  return segments;
}

/**
 * Aggregates per-commit line counts from ownership segments and ranks
 * commits oldest-to-newest (uncommitted working-tree changes always last),
 * for use in the legend and rank-based coloring.
 */
export function buildCommitAgeEntries(
  segments: CommitOwnershipSegment[]
): CommitAgeEntry[] {
  const grouped = new Map<
    string,
    {
      commitHash: string;
      author: string;
      authorTime: number | null;
      summary: string;
      isUncommitted: boolean;
      lineCount: number;
    }
  >();

  for (const segment of segments) {
    const lineCount = segment.endLineNumber - segment.startLineNumber + 1;
    const existing = grouped.get(segment.commitHash);
    if (existing) {
      existing.lineCount += lineCount;
      continue;
    }

    grouped.set(segment.commitHash, {
      commitHash: segment.commitHash,
      author: segment.author,
      authorTime: segment.authorTime,
      summary: segment.summary,
      isUncommitted: segment.isUncommitted,
      lineCount,
    });
  }

  const ordered = Array.from(grouped.values()).sort((left, right) => {
    if (left.isUncommitted !== right.isUncommitted) {
      return left.isUncommitted ? 1 : -1;
    }

    const leftTime = left.authorTime ?? Number.POSITIVE_INFINITY;
    const rightTime = right.authorTime ?? Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.commitHash.localeCompare(right.commitHash);
  });

  return ordered.map((entry, index) => ({
    ...entry,
    rank: index,
    total: ordered.length,
  }));
}

/**
 * Same as {@link buildCommitAgeEntries}, but built from per-line-and-column
 * ownership ranges (as produced by {@link buildFileOwnershipRanges} in
 * `blame.ts`) instead of contiguous line segments.
 */
export function buildCommitAgeEntriesFromRanges(
  ranges: CommitRangeLike[]
): CommitAgeEntry[] {
  const grouped = new Map<
    string,
    {
      commitHash: string;
      author: string;
      authorTime: number | null;
      summary: string;
      isUncommitted: boolean;
      lines: Set<number>;
    }
  >();

  for (const range of ranges) {
    const existing = grouped.get(range.commitHash);
    if (existing) {
      existing.lines.add(range.lineNumber);
      continue;
    }

    grouped.set(range.commitHash, {
      commitHash: range.commitHash,
      author: range.author,
      authorTime: range.authorTime,
      summary: range.summary,
      isUncommitted: range.isUncommitted,
      lines: new Set([range.lineNumber]),
    });
  }

  const ordered = Array.from(grouped.values()).sort((left, right) => {
    if (left.isUncommitted !== right.isUncommitted) {
      return left.isUncommitted ? 1 : -1;
    }

    const leftTime = left.authorTime ?? Number.POSITIVE_INFINITY;
    const rightTime = right.authorTime ?? Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.commitHash.localeCompare(right.commitHash);
  });

  return ordered.map((entry, index) => ({
    commitHash: entry.commitHash,
    author: entry.author,
    authorTime: entry.authorTime,
    summary: entry.summary,
    isUncommitted: entry.isUncommitted,
    lineCount: entry.lines.size,
    rank: index,
    total: ordered.length,
  }));
}
