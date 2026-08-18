import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const LOG_EXPORT_PATH = ".log/"
export const CHAT_EXPORT_PATH = ".chat-log/";
const EXTHOST_DIR_PATTERN = /^exthost\d*$/i;

/** Returns the first opened workspace folder's path, showing an error and returning null if none is open. */
export function getWorkspaceRepoRoot(errorMessage: string): string | null {
  const repoFolder = vscode.workspace.workspaceFolders?.[0];
  if (!repoFolder) {
    vscode.window.showErrorMessage(errorMessage);
    return null;
  }

  return repoFolder.uri.fsPath;
}

/**
 * Walks up from the extension's log directory to find the current window's
 * extension-host log directory (named `exthost` or `exthost<N>` depending on
 * VS Code build), which is where per-extension log files live.
 */
export function getWindowLogDirFromContext(
  context: vscode.ExtensionContext
): string | null {
  let cur = context.logUri.fsPath;

  // Walk up until we find a folder containing an extension-host log
  // directory. Desktop VS Code names it "exthost1"; other builds have used
  // plain "exthost", so match either.
  for (let i = 0; i < 8; i++) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const exthostEntry = entries.find(
      (entry) => entry.isDirectory() && EXTHOST_DIR_PATTERN.test(entry.name)
    );
    if (exthostEntry) {
      return path.join(cur, exthostEntry.name); // .../logs/<timestamp>/exthostN
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return null;
}

/**
 * Locates the most likely GitHub Copilot Chat log file inside an
 * extension-host log directory, scoring candidates by filename pattern,
 * size, and recency, with fallbacks for less common VS Code log layouts.
 */
export async function getCopilotLogFile(
  logDir: vscode.Uri
): Promise<string | null> {
  const exthostDir = logDir.fsPath;
  if (!fs.existsSync(exthostDir)) return null;

  const extDirs = ["GitHub.copilot-chat", "GitHub.copilot"];

  type Candidate = {
    filePath: string;
    baseName: string;
    size: number;
    mtimeMs: number;
    score: number;
  };

  const lower = (s: string) => s.toLowerCase();

  const scoreName = (name: string): number => {
    const n = lower(name);
    if (n === "github copilot chat.log") return 1_000_000;
    if (n === "github copilot.log") return 900_000;
    if (n.includes("copilot") && n.includes("chat") && n.endsWith(".log")) return 800_000;
    if (n.includes("copilot") && n.endsWith(".log")) return 700_000;
    if (n.endsWith(".log")) return 100_000;
    return 0;
  };

  const candidates: Candidate[] = [];

  // 1) Collect candidates in known extension log directories (chat + copilot)
  for (const dirName of extDirs) {
    const dirPath = path.join(exthostDir, dirName);
    if (!fs.existsSync(dirPath)) continue;
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const nameScore = scoreName(file);
      if (nameScore === 0) continue;

      // Prefer likely copilot filenames first, then larger and newer files.
      const sizeScore = Math.min(Math.floor(st.size / 1024), 5000);
      const recencyScore = Math.floor(st.mtimeMs / 1000);
      const score = nameScore * 1_000_000 + sizeScore * 10_000 + recencyScore;

      candidates.push({
        filePath,
        baseName: file,
        size: st.size,
        mtimeMs: st.mtimeMs,
        score,
      });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].filePath;
  }

  // 2) Rare layout: exthost/GitHub.copilot is a file
  const maybeFile = path.join(exthostDir, "GitHub.copilot");
  if (fs.existsSync(maybeFile) && fs.statSync(maybeFile).isFile()) {
    return maybeFile;
  }

  // 3) Fallback: exthost.log sometimes contains Copilot traces
  const exthostLog = path.join(exthostDir, "exthost.log");
  if (fs.existsSync(exthostLog)) return exthostLog;

  return null;
}
