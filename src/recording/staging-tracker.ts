import * as path from "path";
import {
  AssistantEvent,
  collectEventFilePaths,
  formatAssistantEventJson,
} from "./event";
import { EXTENSION_NAME } from "../utils/constants";

export type HumanWindowCommit = {
  kind: "human";
  files: string[];
  startedAt: number;
  endedAt: number;
};

export type AssistantWindowCommit = {
  kind: "assistant";
  files: string[];
  startedAt: number;
  endedAt: number;
  events: AssistantEvent[];
};

export type WindowCommit = HumanWindowCommit | AssistantWindowCommit;

type HumanWindowState = {
  kind: "human";
  files: Set<string>;
  startedAt: number | null;
  endedAt: number | null;
};

type AssistantWindowState = {
  kind: "assistant";
  files: Set<string>;
  startedAt: number;
  lastActivityAt: number;
  events: AssistantEvent[];
  awaitingMaterialization: boolean;
};

function normalizePaths(paths: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(paths)
        .filter((candidate) => candidate.trim().length > 0)
        .map((candidate) => path.resolve(candidate))
    )
  ).sort((left, right) => left.localeCompare(right));
}

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
  };
}

export class FineGrainedStagingTracker {
  private humanState: HumanWindowState = {
    kind: "human",
    files: new Set<string>(),
    startedAt: null,
    endedAt: null,
  };

  private assistantState: AssistantWindowState | null = null;

  constructor(private readonly assistantDebounceMs: number) {}

  private isDeferredAssistantBoundary(event: AssistantEvent): boolean {
    return (
      event.kind === "tool-called" &&
      event.capability === "tool-call" &&
      collectEventFilePaths(event).length > 0
    );
  }

  /**
   * Records file changes coming from VS Code workspace events.
   *
   * While no assistant window is active, the change belongs to the current
   * human window. Once an assistant event starts a window, every subsequent
   * change until the debounce timeout expires is attributed to the assistant
   * window. This matches the study design: "everything before the agent event
   * is human, everything after it until the quiet period ends is assistant."
   */
  recordHumanChange(paths: Iterable<string>, at = Date.now()): void {
    const normalized = normalizePaths(paths);
    if (normalized.length === 0) {
      return;
    }

    if (this.assistantState) {
      for (const filePath of normalized) {
        this.assistantState.files.add(filePath);
      }
      this.assistantState.lastActivityAt = at;
      this.assistantState.awaitingMaterialization = false;
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

  recordAssistantEvent(
    event: AssistantEvent,
    at = Date.now()
  ): WindowCommit[] {
    const commits: WindowCommit[] = [];
    const assistantPaths = normalizePaths(collectEventFilePaths(event));

    // VS Code document-change events can arrive slightly before the matching
    // assistant event from the active integration. If the first assistant event touches a file that is
    // still sitting in the open human bucket, treat that overlap as assistant
    // owned so we do not commit the already-modified file contents as human.
    for (const filePath of assistantPaths) {
      this.humanState.files.delete(filePath);
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
    };

    if (!this.assistantState) {
      const awaitingMaterialization = this.isDeferredAssistantBoundary(event);
      this.assistantState = {
        kind: "assistant",
        files: new Set<string>(),
        startedAt: at,
        lastActivityAt: at,
        events: [],
        awaitingMaterialization,
      };
    }

    this.assistantState.lastActivityAt = at;
    this.assistantState.events.push(event);
    if (!this.isDeferredAssistantBoundary(event)) {
      this.assistantState.awaitingMaterialization = false;
    }
    for (const filePath of assistantPaths) {
      this.assistantState.files.add(filePath);
    }

    return commits;
  }

  flushAssistantWindowIfIdle(at = Date.now()): WindowCommit | null {
    if (!this.assistantState) {
      return null;
    }

    if (
      this.assistantState.awaitingMaterialization ||
      (
      this.assistantDebounceMs > 0 &&
      at - this.assistantState.lastActivityAt < this.assistantDebounceMs
      )
    ) {
      return null;
    }

    const commit = finalizeAssistantWindow(this.assistantState);
    this.assistantState = null;
    return commit;
  }

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
    };

    return commits;
  }
}

function formatIsoTimestamp(at: number): string {
  return new Date(at).toISOString();
}

export function formatWindowCommitMessage(
  commit: WindowCommit,
  repoRoot?: string
): string {
  if (commit.kind === "human") {
    return [
      `${EXTENSION_NAME}: human edits`,
      JSON.stringify({
        kind: commit.kind,
        files: commit.files,
        startedAt: formatIsoTimestamp(commit.startedAt),
        endedAt: formatIsoTimestamp(commit.endedAt),
      }),
    ].join("\n");
  }

  return [
    `${EXTENSION_NAME}: assistant edits`,
    JSON.stringify({
      kind: commit.kind,
      files: commit.files,
      startedAt: formatIsoTimestamp(commit.startedAt),
      endedAt: formatIsoTimestamp(commit.endedAt),
      eventCount: commit.events.length,
    }),
    ...commit.events.map((event) => formatAssistantEventJson(event, repoRoot)),
  ].join("\n");
}
