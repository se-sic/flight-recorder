import * as fs from "fs";
import * as vscode from "vscode";
import { OpenCodeParser } from "./parser";
import {
  AssistantIntegration,
  AssistantIntegrationReady,
  AssistantIntegrationSetupAction,
} from "../../integration";
import { getLogChannel } from "../../../utils/logging";
import {
  getOpenCodeLogPath,
  getOpenCodeMissingSourceBehavior,
  getOpenCodePluginPath,
} from "./config";
import {
  OPENCODE_PLUGIN_SCHEMA_VERSION,
  readOpenCodePluginSchemaVersion,
} from "./plugin-source";

const CONFIGURE_PLUGIN_ACTION: AssistantIntegrationSetupAction = {
  command: "flightRecorder.configureOpenCodePlugin",
  title: "Configure OpenCode Plugin",
  message: "The Flight Recorder OpenCode plugin is not installed in this repository yet.",
};

/** Reads the schema version of the installed plugin, or null if it is missing or not ours. */
function installedPluginSchemaVersion(pluginPath: string): number | null {
  try {
    return readOpenCodePluginSchemaVersion(fs.readFileSync(pluginPath, "utf8"));
  } catch {
    return null;
  }
}

/** Assistant integration for OpenCode (>= 2.0), sourcing events from the JSONL log of the generated Flight Recorder plugin. */
export class OpenCodeIntegration implements AssistantIntegration {
  readonly assistantId = "opencode";
  readonly displayName = "OpenCode";
  readonly logSnapshotPrefix = "opencode";

  /** Checks the plugin install and returns the log as ready, pending (plugin installed but not yet loaded), or failed. */
  async prepareRecording(
    _context: vscode.ExtensionContext,
    repoRoot: string
  ): Promise<AssistantIntegrationReady> {
    const pluginPath = getOpenCodePluginPath(repoRoot);
    const logPath = getOpenCodeLogPath(repoRoot);
    const schemaVersion = installedPluginSchemaVersion(pluginPath);

    if (schemaVersion === null) {
      return {
        ok: false,
        msg: `The Flight Recorder OpenCode plugin is not installed at ${pluginPath}. Run "Flight Recorder: Configure OpenCode Plugin" first.`,
        setupAction: CONFIGURE_PLUGIN_ACTION,
      };
    }

    if (schemaVersion < OPENCODE_PLUGIN_SCHEMA_VERSION) {
      getLogChannel().warn(
        `OpenCode plugin at ${pluginPath} uses schema ${schemaVersion}; current is ${OPENCODE_PLUGIN_SCHEMA_VERSION}.`
      );
      void vscode.window
        .showWarningMessage(
          "The Flight Recorder OpenCode plugin in this repository is outdated. Update it so recordings use the current format.",
          CONFIGURE_PLUGIN_ACTION.title
        )
        .then((choice) => {
          if (choice === CONFIGURE_PLUGIN_ACTION.title) {
            void vscode.commands.executeCommand(CONFIGURE_PLUGIN_ACTION.command);
          }
        });
    }

    if (fs.existsSync(logPath)) {
      return {
        ok: true,
        assistantId: this.assistantId,
        displayName: this.displayName,
        logFile: logPath,
        logSnapshotPrefix: this.logSnapshotPrefix,
        parser: new OpenCodeParser(),
      };
    }

    if (getOpenCodeMissingSourceBehavior() === "wait") {
      return {
        ok: "pending",
        assistantId: this.assistantId,
        displayName: this.displayName,
        logSnapshotPrefix: this.logSnapshotPrefix,
        parser: new OpenCodeParser(),
        waitMessage: `Waiting for OpenCode to load the Flight Recorder plugin and create ${logPath}. Start OpenCode in this repository.`,
        awaitLogFile: async () => (fs.existsSync(logPath) ? logPath : null),
        setupAction: CONFIGURE_PLUGIN_ACTION,
      };
    }

    return {
      ok: false,
      msg: `Could not find the OpenCode plugin log at ${logPath}. Start OpenCode in this repository once so it loads the plugin.`,
      setupAction: CONFIGURE_PLUGIN_ACTION,
    };
  }

  /** Returns the OpenCode plugin log path if it exists. */
  async showPrimaryLogPath(
    _context: vscode.ExtensionContext,
    repoRoot: string
  ): Promise<string | null> {
    const logPath = getOpenCodeLogPath(repoRoot);
    return fs.existsSync(logPath) ? logPath : null;
  }
}

export const openCodeIntegration = new OpenCodeIntegration();
