import * as vscode from "vscode";
import { claudeCodeIntegration } from "./claude";
import { copilotIntegration } from "./copilot";
import { AssistantIntegration } from "./integration";

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

export function getAvailableAssistantIntegrationIds(): string[] {
  return AVAILABLE_ASSISTANT_INTEGRATIONS.map(
    (integration) => integration.assistantId
  );
}

export function getActiveAssistantIntegration(): AssistantIntegration | null {
  const cfg = vscode.workspace.getConfiguration("flightRecorder");
  const configuredId = cfg.get<string>(
    "activeIntegration",
    copilotIntegration.assistantId
  );

  return integrationById.get(configuredId) ?? null;
}
