import * as crypto from "crypto";
import {
  AssistantEvent,
  AttributionEvidence,
  collectEventFilePaths,
  EditOrigin,
} from "./event";
import { normalizePath, relativePathInside } from "../utils/fs-path";
import { EXTENSION_NAME } from "../utils/constants";

export type HumanWindowCommit = {
  kind: "human";
  files: string[];
  startedAt: number;
  endedAt: number;
  /** Content to commit instead of the working-tree file, by absolute path. */
  snapshots?: Record<string, string>;
};

export type AssistantWindowCommit = {
  kind: "assistant";
  files: string[];
  startedAt: number;
  endedAt: number;
  events: AssistantEvent[];
  origins: EditOrigin[];
  fileAttributions: FileAttribution[];
};

export type WindowCommit = HumanWindowCommit | AssistantWindowCommit;

export type TextChangeRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type WorkspaceTextChange = {
  path: string;
  insertedTextHashes: string[];
  insertedTextLength: number;
  ranges: TextChangeRange[];
  /** Full document text after the change. */
  text?: string;
};

type TextSnapshot = { at: number; text: string };

/**
 * How long an assistant edit may sit in the editor before its event is
 * parsed. Human text older than this is safe to attribute to the human.
 */
const ASSISTANT_EVENT_LAG_MS = 1_000;
/**
 * How far back a tool run that names no files (a shell command) claims
 * on-disk changes the file watcher reported before the run's log line was read.
 */
const RECENT_DISK_CHANGE_MS = 2_000;

/**
 * How long an assistant window waits for a running tool's completion signal
 * without any other activity, in case the signal never arrives (e.g. the
 * user interrupted the assistant).
 */
const MAX_TOOL_RUN_IDLE_MS = 5 * 60_000;

export type FileAttribution = {
  path: string;
  origin: EditOrigin;
  confidence: "high" | "medium" | "low";
  matched: boolean;
  evidenceTypes: string[];
  requestIds: string[];
  sessionIds: string[];
  matchedTextHashCount: number;
  proposedTextHashCount: number;
  rangeOverlap: boolean;
};

type HumanWindowState = {
  kind: "human";
  files: Set<string>;
  startedAt: number | null;
  endedAt: number | null;
  /** Recent document texts per file, oldest first. */
  texts: Map<string, TextSnapshot[]>;
  /** When each file last changed on disk, for changes no editor text accounts for. */
  diskChanges: Map<string, number>;
};

type AssistantWindowState = {
  kind: "assistant";
  files: Set<string>;
  startedAt: number;
  lastActivityAt: number;
  events: AssistantEvent[];
  fileAttributions: Map<string, FileAttribution>;
  awaitingMaterialization: boolean;
  /** Claims every workspace change, because an event named no files or ran a tool that can change anything. */
  openEnded: boolean;
  /** Tools reported as started but not yet finished (see `AssistantEvent.toolCall`). */
  runningTools: Set<string>;
  /** Observed text changes, kept so evidence that arrives after its change can still be matched. */
  materializations: WorkspaceTextChange[];
};

/** Resolves paths to absolute form, dropping blanks and duplicates, and returns them sorted. */
function normalizePaths(paths: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(paths)
        .filter((candidate) => candidate.trim().length > 0)
        .map((candidate) => normalizePath(candidate))
    )
  ).sort((left, right) => left.localeCompare(right));
}

/** Converts a human window's accumulated state into a commit, or null if there is nothing to commit. */
function finalizeHumanWindow(
  state: HumanWindowState
): HumanWindowCommit | null {
  const files = normalizePaths(state.files);
  if (
    files.length === 0 ||
    state.startedAt === null ||
    state.endedAt === null
  ) {
    return null;
  }

  return {
    kind: "human",
    files,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
  };
}

/** Converts an assistant window's accumulated state into a commit, or null if it has not materialized or has nothing to commit. */
function finalizeAssistantWindow(
  state: AssistantWindowState
): AssistantWindowCommit | null {
  if (state.awaitingMaterialization) {
    return null;
  }

  const files = normalizePaths(state.files);
  if (files.length === 0 && state.events.length === 0) {
    return null;
  }

  return {
    kind: "assistant",
    files,
    startedAt: state.startedAt,
    endedAt: state.lastActivityAt,
    events: [...state.events],
    origins: assistantOrigins(state.events),
    fileAttributions: Array.from(state.fileAttributions.values()).sort(
      (left, right) => left.path.localeCompare(right.path)
    ),
  };
}

function assistantOrigins(events: AssistantEvent[]): EditOrigin[] {
  const origins = Array.from(
    new Set(
      events
        .map((event) => event.origin)
        .filter((origin): origin is EditOrigin => Boolean(origin))
    )
  ).sort((left, right) => left.localeCompare(right));

  if (origins.length === 0) {
    return ["assistant-unknown"];
  }
  if (origins.length > 1) {
    return [...origins, "mixed"];
  }
  return origins;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function hashInsertedText(text: string): string {
  return hashText(text);
}

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  return Array.from(
    new Set(
      Array.from(values).filter((value): value is string =>
        typeof value === "string" && value.length > 0
      )
    )
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeRange(value: unknown): TextChangeRange | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const startLine =
    typeof obj.startLine === "number"
      ? obj.startLine
      : typeof obj.startLineNumber === "number"
        ? obj.startLineNumber - 1
        : undefined;
  const startColumn =
    typeof obj.startColumn === "number"
      ? obj.startColumn
      : typeof obj.startColumnNumber === "number"
        ? obj.startColumnNumber - 1
        : undefined;
  const endLine =
    typeof obj.endLine === "number"
      ? obj.endLine
      : typeof obj.endLineNumber === "number"
        ? obj.endLineNumber - 1
        : undefined;
  const endColumn =
    typeof obj.endColumn === "number"
      ? obj.endColumn
      : typeof obj.endColumnNumber === "number"
        ? obj.endColumnNumber - 1
        : undefined;

  if (
    startLine === undefined ||
    startColumn === undefined ||
    endLine === undefined ||
    endColumn === undefined
  ) {
    return null;
  }

  return { startLine, startColumn, endLine, endColumn };
}

function collectEvidenceTextHashes(evidence: AttributionEvidence[]): string[] {
  return uniqueStrings(
    evidence.flatMap((entry) => {
      const hashes = entry.details?.editTextHashes;
      return Array.isArray(hashes)
        ? hashes.filter((value): value is string => typeof value === "string")
        : [];
    })
  );
}

function collectEvidenceRanges(evidence: AttributionEvidence[]): TextChangeRange[] {
  const ranges: TextChangeRange[] = [];

  for (const entry of evidence) {
    const rawRanges = entry.details?.ranges;
    if (!Array.isArray(rawRanges)) {
      continue;
    }

    for (const rawRange of rawRanges) {
      const normalized = normalizeRange(rawRange);
      if (normalized) {
        ranges.push(normalized);
      }
    }
  }

  return ranges;
}

function rangesOverlap(left: TextChangeRange, right: TextChangeRange): boolean {
  if (left.endLine < right.startLine || right.endLine < left.startLine) {
    return false;
  }
  if (left.endLine === right.startLine && left.endColumn < right.startColumn) {
    return false;
  }
  if (right.endLine === left.startLine && right.endColumn < left.startColumn) {
    return false;
  }
  return true;
}

function rangeSetsOverlap(
  left: TextChangeRange[],
  right: TextChangeRange[]
): boolean {
  return left.some((leftRange) =>
    right.some((rightRange) => rangesOverlap(leftRange, rightRange))
  );
}

function attributionFromEvent(
  event: AssistantEvent,
  filePath: string
): FileAttribution {
  const evidence = event.evidence ?? [];
  const proposedTextHashes = collectEvidenceTextHashes(evidence);

  return {
    path: normalizePath(filePath),
    origin: event.origin ?? "assistant-unknown",
    confidence:
      proposedTextHashes.length > 0 || evidence.length > 0 ? "medium" : "low",
    matched: false,
    evidenceTypes: uniqueStrings(evidence.map((entry) => entry.type)),
    requestIds: uniqueStrings([
      event.requestId,
      ...evidence.map((entry) => entry.requestId),
    ]),
    sessionIds: uniqueStrings([
      event.sessionId,
      ...evidence.map((entry) => entry.sessionId),
    ]),
    matchedTextHashCount: 0,
    proposedTextHashCount: proposedTextHashes.length,
    rangeOverlap: false,
  };
}

function mergeAttribution(
  existing: FileAttribution | undefined,
  next: FileAttribution
): FileAttribution {
  if (!existing) {
    return next;
  }

  const confidenceRank = { low: 0, medium: 1, high: 2 };
  const betterConfidence =
    confidenceRank[next.confidence] > confidenceRank[existing.confidence]
      ? next.confidence
      : existing.confidence;
  const origin = existing.origin === next.origin ? existing.origin : "mixed";

  return {
    path: existing.path,
    origin,
    confidence: betterConfidence,
    matched: existing.matched || next.matched,
    evidenceTypes: uniqueStrings([
      ...existing.evidenceTypes,
      ...next.evidenceTypes,
    ]),
    requestIds: uniqueStrings([...existing.requestIds, ...next.requestIds]),
    sessionIds: uniqueStrings([...existing.sessionIds, ...next.sessionIds]),
    matchedTextHashCount:
      existing.matchedTextHashCount + next.matchedTextHashCount,
    proposedTextHashCount: Math.max(
      existing.proposedTextHashCount,
      next.proposedTextHashCount
    ),
    rangeOverlap: existing.rangeOverlap || next.rangeOverlap,
  };
}

function materializationAttribution(
  event: AssistantEvent,
  filePath: string,
  change: WorkspaceTextChange
): FileAttribution {
  const base = attributionFromEvent(event, filePath);
  const evidence = event.evidence ?? [];
  const proposedTextHashes = collectEvidenceTextHashes(evidence);
  const proposedRanges = collectEvidenceRanges(evidence);
  const observedHashes = new Set(change.insertedTextHashes);
  const matchedTextHashCount = proposedTextHashes.filter((hash) =>
    observedHashes.has(hash)
  ).length;
  const rangeOverlap =
    proposedRanges.length > 0 &&
    change.ranges.length > 0 &&
    rangeSetsOverlap(proposedRanges, change.ranges);

  const confidence =
    matchedTextHashCount > 0 || rangeOverlap
      ? "high"
      : proposedTextHashes.length > 0 || proposedRanges.length > 0
        ? "medium"
        : "low";

  return {
    ...base,
    confidence,
    matched: true,
    matchedTextHashCount,
    rangeOverlap,
  };
}

/**
 * Attributes tracked file changes to human or assistant ownership windows,
 * using assistant evidence to avoid assigning unrelated concurrent edits to
 * the assistant window.
 */
export class FineGrainedStagingTracker {
  private humanState: HumanWindowState = {
    kind: "human",
    files: new Set<string>(),
    startedAt: null,
    endedAt: null,
    texts: new Map<string, TextSnapshot[]>(),
    diskChanges: new Map<string, number>(),
  };

  private assistantState: AssistantWindowState | null = null;

  constructor(private readonly assistantDebounceMs: number) {}

  /** Returns whether an event announces an intent to touch files rather than a confirmed edit. */
  private isDeferredAssistantBoundary(event: AssistantEvent): boolean {
    return (
      event.kind === "tool-called" &&
      event.capability === "tool-call" &&
      event.toolCall === undefined &&
      collectEventFilePaths(event).length > 0
    );
  }

  /** Tracks the start and end of tool runs reported by `event` in the open assistant window. */
  private applyToolCallPhase(event: AssistantEvent): void {
    const state = this.assistantState;
    if (!state || !event.toolCall) {
      return;
    }
    const { id, phase } = event.toolCall;
    if (phase === "started") {
      state.runningTools.add(id ?? `${event.timestamp}:${state.runningTools.size}`);
    } else if (id === undefined) {
      state.runningTools.clear();
    } else {
      state.runningTools.delete(id);
    }
  }

  /** Records path-only workspace changes, preserving unrelated human edits during assistant windows. */
  recordHumanChange(paths: Iterable<string>, at = Date.now()): void {
    const normalized = normalizePaths(paths);
    if (normalized.length === 0) {
      return;
    }

    // Create/delete/rename leave no editor text, so earlier snapshots are stale.
    for (const filePath of normalized) {
      this.humanState.texts.delete(filePath);
    }

    this.routePathChanges(normalized, at);
  }

  /**
   * Records on-disk changes seen by a file watcher (e.g. made by a shell
   * command). Unlike `recordHumanChange`, this keeps editor text snapshots,
   * because a watcher also reports every ordinary save.
   */
  recordDiskChange(paths: Iterable<string>, at = Date.now()): void {
    const normalized = normalizePaths(paths);
    for (const filePath of normalized) {
      this.humanState.diskChanges.set(filePath, at);
    }
    this.routePathChanges(normalized, at);
  }

  /** Assigns changed paths to the open assistant window when it claims them, otherwise to the human window. */
  private routePathChanges(normalized: string[], at: number): void {
    if (normalized.length === 0) {
      return;
    }

    if (this.assistantState) {
      const knownAssistantFiles = this.assistantState.files;
      const claimsEverything = this.assistantState.openEnded;
      const humanPaths: string[] = [];

      for (const filePath of normalized) {
        if (claimsEverything || knownAssistantFiles.has(filePath)) {
          this.assistantState.files.add(filePath);
          this.assistantState.lastActivityAt = at;
          this.assistantState.awaitingMaterialization = false;
        } else {
          humanPaths.push(filePath);
        }
      }

      if (humanPaths.length > 0) {
        this.recordHumanChangeWithoutAssistant(humanPaths, at);
      }
      return;
    }

    this.recordHumanChangeWithoutAssistant(normalized, at);
  }

  /** Records text-document changes with inserted-text hashes and ranges for assistant evidence matching. */
  recordTextDocumentChange(
    changes: Iterable<WorkspaceTextChange>,
    at = Date.now()
  ): void {
    const normalizedChanges = Array.from(changes)
      .map((change) => ({
        ...change,
        path: normalizePath(change.path),
      }))
      .filter((change) => change.path.trim().length > 0);

    if (normalizedChanges.length === 0) {
      return;
    }

    if (!this.assistantState) {
      this.recordHumanChangeWithoutAssistant(
        normalizedChanges.map((change) => change.path),
        at
      );
      this.recordHumanTexts(normalizedChanges, at);
      return;
    }

    const knownAssistantFiles = this.assistantState.files;
    const claimsEverything = this.assistantState.openEnded;
    const humanChanges: WorkspaceTextChange[] = [];

    for (const change of normalizedChanges) {
      if (claimsEverything || knownAssistantFiles.has(change.path)) {
        this.assistantState.files.add(change.path);
        this.assistantState.lastActivityAt = at;
        this.assistantState.awaitingMaterialization = false;
        this.recordAssistantMaterialization(change);
      } else {
        humanChanges.push(change);
      }
    }

    if (humanChanges.length > 0) {
      this.recordHumanChangeWithoutAssistant(
        humanChanges.map((change) => change.path),
        at
      );
      this.recordHumanTexts(humanChanges, at);
    }
  }

  /**
   * Remembers each file's text after a human change. Only the newest text
   * older than ASSISTANT_EVENT_LAG_MS is needed, so older ones are dropped.
   */
  private recordHumanTexts(changes: WorkspaceTextChange[], at: number): void {
    for (const change of changes) {
      if (change.text === undefined) {
        this.humanState.texts.delete(change.path);
        continue;
      }
      const texts = this.humanState.texts.get(change.path) ?? [];
      texts.push({ at, text: change.text });
      const settled = texts.filter((t) => t.at <= at - ASSISTANT_EVENT_LAG_MS);
      const keepFrom = settled.length > 0 ? texts.indexOf(settled[settled.length - 1]) : 0;
      this.humanState.texts.set(change.path, texts.slice(keepFrom));
    }
  }

  private recordAssistantMaterialization(change: WorkspaceTextChange): void {
    if (!this.assistantState) {
      return;
    }

    this.assistantState.materializations.push(change);
    const matchingEvents = this.assistantState.events.filter((event) =>
      normalizePaths(collectEventFilePaths(event)).includes(change.path)
    );

    for (const event of matchingEvents) {
      const next = materializationAttribution(event, change.path, change);
      const existing = this.assistantState.fileAttributions.get(change.path);
      this.assistantState.fileAttributions.set(
        change.path,
        mergeAttribution(existing, next)
      );
    }
  }

  private recordHumanChangeWithoutAssistant(
    paths: Iterable<string>,
    at: number
  ): void {
    const normalized = normalizePaths(paths);
    if (normalized.length === 0) {
      return;
    }

    if (this.humanState.startedAt === null) {
      this.humanState.startedAt = at;
    }
    this.humanState.endedAt = at;
    for (const filePath of normalized) {
      this.humanState.files.add(filePath);
    }
  }

  /**
   * Records an assistant event, opening an assistant window if none is active.
   * Any open human window is flushed first. The assistant's edit is usually
   * already in the editor when its event arrives, so for files both touched,
   * the human commit uses the file's text from before that lag; without such
   * text the file moves into assistant ownership.
   */
  recordAssistantEvent(
    event: AssistantEvent,
    at = Date.now()
  ): WindowCommit[] {
    // Reads and searches change nothing: they never open a window or claim
    // files, but keep an open window alive and may end running tools.
    if (event.capability === "read-only") {
      if (this.assistantState) {
        this.assistantState.lastActivityAt = at;
        this.assistantState.events.push(event);
        this.applyToolCallPhase(event);
      }
      return [];
    }

    const commits: WindowCommit[] = [];
    const assistantPaths = normalizePaths(collectEventFilePaths(event));
    const snapshots: Record<string, string> = {};
    const claimsEverything = assistantPaths.length === 0 || event.capability === "command" || !!event.toolCall;

    // A fast shell command can change files before its log line is read, so
    // the watcher reports them as human changes first. Files the human did
    // not edit in the editor and that changed just now belong to the run.
    const claimedFromHuman = claimsEverything
      ? Array.from(this.humanState.diskChanges)
        .filter(([filePath, changedAt]) =>
          this.humanState.files.has(filePath) &&
          !this.humanState.texts.has(filePath) &&
          at - changedAt <= RECENT_DISK_CHANGE_MS)
        .map(([filePath]) => filePath)
      : [];
    for (const filePath of claimedFromHuman) {
      this.humanState.files.delete(filePath);
    }

    for (const filePath of assistantPaths) {
      const settled = (this.humanState.texts.get(filePath) ?? []).filter(
        (t) => t.at <= at - ASSISTANT_EVENT_LAG_MS
      );
      if (this.humanState.files.has(filePath) && settled.length > 0) {
        snapshots[filePath] = settled[settled.length - 1].text;
      } else {
        this.humanState.files.delete(filePath);
      }
    }

    const humanCommit = finalizeHumanWindow(this.humanState);
    if (humanCommit) {
      if (Object.keys(snapshots).length > 0) {
        humanCommit.snapshots = snapshots;
      }
      commits.push(humanCommit);
    }
    this.humanState = {
      kind: "human",
      files: new Set<string>(),
      startedAt: null,
      endedAt: null,
      texts: new Map<string, TextSnapshot[]>(),
      diskChanges: new Map<string, number>(),
    };

    if (!this.assistantState) {
      const awaitingMaterialization = this.isDeferredAssistantBoundary(event);
      this.assistantState = {
        kind: "assistant",
        files: new Set<string>(),
        startedAt: at,
        lastActivityAt: at,
        events: [],
        fileAttributions: new Map<string, FileAttribution>(),
        awaitingMaterialization,
        openEnded: false,
        runningTools: new Set<string>(),
        materializations: [],
      };
    }

    this.assistantState.lastActivityAt = at;
    this.assistantState.events.push(event);
    this.applyToolCallPhase(event);
    if (claimsEverything) {
      this.assistantState.openEnded = true;
    }
    for (const filePath of claimedFromHuman) {
      this.assistantState.files.add(filePath);
    }
    if (!this.isDeferredAssistantBoundary(event)) {
      this.assistantState.awaitingMaterialization = false;
    }
    for (const filePath of assistantPaths) {
      this.assistantState.files.add(filePath);
      let next = attributionFromEvent(event, filePath);
      // The editor may report a change before the event carrying its evidence
      // is parsed (e.g. a tool's post-execution log line), so match this event
      // against changes already observed in the window as well.
      for (const change of this.assistantState.materializations) {
        if (change.path === filePath) {
          next = mergeAttribution(
            next,
            materializationAttribution(event, filePath, change)
          );
        }
      }
      const existing = this.assistantState.fileAttributions.get(filePath);
      this.assistantState.fileAttributions.set(
        filePath,
        mergeAttribution(existing, next)
      );
    }

    return commits;
  }

  /** Closes and returns the assistant window if its debounce timeout has elapsed. */
  flushAssistantWindowIfIdle(at = Date.now()): WindowCommit | null {
    if (!this.assistantState) {
      return null;
    }

    if (
      this.assistantState.runningTools.size > 0 &&
      at - this.assistantState.lastActivityAt < MAX_TOOL_RUN_IDLE_MS
    ) {
      return null;
    }

    if (
      this.assistantState.awaitingMaterialization ||
      (this.assistantDebounceMs > 0 &&
        at - this.assistantState.lastActivityAt < this.assistantDebounceMs)
    ) {
      return null;
    }

    const commit = finalizeAssistantWindow(this.assistantState);
    this.assistantState = null;
    return commit;
  }

  /** Unconditionally closes any open assistant and human windows. */
  flushAll(at = Date.now()): WindowCommit[] {
    const commits: WindowCommit[] = [];

    if (this.assistantState) {
      this.assistantState.lastActivityAt = Math.max(
        this.assistantState.lastActivityAt,
        at
      );
      const assistantCommit = finalizeAssistantWindow(this.assistantState);
      if (assistantCommit) {
        commits.push(assistantCommit);
      }
      this.assistantState = null;
    }

    if (this.humanState.endedAt === null && this.humanState.startedAt !== null) {
      this.humanState.endedAt = at;
    }
    const humanCommit = finalizeHumanWindow(this.humanState);
    if (humanCommit) {
      commits.push(humanCommit);
    }
    this.humanState = {
      kind: "human",
      files: new Set<string>(),
      startedAt: null,
      endedAt: null,
      texts: new Map<string, TextSnapshot[]>(),
      diskChanges: new Map<string, number>(),
    };

    return commits;
  }
}

/** Formats a millisecond epoch timestamp as an ISO 8601 string. */
function formatIsoTimestamp(at: number): string {
  return new Date(at).toISOString();
}

function formatCommitPath(filePath: string, repoRoot?: string): string {
  const absolute = normalizePath(filePath);
  return (repoRoot && relativePathInside(repoRoot, absolute)) || absolute;
}

function formatCommitPaths(files: string[], repoRoot?: string): string[] {
  return files
    .map((filePath) => formatCommitPath(filePath, repoRoot))
    .sort((left, right) => left.localeCompare(right));
}

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function assistantOriginLabel(origins: EditOrigin[]): string {
  if (origins.includes("mixed")) {
    return "mixed";
  }

  const [origin] = origins;
  switch (origin) {
    case "assistant-inline-completion":
      return "inline completion";
    case "assistant-agent-chat":
      return "agent chat";
    case "assistant-tool-edit":
      return "tool edit";
    case "assistant-unknown":
    default:
      return "edits";
  }
}

/** Builds the git commit message for a human or assistant window commit. */
export function formatWindowCommitMessage(
  commit: WindowCommit,
  repoRoot?: string
): string {
  const files = formatCommitPaths(commit.files, repoRoot);

  if (commit.kind === "human") {
    return [
      `${EXTENSION_NAME}: human edits (${fileCountLabel(files.length)})`,
      JSON.stringify({
        kind: commit.kind,
        files,
        startedAt: formatIsoTimestamp(commit.startedAt),
        endedAt: formatIsoTimestamp(commit.endedAt),
      }),
    ].join("\n");
  }

  return [
    `${EXTENSION_NAME}: assistant ${assistantOriginLabel(commit.origins)} (${fileCountLabel(files.length)})`,
    JSON.stringify({
      kind: commit.kind,
      files,
      startedAt: formatIsoTimestamp(commit.startedAt),
      endedAt: formatIsoTimestamp(commit.endedAt),
      eventCount: commit.events.length,
      origins: commit.origins,
      fileAttributions: commit.fileAttributions.map((attribution) => ({
        path: formatCommitPath(attribution.path, repoRoot),
        origin: attribution.origin,
        confidence: attribution.confidence,
        matched: attribution.matched,
      })),
    }),
  ].join("\n");
}
