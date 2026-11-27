import * as vscode from "vscode";

let globalOutputChannel: vscode.LogOutputChannel | null = null;

/**
 * Wraps a log channel so its methods never throw. VS Code closes the channel
 * while it shuts the extension host down, and a log line written then (e.g.
 * while a recording is being finalized) must not abort the work around it.
 */
function neverThrowing(channel: vscode.LogOutputChannel): vscode.LogOutputChannel {
  return new Proxy(channel, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        try {
          return value.apply(target, args);
        } catch {
          return undefined;
        }
      };
    },
  });
}

/** Creates, shows, and registers the extension's single global log output channel. */
export function initializeLogChannel(
  channelName: string
): vscode.LogOutputChannel {
  globalOutputChannel = neverThrowing(
    vscode.window.createOutputChannel(channelName, { log: true })
  );
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
