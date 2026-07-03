import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { gitCmd } from "../utils/git";
import { getWorkspaceRepoRoot } from "../utils/paths";
import { EXTENSION_NAME } from "../utils/constants";
import {
  buildFlightRecorderHookHandler,
  ClaudeSettings,
  FLIGHT_RECORDER_HOOK_SCRIPT_RELATIVE_PATH,
  mergeFlightRecorderHooks,
} from "./claude-hook-config";
import {
  getClaudeHookLogPathExpression,
  getConfiguredClaudeHookLogPath,
} from "./claude-config";

export type ClaudeHookSettingsScope = "local" | "project";

function getHookScriptPath(repoRoot: string): string {
  return path.join(repoRoot, FLIGHT_RECORDER_HOOK_SCRIPT_RELATIVE_PATH);
}

function getHookScriptPathExpression(repoRoot: string): string {
  return "${CLAUDE_PROJECT_DIR}/" +
    FLIGHT_RECORDER_HOOK_SCRIPT_RELATIVE_PATH.split(path.sep).join("/");
}

function writeHookScript(scriptPath: string): void {
  const script = [
    "#!/bin/sh",
    "set -eu",
    "",
    "if [ \"$#\" -lt 1 ]; then",
    "  exit 1",
    "fi",
    "",
    "target=\"$1\"",
    "mkdir -p \"$(dirname \"$target\")\"",
    "cat >> \"$target\"",
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.chmodSync(scriptPath, 0o755);
}

function cleanupLegacyLiteralHookPath(repoRoot: string): void {
  const legacyRoot = path.join(repoRoot, "${CLAUDE_PROJECT_DIR}");
  const legacyLogPath = path.join(
    legacyRoot,
    ".claude",
    "flight-recorder-hooks.jsonl"
  );

  if (!fs.existsSync(legacyLogPath)) {
    return;
  }

  try {
    fs.rmSync(legacyLogPath);
  } catch {
    return;
  }

  const claudeDir = path.dirname(legacyLogPath);
  const removeIfEmpty = (candidate: string) => {
    try {
      if (fs.existsSync(candidate) && fs.readdirSync(candidate).length === 0) {
        fs.rmdirSync(candidate);
      }
    } catch {
      // ignore cleanup failures; they do not block hook setup
    }
  };

  removeIfEmpty(claudeDir);
  removeIfEmpty(legacyRoot);
}

function readClaudeSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Claude settings file does not contain a JSON object.");
  }

  return parsed as ClaudeSettings;
}

function writeClaudeSettings(settingsPath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function getGitTopLevel(repoRoot: string): Promise<string> {
  const res = await gitCmd(["rev-parse", "--show-toplevel"], repoRoot);
  if (res.code !== 0 || res.out.trim().length === 0) {
    throw new Error("The opened folder is not a git repository.");
  }

  return path.resolve(res.out.trim());
}

function ensureLineInFile(filePath: string, line: string): void {
  const normalizedLine = line.trim();
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8");
    const existingLines = existing.split(/\r?\n/).map((entry) => entry.trim());
    if (existingLines.includes(normalizedLine)) {
      return;
    }
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, existing + prefix + normalizedLine + "\n", "utf8");
}

async function ensureGitExcludeEntries(
  repoRoot: string,
  scope: ClaudeHookSettingsScope,
  hookLogPath: string
): Promise<void> {
  const gitTopLevel = await getGitTopLevel(repoRoot);
  const excludePath = path.join(gitTopLevel, ".git", "info", "exclude");

  if (scope === "local") {
    ensureLineInFile(excludePath, ".claude/settings.local.json");
    ensureLineInFile(excludePath, FLIGHT_RECORDER_HOOK_SCRIPT_RELATIVE_PATH);
  }

  const relativeHookLogPath = path.relative(gitTopLevel, hookLogPath);
  if (
    !relativeHookLogPath.startsWith("..") &&
    !path.isAbsolute(relativeHookLogPath)
  ) {
    ensureLineInFile(excludePath, relativeHookLogPath.split(path.sep).join("/"));
  }
}

function getClaudeSettingsPath(
  repoRoot: string,
  scope: ClaudeHookSettingsScope
): string {
  return path.join(
    repoRoot,
    ".claude",
    scope === "local" ? "settings.local.json" : "settings.json"
  );
}

async function chooseScope(): Promise<ClaudeHookSettingsScope | undefined> {
  const selection = await vscode.window.showQuickPick(
    [
      {
        label: "Local only (Recommended)",
        description: ".claude/settings.local.json",
        detail:
          "Keeps the setup on this machine only. Flight Recorder will add it to .git/info/exclude.",
        scope: "local" as const,
      },
      {
        label: "Shared with project",
        description: ".claude/settings.json",
        detail:
          "Commits the Claude hook setup into the repository for the whole team.",
        scope: "project" as const,
      },
    ],
    {
      title: "Choose where Flight Recorder should install Claude hooks",
      placeHolder: "Select the Claude settings scope",
    }
  );

  return selection?.scope;
}

async function confirmConfiguration(
  settingsPath: string,
  hookLogPath: string,
  scope: ClaudeHookSettingsScope
): Promise<boolean> {
  const scopeLabel =
    scope === "local"
      ? ".claude/settings.local.json"
      : ".claude/settings.json";

  const choice = await vscode.window.showInformationMessage(
    `Flight Recorder will update ${scopeLabel}, write Claude hook payloads to ${hookLogPath}, switch this workspace to the Claude hook-log integration, and ${scope === "local" ? "exclude the generated local settings and hook log from git." : "leave the settings file tracked in git."}`,
    { modal: true },
    "Configure Claude Hooks"
  );

  return choice === "Configure Claude Hooks";
}

async function showPostConfigurationGuidance(): Promise<void> {
  await vscode.window.showInformationMessage(
    `${EXTENSION_NAME} configured Claude hooks. Start a new Claude chat/session in this repository before recording, because chats that were already open can continue running with the old hook state.`,
    "OK"
  );
}

export async function configureClaudeHooks(): Promise<void> {
  const repoRoot = getWorkspaceRepoRoot(
    "Open a folder (git repo) before configuring Claude hooks."
  );
  if (!repoRoot) {
    return;
  }

  const scope = await chooseScope();
  if (!scope) {
    return;
  }

  const settingsPath = getClaudeSettingsPath(repoRoot, scope);
  const hookLogPath = getConfiguredClaudeHookLogPath(repoRoot);
  const hookScriptPath = getHookScriptPath(repoRoot);

  const confirmed = await confirmConfiguration(settingsPath, hookLogPath, scope);
  if (!confirmed) {
    return;
  }

  try {
    const handler = buildFlightRecorderHookHandler(
      getHookScriptPathExpression(repoRoot),
      getClaudeHookLogPathExpression(repoRoot)
    );
    const existingSettings = readClaudeSettings(settingsPath);
    const mergedSettings = mergeFlightRecorderHooks(existingSettings, handler);

    cleanupLegacyLiteralHookPath(repoRoot);
    writeHookScript(hookScriptPath);
    writeClaudeSettings(settingsPath, mergedSettings);
    fs.mkdirSync(path.dirname(hookLogPath), { recursive: true });
    if (!fs.existsSync(hookLogPath)) {
      fs.writeFileSync(hookLogPath, "", "utf8");
    }

    await ensureGitExcludeEntries(repoRoot, scope, hookLogPath);

    const cfg = vscode.workspace.getConfiguration("flightRecorder");
    await cfg.update(
      "activeIntegration",
      "claude-code",
      vscode.ConfigurationTarget.Workspace
    );
    await cfg.update(
      "claudeSource",
      "hookLog",
      vscode.ConfigurationTarget.Workspace
    );
    await cfg.update(
      "claudeMissingSourceBehavior",
      "wait",
      vscode.ConfigurationTarget.Workspace
    );

    await showPostConfigurationGuidance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME} could not configure Claude hooks. ${message}`
    );
  }
}
