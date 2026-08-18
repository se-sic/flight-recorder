import * as vscode from "vscode";
import { AssistantEvent } from "./event";
import { claudeCodeIntegration } from "./agents/claude/claude-integration";
import { copilotIntegration } from "./agents/copilot/copilot-integration";

export type AssistantEventParser = {
  feed(chunk: string): Generator<AssistantEvent>;
};

export type AssistantRuntimeEventSource = {
  start(
    onEvent: (event: AssistantEvent) => void
  ): vscode.Disposable | Promise<vscode.Disposable>;
};

export type AssistantIntegrationSetupAction = {
  command: string;
  title: string;
  message: string;
};

export type AssistantIntegrationReady =
  | {
      ok: true;
      assistantId: string;
      displayName: string;
      logFile: string;
      logSnapshotPrefix: string;
      parser: AssistantEventParser;
      runtimeEventSources?: AssistantRuntimeEventSource[];
    }
  | {
      ok: "pending";
      assistantId: string;
      displayName: string;
      logSnapshotPrefix: string;
      parser: AssistantEventParser;
      runtimeEventSources?: AssistantRuntimeEventSource[];
      waitMessage: string;
      awaitLogFile: () => Promise<string | null>;
      setupAction?: AssistantIntegrationSetupAction;
    }
  | {
      ok: false;
      msg: string;
      err?: string;
      setupAction?: AssistantIntegrationSetupAction;
    };

export interface AssistantIntegration {
  readonly assistantId: string;
  readonly displayName: string;
  readonly logSnapshotPrefix: string;

  prepareRecording(
    context: vscode.ExtensionContext,
    repoRoot: string
  ): Promise<AssistantIntegrationReady>;

  showPrimaryLogPath(
    context: vscode.ExtensionContext,
    repoRoot: string
  ): Promise<string | null>;
}

export const AVAILABLE_ASSISTANT_INTEGRATIONS: AssistantIntegration[] = [
  copilotIntegration,
  claudeCodeIntegration,
];

const integrationById = new Map<string, AssistantIntegration>(
  AVAILABLE_ASSISTANT_INTEGRATIONS.map((integration) => [
    integration.assistantId,
    integration,
  ])
);

/** Lists the assistant IDs of every built-in integration. */
export function getAvailableAssistantIntegrationIds(): string[] {
  return AVAILABLE_ASSISTANT_INTEGRATIONS.map(
    (integration) => integration.assistantId
  );
}

/**
 * Sentinel value for `flightRecorder.activeIntegration` that opts into a
 * per-session picker instead of a fixed assistant.
 */
export const ASK_ON_STARTUP_INTEGRATION_ID = "askOnStartup";

/** Reads the raw `flightRecorder.activeIntegration` setting value (an assistant ID, or the ask-on-startup sentinel). */
export function getConfiguredIntegrationId(): string {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  return cfg.get<string>("activeIntegration", copilotIntegration.assistantId);
}

/** Resolves the configured assistant integration, or null if the setting names an unknown ID (including the ask-on-startup sentinel). */
export function getActiveAssistantIntegration(): AssistantIntegration | null {
  return integrationById.get(getConfiguredIntegrationId()) ?? null;
}

/**
 * Prompts the user to pick which assistant to monitor for the upcoming
 * recording session, so only that assistant's log source is discovered and
 * tailed. Returns undefined if the user cancels the picker.
 */
export async function pickAssistantIntegration(
  defaultAssistantId: string
): Promise<AssistantIntegration | undefined> {
  const items = AVAILABLE_ASSISTANT_INTEGRATIONS.map((integration) => ({
    label: integration.displayName,
    description:
      integration.assistantId === defaultAssistantId ? "Current default" : undefined,
    integration,
  }));

  const selection = await vscode.window.showQuickPick(items, {
    title: "Select the assistant to monitor",
    placeHolder: "Flight Recorder will only track this assistant for the session",
  });

  return selection?.integration;
}
