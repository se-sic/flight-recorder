import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CHAT_EXPORT_PATH } from "../utils/paths";
import { getLogChannel } from "../utils/logging";

export type ChatExportResult =
  | { ok: true; count: number; destDir: string }
  | { ok: false; msg: string };

/** Lists file (not directory) names in a directory, returning an empty list if the directory can't be read. */
export async function safeReadDirFilesOnly(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Copies the current workspace's chat session files from VS Code's
 * per-workspace storage into the repository under `.chat-log`.
 */
export async function exportCurrentWorkspaceChats(
  context: vscode.ExtensionContext,
  repoRoot: string,
  outputRoot = repoRoot
): Promise<ChatExportResult> {
  const currentWsStorageUri = context.storageUri; // per-workspace storage
  if (!currentWsStorageUri) {
    return {
      ok: false,
      msg: "No per-workspace storage found (context.storageUri is undefined). Open a folder/workspace and try again.",
    };
  }

  const extensionStorageDir = currentWsStorageUri.fsPath;
  const workspaceDir = path.dirname(extensionStorageDir);
  getLogChannel().info(`Current workspace storage: ${workspaceDir}`);
  const chatSessionsDir = path.join(workspaceDir, "chatSessions");

  const sessionFiles = (await safeReadDirFilesOnly(chatSessionsDir)).filter((f) =>
    f.toLowerCase().endsWith(".json") || f.toLowerCase().endsWith(".jsonl")
  );

  if (sessionFiles.length === 0) {
    return {
      ok: false,
      msg: `No chatSessions/*.json found for current workspace.\nChecked: ${chatSessionsDir}`,
    };
  }

  const wid = path.basename(workspaceDir);
  const destDir = path.join(outputRoot, CHAT_EXPORT_PATH, wid, "chatSessions");
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(destDir));

  for (const f of sessionFiles) {
    const srcPath = path.join(chatSessionsDir, f);
    const dstPath = path.join(destDir, f);
    const raw = await fs.promises.readFile(srcPath, "utf8");
    await fs.promises.writeFile(dstPath, raw, "utf8");
  }

  return {
    ok: true,
    count: sessionFiles.length,
    destDir,
  };
}
