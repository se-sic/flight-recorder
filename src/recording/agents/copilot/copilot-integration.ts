import * as vscode from "vscode";
import { CopilotChatSessionWatcher } from "./chat-session";
import { CopilotLogParser } from "./parser";
import {
  AssistantIntegration,
  AssistantIntegrationReady,
} from "../../integration";
import {
  getCopilotLogFile,
  getWindowLogDirFromContext,
} from "../../../utils/paths";
import { getLogChannel } from "../../../utils/logging";

/**
 * Enables debug-level logging for the GitHub Copilot Chat extension: sets
 * its default log level to Debug, then discovers and invokes the VS Code
 * commands needed to raise the currently active output channel's log
 * level, since Copilot's edit-tool and inline-completion signals are only
 * emitted at debug level.
 */
async function enableCopilotDebugLogging(): Promise<
  | { ok: true }
  | { ok: false; msg: string; err?: string }
> {
  const output = getLogChannel();
  try {
    await vscode.commands.executeCommand(
      "workbench.action.setDefaultLogLevel",
      vscode.LogLevel.Debug,
      "github.copilot-chat"
    );
    output.debug("Set default log level to debug for github.copilot-chat.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.debug(
      `Could not set default log level for github.copilot-chat: ${msg}`
    );
    return {
      ok: false,
      msg: "Could not set the default log level to debug for GitHub Copilot Chat.",
      err: msg,
    };
  }

  try {
    const commands = await vscode.commands.getCommands(true);

    const debugLevelCommand =
      commands.find((c) => c === "workbench.action.output.activeOutputLogLevel.2") ??
      commands.find(
        (c) => c === "workbench.action.output.activeOutputLogLevel.debug"
      ) ??
      null;

    if (!debugLevelCommand) {
      output.debug(
        "Could not find output log-level debug command in this VS Code build."
      );
      return {
        ok: false,
        msg: "Could not find the VS Code command for setting the active output log level to debug.",
      };
    }

    const copilotChatShowOutputCommand =
      commands.find(
        (c) =>
          /workbench\.action\.output\.show\..*copilot-chat.*copilot chat.*\.log$/i.test(
            c
          )
      ) ??
      commands.find((c) =>
        /workbench\.action\.output\.show\..*copilot-chat.*\.log$/i.test(c)
      ) ??
      null;

    if (!copilotChatShowOutputCommand) {
      output.debug(
        "Could not find GitHub Copilot Chat log output channel command."
      );
      return {
        ok: false,
        msg: "Could not find the VS Code command for showing the GitHub Copilot Chat log output channel.",
      };
    }

    try {
      await vscode.commands.executeCommand(copilotChatShowOutputCommand);
      await vscode.commands.executeCommand(debugLevelCommand);
      output.debug(
        `Set active output log level to debug via ${copilotChatShowOutputCommand}.`
      );
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.debug(
        `Could not set active output log level via ${copilotChatShowOutputCommand}: ${msg}`
      );
      return {
        ok: false,
        msg: "Could not set the active GitHub Copilot Chat output log level to debug.",
        err: msg,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.debug(`Failed to discover output commands: ${msg}`);
    return {
      ok: false,
      msg: "Failed to discover the VS Code commands required to enable Copilot debug logging.",
      err: msg,
    };
  }
}

/** Assistant integration for GitHub Copilot Chat, sourcing events by tailing its extension-host debug log file. */
export class CopilotIntegration implements AssistantIntegration {
  readonly assistantId = "github-copilot";
  readonly displayName = "GitHub Copilot";
  readonly logSnapshotPrefix = "copilot";

  /** Locates the Copilot log file and enables debug logging for it, returning it ready to tail or a failure if either step fails. */
  async prepareRecording(
    context: vscode.ExtensionContext,
    _repoRoot: string
  ): Promise<AssistantIntegrationReady> {
    const windowLogDir = getWindowLogDirFromContext(context);
    if (!windowLogDir) {
      return {
        ok: false,
        msg: "Could not locate VS Code window log directory.",
      };
    }

    const logFile = await getCopilotLogFile(vscode.Uri.file(windowLogDir));
    if (!logFile) {
      return {
        ok: false,
        msg: "Could not find Copilot log file.",
      };
    }

    const logSetup = await enableCopilotDebugLogging();
    if (!logSetup.ok) {
      return logSetup;
    }

    return {
      ok: true,
      assistantId: this.assistantId,
      displayName: this.displayName,
      logFile,
      logSnapshotPrefix: this.logSnapshotPrefix,
      parser: new CopilotLogParser(),
      runtimeEventSources: [new CopilotChatSessionWatcher(context)],
    };
  }

  /** Returns the currently discoverable Copilot log file path, or null if the window log directory or log file can't be found. */
  async showPrimaryLogPath(
    context: vscode.ExtensionContext,
    _repoRoot: string
  ): Promise<string | null> {
    const windowLogDir = getWindowLogDirFromContext(context);
    if (!windowLogDir) {
      return null;
    }

    return getCopilotLogFile(vscode.Uri.file(windowLogDir));
  }
}

export const copilotIntegration = new CopilotIntegration();
