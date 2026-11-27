import * as vscode from "vscode";
import { normalizePath } from "../../../utils/fs-path";
import {
  OPENCODE_LOG_RELATIVE_PATH,
  OPENCODE_PLUGIN_RELATIVE_PATH,
} from "./plugin-source";

export type OpenCodeMissingSourceBehavior = "fail" | "wait";

/** Reads the configured behavior (`wait` or `fail`) for when the OpenCode plugin log does not exist yet. */
export function getOpenCodeMissingSourceBehavior(): OpenCodeMissingSourceBehavior {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<OpenCodeMissingSourceBehavior>(
    "openCodeMissingSourceBehavior",
    "wait"
  );
}

/** Resolves the absolute path of the generated OpenCode plugin for a repository. */
export function getOpenCodePluginPath(repoRoot: string): string {
  return normalizePath(repoRoot, OPENCODE_PLUGIN_RELATIVE_PATH);
}

/** Resolves the absolute path of the JSONL log the OpenCode plugin writes for a repository. */
export function getOpenCodeLogPath(repoRoot: string): string {
  return normalizePath(repoRoot, OPENCODE_LOG_RELATIVE_PATH);
}
