import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ClaudeCodeParser } from "./claude-parser";
import {
  AssistantIntegration,
  AssistantIntegrationReady,
} from "./integration";

type ClaudeSourceMode = "auto" | "transcript" | "hookLog";
type ClaudeMissingSourceBehavior = "fail" | "wait";

function getClaudeConfigDir(): string {
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

function getClaudeSourceMode(): ClaudeSourceMode {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<ClaudeSourceMode>("claudeSource", "auto");
}

function getClaudeMissingSourceBehavior(): ClaudeMissingSourceBehavior {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<ClaudeMissingSourceBehavior>(
    "claudeMissingSourceBehavior",
    "wait"
  );
}

function getConfiguredClaudeHookLogPath(repoRoot: string): string {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  const configured = cfg.get<string>(
    "claudeHookLogPath",
    ".claude/flight-recorder-hooks.jsonl"
  );

  if (path.isAbsolute(configured)) {
    return configured;
  }

  return path.resolve(repoRoot, configured);
}

function looksLikeTranscriptFile(filePath: string): boolean {
  return (
    filePath.toLowerCase().endsWith(".jsonl") &&
    !filePath.includes(`${path.sep}subagents${path.sep}`)
  );
}

function listFilesRecursive(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  return files;
}

function pickNewestFile(filePaths: string[]): string | null {
  let bestPath: string | null = null;
  let bestMtime = Number.NEGATIVE_INFINITY;

  for (const filePath of filePaths) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs > bestMtime) {
        bestMtime = stats.mtimeMs;
        bestPath = filePath;
      }
    } catch {
      continue;
    }
  }

  return bestPath;
}

function transcriptBelongsToRepo(filePath: string, repoRoot: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines.slice(0, 40)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }

      const cwd = (parsed as { cwd?: unknown }).cwd;
      if (typeof cwd === "string") {
        return path.resolve(cwd) === path.resolve(repoRoot);
      }
    }
  } catch {
    return false;
  }

  return false;
}

function discoverClaudeTranscriptFile(
  configDir: string,
  repoRoot: string
): string | null {
  const projectsDir = path.join(configDir, "projects");
  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const allFiles = listFilesRecursive(projectsDir).filter(looksLikeTranscriptFile);
  if (allFiles.length === 0) {
    return null;
  }

  const matching = allFiles.filter((filePath) =>
    transcriptBelongsToRepo(filePath, repoRoot)
  );

  if (matching.length === 0) {
    return null;
  }

  return pickNewestFile(matching);
}

export class ClaudeCodeIntegration implements AssistantIntegration {
  readonly assistantId = "claude-code";
  readonly displayName = "Claude Code";
  readonly logSnapshotPrefix = "claude";

  async prepareRecording(
    _context: vscode.ExtensionContext,
    repoRoot: string
  ): Promise<AssistantIntegrationReady> {
    const sourceMode = getClaudeSourceMode();
    const missingSourceBehavior = getClaudeMissingSourceBehavior();
    const hookLogPath = getConfiguredClaudeHookLogPath(repoRoot);
    const configDir = getClaudeConfigDir();

    const discoverLogFile = (): string | null => {
      const transcriptPath = discoverClaudeTranscriptFile(configDir, repoRoot);

      if (
        (sourceMode === "auto" || sourceMode === "hookLog") &&
        fs.existsSync(hookLogPath)
      ) {
        return hookLogPath;
      }

      if (
        (sourceMode === "auto" || sourceMode === "transcript") &&
        transcriptPath
      ) {
        return transcriptPath;
      }

      return null;
    };

    const logFile = discoverLogFile();

    if (!logFile) {
      if (missingSourceBehavior === "wait") {
        return {
          ok: "pending",
          assistantId: this.assistantId,
          displayName: this.displayName,
          logSnapshotPrefix: this.logSnapshotPrefix,
          parser: new ClaudeCodeParser(),
          waitMessage:
            sourceMode === "hookLog"
              ? `Waiting for Claude hook log creation at ${hookLogPath}.`
              : `Waiting for the first Claude session source for this repo. Hooks path: ${hookLogPath}; transcripts root: ${path.join(configDir, "projects")}.`,
          awaitLogFile: async () => discoverLogFile(),
        };
      }

      return {
        ok: false,
        msg:
          sourceMode === "hookLog"
            ? `Could not find the configured Claude hook log at ${hookLogPath}.`
            : `Could not find a Claude transcript or hook log for this project. Searched for hooks at ${hookLogPath} and transcripts under ${path.join(configDir, "projects")}.`,
      };
    }

    return {
      ok: true,
      assistantId: this.assistantId,
      displayName: this.displayName,
      logFile,
      logSnapshotPrefix: this.logSnapshotPrefix,
      parser: new ClaudeCodeParser(),
    };
  }

  async showPrimaryLogPath(
    _context: vscode.ExtensionContext,
    repoRoot: string
  ): Promise<string | null> {
    const sourceMode = getClaudeSourceMode();
    const hookLogPath = getConfiguredClaudeHookLogPath(repoRoot);
    if (
      (sourceMode === "auto" || sourceMode === "hookLog") &&
      fs.existsSync(hookLogPath)
    ) {
      return hookLogPath;
    }

    return discoverClaudeTranscriptFile(getClaudeConfigDir(), repoRoot);
  }
}

export const claudeCodeIntegration = new ClaudeCodeIntegration();
