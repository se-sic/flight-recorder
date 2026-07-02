import * as vscode from "vscode";
import { AssistantEvent } from "./event";

export type AssistantEventParser = {
  feed(chunk: string): Generator<AssistantEvent>;
};

export type AssistantIntegrationReady =
  | {
      ok: true;
      assistantId: string;
      displayName: string;
      logFile: string;
      logSnapshotPrefix: string;
      parser: AssistantEventParser;
    }
  | {
      ok: "pending";
      assistantId: string;
      displayName: string;
      logSnapshotPrefix: string;
      parser: AssistantEventParser;
      waitMessage: string;
      awaitLogFile: () => Promise<string | null>;
    }
  | {
      ok: false;
      msg: string;
      err?: string;
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
