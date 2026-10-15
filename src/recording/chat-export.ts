import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  COPILOT_CLI_SESSION_FILES,
  findCopilotCliSessionsForRepo,
  getCopilotCliSessionStateDir,
} from "./agents/copilot/cli-sessions";
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

type SessionInfo = { createdAt?: Date; title?: string };

/**
 * Reads the creation time and title of a Copilot Chat session file. `.json`
 * files hold the whole session; `.jsonl` files start with the session and
 * append patches, where a later `customTitle` patch overrides earlier ones.
 */
function chatSessionInfo(raw: string, isJsonl: boolean): SessionInfo {
  const info: SessionInfo = {};
  const apply = (obj: Record<string, unknown> | undefined) => {
    if (typeof obj?.creationDate === "number") info.createdAt = new Date(obj.creationDate);
    if (typeof obj?.customTitle === "string") info.title = obj.customTitle;
  };
  try {
    if (!isJsonl) {
      apply(JSON.parse(raw));
      return info;
    }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    apply(JSON.parse(lines[0] ?? "{}").v);
    for (const line of lines.slice(1)) {
      if (!line.includes('"customTitle"')) continue;
      const patch = JSON.parse(line);
      if (patch.k?.length === 1 && patch.k[0] === "customTitle" && typeof patch.v === "string") {
        info.title = patch.v;
      }
    }
  } catch {
    // Unknown or partially written format: fall back to file time and id.
  }
  return info;
}

/** Builds `YYYY-MM-DD_HHMM_<title-slug>` (local time), falling back to the session id, unique within this export. */
function uniqueSessionName(
  createdAt: Date,
  title: string | undefined,
  id: string,
  used: Set<string>
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${createdAt.getFullYear()}-${pad(createdAt.getMonth() + 1)}-${pad(createdAt.getDate())}` +
    `_${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}`;
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  let name = `${stamp}_${slug || id.slice(0, 8)}`;
  if (used.has(name)) name += `_${id.slice(0, 8)}`;
  used.add(name);
  return name;
}

/**
 * Copies the current workspace's chat sessions into the repository:
 * Copilot Chat sessions from VS Code's per-workspace storage to
 * `.chat-log/copilot-chat/`, and Copilot CLI agent sessions to
 * `.chat-log/copilot-cli/`, each named by start time and title.
 */
export async function exportCurrentWorkspaceChats(
  context: vscode.ExtensionContext,
  repoRoot: string
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

  // Copilot CLI agent sessions live outside VS Code's workspace storage.
  const cliStateDir = getCopilotCliSessionStateDir();
  const cliSessions = await findCopilotCliSessionsForRepo(repoRoot, cliStateDir);

  if (sessionFiles.length === 0 && cliSessions.length === 0) {
    return {
      ok: false,
      msg:
        "No chat sessions found for current workspace.\n" +
        `Checked: ${chatSessionsDir}\n` +
        `Checked: ${cliStateDir} (Copilot CLI sessions for ${repoRoot})`,
    };
  }

  const destDir = path.join(repoRoot, CHAT_EXPORT_PATH);
  const usedNames = new Set<string>();

  if (sessionFiles.length > 0) {
    const chatDestDir = path.join(destDir, "copilot-chat");
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(chatDestDir));
    for (const f of sessionFiles) {
      const srcPath = path.join(chatSessionsDir, f);
      const raw = await fs.promises.readFile(srcPath, "utf8");
      const info = chatSessionInfo(raw, f.endsWith(".jsonl"));
      const name = uniqueSessionName(
        info.createdAt ?? (await fs.promises.stat(srcPath)).mtime,
        info.title,
        path.parse(f).name,
        usedNames
      );
      await fs.promises.writeFile(path.join(chatDestDir, name + path.extname(f)), raw, "utf8");
    }
  }

  for (const { dir, workspace } of cliSessions) {
    const name = uniqueSessionName(
      workspace.createdAt ?? (await fs.promises.stat(path.join(dir, "workspace.yaml"))).mtime,
      workspace.name,
      path.basename(dir),
      usedNames
    );
    const cliDestDir = path.join(destDir, "copilot-cli", name);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(cliDestDir));
    for (const f of COPILOT_CLI_SESSION_FILES) {
      const srcPath = path.join(dir, f);
      if (fs.existsSync(srcPath)) {
        await fs.promises.copyFile(srcPath, path.join(cliDestDir, f));
      }
    }
  }

  return {
    ok: true,
    count: sessionFiles.length + cliSessions.length,
    destDir,
  };
}
