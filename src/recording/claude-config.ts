import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type ClaudeSourceMode = "auto" | "transcript" | "hookLog";
export type ClaudeMissingSourceBehavior = "fail" | "wait";

const DEFAULT_CLAUDE_HOOK_LOG_PATH = ".claude/flight-recorder-hooks.jsonl";

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

export function getClaudeSourceMode(): ClaudeSourceMode {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<ClaudeSourceMode>("claudeSource", "auto");
}

export function getClaudeMissingSourceBehavior(): ClaudeMissingSourceBehavior {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<ClaudeMissingSourceBehavior>(
    "claudeMissingSourceBehavior",
    "wait"
  );
}

export function getConfiguredClaudeHookLogSetting(): string {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<string>(
    "claudeHookLogPath",
    DEFAULT_CLAUDE_HOOK_LOG_PATH
  );
}

export function getConfiguredClaudeHookLogPath(repoRoot: string): string {
  const configured = getConfiguredClaudeHookLogSetting();
  if (path.isAbsolute(configured)) {
    return configured;
  }

  return path.resolve(repoRoot, configured);
}

export function getClaudeHookLogPathExpression(repoRoot: string): string {
  const configured = getConfiguredClaudeHookLogSetting();
  if (path.isAbsolute(configured)) {
    return configured;
  }

  const relative = path.relative(repoRoot, path.resolve(repoRoot, configured));
  return "${CLAUDE_PROJECT_DIR}/" + relative.split(path.sep).join("/");
}

export function isClaudeHookSourceMode(sourceMode: ClaudeSourceMode): boolean {
  return sourceMode === "auto" || sourceMode === "hookLog";
}
