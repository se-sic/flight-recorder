import * as vscode from "vscode";

let globalOutputChannel: vscode.LogOutputChannel | null = null;

/** Creates, shows, and registers the extension's single global log output channel. */
export function initializeLogChannel(
  channelName: string
): vscode.LogOutputChannel {
  globalOutputChannel = vscode.window.createOutputChannel(channelName, {
    log: true,
  });
  globalOutputChannel.show(true);
  return globalOutputChannel;
}

/** Returns the global log output channel. Throws if `initializeLogChannel` has not run yet. */
export function getLogChannel(): vscode.LogOutputChannel {
  if (!globalOutputChannel) {
    throw new Error(
      "Global output channel not initialized. Call initializeLogChannel first."
    );
  }
  return globalOutputChannel;
}
