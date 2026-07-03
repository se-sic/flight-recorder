export type ClaudeHookCommand = {
  type: "command";
  command: string;
  args?: string[];
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

export function escapeForDoubleQuotes(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`");
}

export function buildFlightRecorderHookHandler(
  scriptPathExpression: string,
  targetPathExpression: string
): ClaudeHookCommand {
  return {
    type: "command",
    command: scriptPathExpression,
    args: [targetPathExpression],
  };
}

function isFlightRecorderHookCommand(hook: ClaudeHookCommand): boolean {
  return (
    hook.command.includes("flight-recorder-log-hook.sh") ||
    hook.command.includes(FLIGHT_RECORDER_HOOK_LOG_BASENAME) ||
    (hook.args ?? []).some((arg) => arg.includes(FLIGHT_RECORDER_HOOK_LOG_BASENAME))
  );
}

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
            hooks: rule.hooks.filter((hook) => !isFlightRecorderHookCommand(hook)),
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
