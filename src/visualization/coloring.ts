import type { buildCommitAgeEntriesFromRanges } from "./ownership";
import { classifyVisualizationGitFailure, type VisualizationGitFailure } from "./blame";
import { gitCmd } from "../utils/git";
import {
  hexToRgba,
  hexMix,
  sampleSequential,
  type CommitDecorationPalette,
  type SequentialPalette,
  type QualitativePalette,
} from "./palettes";

export type { CommitDecorationPalette, SequentialPalette, QualitativePalette };

export const COLORING_MODE_OPTIONS = [
  {
    value: "global" as const,
    label: "Global history",
    tooltip: "Colors commits by their position in the full repository history. Blue = oldest commit in the repo, orange-red = newest.",
  },
  {
    value: "file" as const,
    label: "File history",
    tooltip: "Colors commits by their position within this file's history only. Blue = first edit to this file, orange-red = most recent.",
  },
  {
    value: "event" as const,
    label: "Event type",
    tooltip: "Colors commits by the AI event that produced them: blue = agent edit, orange = inline completion, pink = mixed, gray = unknown.",
  },
] as const;

export type VisualizationColoringMode = typeof COLORING_MODE_OPTIONS[number]["value"];

export type EventOriginKind = "agent-edit" | "inline-completion" | "mixed" | "unknown";

export type PaletteResult =
  | {
      ok: true;
      paletteByCommit: Map<string, CommitDecorationPalette>;
      kindByCommit: Map<string, EventOriginKind> | null;
    }
  | { ok: false; failure: VisualizationGitFailure };

// --- Rank-based palette ---

/** Maps a commit's rank within a total ordering to a decoration palette sampled from a sequential color scale. */
export function rankPalette(
  rank: number,
  total: number,
  isDark: boolean,
  palette: SequentialPalette
): CommitDecorationPalette {
  const normalized = total <= 1 ? 1 : rank / (total - 1);
  const color = sampleSequential(palette, normalized, isDark);
  if (isDark) {
    return {
      backgroundColor: hexToRgba(color, 0.15),
      borderColor: hexToRgba(color, 0.92),
      overviewRulerColor: hexToRgba(color, 1),
    };
  }
  return {
    backgroundColor: hexToRgba(color, 0.20),
    borderColor: hexMix(color, [0, 0, 0], 0.28, 0.88),
    overviewRulerColor: hexMix(color, [0, 0, 0], 0.28, 1),
  };
}

// --- Event-origin palette ---

function normalizeEventOrigin(origin: string): EventOriginKind {
  switch (origin) {
    case "assistant-agent-chat":
    case "assistant-tool-edit":
    case "agent-edit":
      return "agent-edit";
    case "assistant-inline-completion":
    case "inline-completion":
      return "inline-completion";
    case "mixed":
      return "mixed";
    default:
      return "unknown";
  }
}

function eventOriginFromOriginSet(origins: Set<string>): EventOriginKind {
  const normalizedOrigins = new Set<EventOriginKind>();
  for (const origin of origins) {
    const normalized = normalizeEventOrigin(origin);
    if (normalized !== "unknown") {
      normalizedOrigins.add(normalized);
    }
  }

  if (normalizedOrigins.has("mixed") || normalizedOrigins.size > 1) {
    return "mixed";
  }
  if (normalizedOrigins.size === 0) {
    return "unknown";
  }
  return [...normalizedOrigins][0];
}

/** Infers the assistant-event origin kind from the Flight Recorder commit subject or compact JSON summary. */
export function eventOriginFromSummary(summary: string): EventOriginKind {
  const lowerSummary = summary.toLowerCase();
  if (lowerSummary.includes("flight recorder: assistant mixed")) {
    return "mixed";
  }
  if (lowerSummary.includes("flight recorder: assistant inline completion")) {
    return "inline-completion";
  }
  if (
    lowerSummary.includes("flight recorder: assistant agent chat") ||
    lowerSummary.includes("flight recorder: assistant tool edit")
  ) {
    return "agent-edit";
  }

  const origins = new Set<string>();
  const singleOriginPattern = /"origin"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = singleOriginPattern.exec(summary)) !== null) {
    origins.add(match[1]);
  }

  const originsArrayPattern = /"origins"\s*:\s*\[([^\]]*)\]/g;
  while ((match = originsArrayPattern.exec(summary)) !== null) {
    for (const origin of match[1].matchAll(/"([^"]+)"/g)) {
      origins.add(origin[1]);
    }
  }

  return eventOriginFromOriginSet(origins);
}

/** Returns the human-readable label for an event origin kind. */
export function eventOriginLabel(kind: EventOriginKind): string {
  switch (kind) {
    case "agent-edit": return "Agent edit";
    case "inline-completion": return "Inline completion";
    case "mixed": return "Mixed";
    case "unknown": return "Unknown";
  }
}

/** Maps an event origin kind to its decoration palette in the given qualitative color scheme. */
export function eventOriginPalette(
  kind: EventOriginKind,
  isDark: boolean,
  palette: QualitativePalette
): CommitDecorationPalette {
  const hex =
    kind === "agent-edit" ? palette.agentEdit :
    kind === "inline-completion" ? palette.inlineCompletion :
    kind === "mixed" ? palette.mixed :
    palette.unknown;
  if (isDark) {
    return {
      backgroundColor: hexToRgba(hex, 0.15),
      borderColor: hexToRgba(hex, 0.92),
      overviewRulerColor: hexToRgba(hex, 1),
    };
  }
  return {
    backgroundColor: hexToRgba(hex, 0.20),
    borderColor: hexMix(hex, [0, 0, 0], 0.30, 0.88),
    overviewRulerColor: hexMix(hex, [0, 0, 0], 0.30, 1),
  };
}

// --- Per-mode palette computation ---

/** Computes a per-commit decoration palette for "file history" coloring mode, ranked by this file's edit order. */
export function computeFilePalettes(
  commitAgeEntries: ReturnType<typeof buildCommitAgeEntriesFromRanges>,
  isDark: boolean,
  palette: SequentialPalette
): PaletteResult {
  const paletteByCommit = new Map(
    commitAgeEntries.map((entry) => [
      entry.commitHash,
      rankPalette(entry.rank, entry.total, isDark, palette),
    ])
  );
  return { ok: true, paletteByCommit, kindByCommit: null };
}

const globalColorRankCache = new Map<string, Map<string, { rank: number; total: number }>>();

/**
 * Fetches (and caches per repo) the repository-wide commit order via `git
 * rev-list --all --reverse`, used to rank commits for "global history"
 * coloring mode across all files, not just the active one.
 */
async function fetchGlobalColorRanks(
  repoRoot: string,
  forceRefresh = false
): Promise<
  | { ok: true; ranks: Map<string, { rank: number; total: number }> }
  | { ok: false; failure: VisualizationGitFailure }
> {
  const cached = forceRefresh ? undefined : globalColorRankCache.get(repoRoot);
  if (cached) {
    return { ok: true, ranks: cached };
  }

  const allCommits = await gitCmd(["rev-list", "--all", "--reverse"], repoRoot);
  if (allCommits.code !== 0) {
    return {
      ok: false,
      failure: classifyVisualizationGitFailure(
        allCommits,
        "Failed to inspect repository-wide commit order for global visualization coloring."
      ),
    };
  }

  const commitHashes = allCommits.out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const total = Math.max(commitHashes.length, 1);
  const ranks = new Map<string, { rank: number; total: number }>();
  commitHashes.forEach((hash, index) => {
    ranks.set(hash, { rank: index, total });
  });
  ranks.set("0000000000000000000000000000000000000000", { rank: total, total: total + 1 });
  globalColorRankCache.set(repoRoot, ranks);
  return { ok: true, ranks };
}

/**
 * Computes a per-commit decoration palette for "global history" coloring
 * mode, ranked by each commit's position across the entire repository
 * (refreshing the cached rank table if a needed commit is missing from it).
 */
export async function computeGlobalPalettes(
  repoRoot: string,
  commitAgeEntries: ReturnType<typeof buildCommitAgeEntriesFromRanges>,
  isDark: boolean,
  palette: SequentialPalette
): Promise<PaletteResult> {
  let ranksResult = await fetchGlobalColorRanks(repoRoot);
  if (!ranksResult.ok) {
    return { ok: false, failure: ranksResult.failure };
  }

  let ranks = ranksResult.ranks;
  const missingCommittedEntry = commitAgeEntries.find(
    (entry) => !entry.isUncommitted && !ranks.has(entry.commitHash)
  );
  if (missingCommittedEntry) {
    ranksResult = await fetchGlobalColorRanks(repoRoot, true);
    if (!ranksResult.ok) {
      return { ok: false, failure: ranksResult.failure };
    }
    ranks = ranksResult.ranks;
  }

  const paletteByCommit = new Map(
    commitAgeEntries.map((entry) => {
      const r = ranks.get(entry.commitHash) ?? { rank: entry.rank, total: entry.total };
      return [entry.commitHash, rankPalette(r.rank, r.total, isDark, palette)];
    })
  );
  return { ok: true, paletteByCommit, kindByCommit: null };
}

/** Computes a per-commit decoration palette for "event type" coloring mode, keyed by inferred event origin. */
export function computeEventPalettes(
  commitAgeEntries: ReturnType<typeof buildCommitAgeEntriesFromRanges>,
  isDark: boolean,
  palette: QualitativePalette
): PaletteResult {
  const kindByCommit = new Map(
    commitAgeEntries.map((entry) => [
      entry.commitHash,
      eventOriginFromSummary(entry.summary),
    ])
  );
  const paletteByCommit = new Map(
    commitAgeEntries.map((entry) => [
      entry.commitHash,
      eventOriginPalette(kindByCommit.get(entry.commitHash) ?? "unknown", isDark, palette),
    ])
  );
  return { ok: true, paletteByCommit, kindByCommit };
}
