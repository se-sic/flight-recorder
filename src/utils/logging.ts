import * as vscode from "vscode";

let globalOutputChannel: vscode.LogOutputChannel | null = null;

export function initializeLogChannel(
  channelName: string
): vscode.LogOutputChannel {
  globalOutputChannel = vscode.window.createOutputChannel(channelName, {
    log: true,
  });
  globalOutputChannel.show(true);
  return globalOutputChannel;
}

export function getLogChannel(): vscode.LogOutputChannel {
  if (!globalOutputChannel) {
    throw new Error(
      "Global output channel not initialized. Call initializeLogChannel first."
    );
  }
  return globalOutputChannel;
}
