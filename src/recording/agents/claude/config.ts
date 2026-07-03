import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type ClaudeSourceMode = "auto" | "transcript" | "hookLog";
export type ClaudeMissingSourceBehavior = "fail" | "wait";

const DEFAULT_CLAUDE_HOOK_LOG_PATH = ".claude/flight-recorder-hooks.jsonl";

/** Resolves the Claude configuration directory: the `claudeConfigDir` setting, then `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
export function getClaudeConfigDir(): string {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  const configured = cfg.get<string>("claudeConfigDir", "").trim();
  if (configured.length > 0) {
    return path.resolve(configured);
  }

  const envConfigured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envConfigured) {
    return path.resolve(envConfigured);
  }

  return path.join(os.homedir(), ".claude");
}

/** Reads the configured Claude source mode (`auto`, `transcript`, or `hookLog`). */
export function getClaudeSourceMode(): ClaudeSourceMode {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<ClaudeSourceMode>("claudeSource", "auto");
}

/** Reads the configured behavior (`wait` or `fail`) for when no Claude source exists yet. */
export function getClaudeMissingSourceBehavior(): ClaudeMissingSourceBehavior {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<ClaudeMissingSourceBehavior>(
    "claudeMissingSourceBehavior",
    "wait"
  );
}

/** Reads the raw configured hook log path setting (relative or absolute). */
export function getConfiguredClaudeHookLogSetting(): string {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<string>(
    "claudeHookLogPath",
    DEFAULT_CLAUDE_HOOK_LOG_PATH
  );
}

/** Resolves the configured hook log path to an absolute filesystem path (relative paths resolve against the repo root). */
export function getConfiguredClaudeHookLogPath(repoRoot: string): string {
  const configured = getConfiguredClaudeHookLogSetting();
  if (path.isAbsolute(configured)) {
    return configured;
  }

  return path.resolve(repoRoot, configured);
}

/** Builds the hook log path as a `${CLAUDE_PROJECT_DIR}`-relative expression for embedding into a Claude hook command. */
export function getClaudeHookLogPathExpression(repoRoot: string): string {
  const configured = getConfiguredClaudeHookLogSetting();
  if (path.isAbsolute(configured)) {
    return configured;
  }

  const relative = path.relative(repoRoot, path.resolve(repoRoot, configured));
  return "${CLAUDE_PROJECT_DIR}/" + relative.split(path.sep).join("/");
}

/** Returns whether a source mode should consider the hook log as a candidate source. */
export function isClaudeHookSourceMode(sourceMode: ClaudeSourceMode): boolean {
  return sourceMode === "auto" || sourceMode === "hookLog";
}
