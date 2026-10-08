export const EXTENSION_NAME = "Flight Recorder";
export const OUTPUT_CHANNEL_NAME = EXTENSION_NAME;
export const LOG_EXPORT_PATH = ".log/";
export const CHAT_EXPORT_PATH = ".chat-log/";
export const COMMAND_STATUS = {
  started: `${EXTENSION_NAME} started.`,
  stopped: `${EXTENSION_NAME} stopped.`,
  notRunning: `${EXTENSION_NAME} is not running.`,
  alreadyRunning: `${EXTENSION_NAME} is already running.`
} as const;
