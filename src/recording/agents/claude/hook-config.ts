export type ClaudeHookCommand = {
  type: "command";
  command: string;
};

export type ClaudeHookRule = {
  matcher: string;
  hooks: ClaudeHookCommand[];
};

export type ClaudeSettings = {
  $schema?: string;
  hooks?: Record<string, ClaudeHookRule[]>;
  [key: string]: unknown;
};

const CLAUDE_SETTINGS_SCHEMA =
  "https://json.schemastore.org/claude-code-settings.json";

export const FLIGHT_RECORDER_CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
] as const;

export const FLIGHT_RECORDER_HOOK_SCRIPT_RELATIVE_PATH =
  ".claude/hooks/flight-recorder-log-hook.sh";

export const FLIGHT_RECORDER_HOOK_LOG_BASENAME =
  "flight-recorder-hooks.jsonl";

/** Escapes a string for safe embedding inside a double-quoted POSIX shell argument. */
export function escapeForDoubleQuotes(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`");
}

/**
 * Claude Code hook commands are a single shell command line, not a
 * program+args pair: any "args" field is silently dropped, so the target
 * path must be embedded (and quoted) inside the command string itself.
 */
export function buildFlightRecorderHookHandler(
  scriptPathExpression: string,
  targetPathExpression: string
): ClaudeHookCommand {
  return {
    type: "command",
    command: `"${escapeForDoubleQuotes(scriptPathExpression)}" "${escapeForDoubleQuotes(targetPathExpression)}"`,
  };
}

/**
 * Merges the Flight Recorder hook handler into a Claude settings object for
 * every tracked hook event, replacing any previously installed Flight
 * Recorder hook entries while preserving unrelated existing hooks/settings.
 */
export function mergeFlightRecorderHooks(
  settings: ClaudeSettings,
  handler: ClaudeHookCommand
): ClaudeSettings {
  const next: ClaudeSettings = { ...settings };
  if (!next.$schema) {
    next.$schema = CLAUDE_SETTINGS_SCHEMA;
  }

  const hooks: Record<string, ClaudeHookRule[]> = {
    ...(next.hooks ?? {}),
  };

  for (const eventName of FLIGHT_RECORDER_CLAUDE_HOOK_EVENTS) {
    const existingRules = Array.isArray(hooks[eventName])
      ? hooks[eventName]
          .map((rule) => ({
            ...rule,
            hooks: rule.hooks.filter(
              (hook) =>
                !hook.command.includes("flight-recorder-log-hook.sh") &&
                !hook.command.includes(FLIGHT_RECORDER_HOOK_LOG_BASENAME)
            ),
          }))
          .filter((rule) => rule.hooks.length > 0)
      : [];

    existingRules.push({
      matcher: "",
      hooks: [handler],
    });

    hooks[eventName] = existingRules;
  }

  next.hooks = hooks;
  return next;
}
