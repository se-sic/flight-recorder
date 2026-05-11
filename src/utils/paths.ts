import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const LOG_EXPORT_PATH = ".log/"
export const CHAT_EXPORT_PATH = ".chat-log/";

export function getWorkspaceRepoRoot(errorMessage: string): string | null {
  const repoFolder = vscode.workspace.workspaceFolders?.[0];
  if (!repoFolder) {
    vscode.window.showErrorMessage(errorMessage);
    return null;
  }

  return repoFolder.uri.fsPath;
}

export function getWindowLogDirFromContext(
  context: vscode.ExtensionContext
): string | null {
  let cur = context.logUri.fsPath;

  // Walk up until we find a folder containing "exthost"
  for (let i = 0; i < 8; i++) {
    const exthost = path.join(cur, "exthost");
    if (fs.existsSync(exthost) && fs.statSync(exthost).isDirectory()) {
      return cur; // this is .../logs/<timestamp>/windowXX
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return null;
}

export async function getCopilotLogFile(
  logDir: vscode.Uri
): Promise<string | null> {
  const exthostDir = path.join(logDir.fsPath, "exthost");
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
