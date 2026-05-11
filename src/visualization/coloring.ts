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

export function eventOriginFromSummary(body: string): EventOriginKind {
  const origins = new Set<string>();
  const pattern = /"origin"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    origins.add(match[1]);
  }
  if (origins.size === 0) {
    return "unknown";
  }
  if (origins.size > 1) {
    return "mixed";
  }
  const [origin] = [...origins];
  if (origin === "agent-edit" || origin === "inline-completion") {
    return origin;
  }
  return "unknown";
}

export function eventOriginLabel(kind: EventOriginKind): string {
  switch (kind) {
    case "agent-edit": return "Agent edit";
    case "inline-completion": return "Inline completion";
    case "mixed": return "Mixed";
    case "unknown": return "Unknown";
  }
}

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
