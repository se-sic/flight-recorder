export type EventOrigin = "inline-completion" | "agent-edit";

import * as path from "path";
import { getWorkspaceRepoRoot } from "../utils/paths";

export type CompletionEvent = {
  timestamp: string;
  fileUri: string;
  files: string[];
  origin: EventOrigin;
  signal: "ghostText.accepted" | "edit-tool";
  requestId?: string;
  cursorLine?: number;
  cursorColumn?: number;
};

function relativePathsForEvent(ev: CompletionEvent): string[] {
  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder (git repo) before starting the recorder."
  );
  if (!repoRoot) {
    return ["<path-unavailable>"];
  }
  const absEventPaths = Array.from(new Set(ev.files.map((p) => path.resolve(p))));
  const absRepo = path.resolve(repoRoot);
  const relFiles = absEventPaths
    .filter((abs) => abs === absRepo || abs.startsWith(absRepo + path.sep))
    .map((abs) => path.relative(repoRoot, abs))
    .map((rel) => rel.split(path.sep).join("/"));

  return relFiles.length > 0 ? relFiles : ["<file-outside-repo>"];
}

export function formatEventJson(ev: CompletionEvent): string {
  const paths = relativePathsForEvent(ev);
  const cursorPosition = ev.cursorLine === undefined
    ? undefined
    : {
        line: ev.cursorLine,
        column: ev.cursorColumn
      };

  const payload: Record<string, string | string[] | undefined | object> = {
    timestamp: ev.timestamp,
    origin: ev.origin,
    signal: ev.signal,
    files: paths,
    cursorPosition,
    requestId: ev.requestId,
  };

  return JSON.stringify(payload);
}