import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlightRecorderHookHandler,
  FLIGHT_RECORDER_CLAUDE_HOOK_EVENTS,
  FLIGHT_RECORDER_HOOK_LOG_BASENAME,
  mergeFlightRecorderHooks,
} from "../src/recording/claude-hook-config";

test("mergeFlightRecorderHooks appends Flight Recorder hook rules without dropping existing hooks", () => {
  const handler = buildFlightRecorderHookHandler(
    "${CLAUDE_PROJECT_DIR}/.claude/hooks/flight-recorder-log-hook.sh",
    "${CLAUDE_PROJECT_DIR}/.claude/flight-recorder-hooks.jsonl"
  );
  const merged = mergeFlightRecorderHooks(
    {
      hooks: {
        Notification: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "echo existing",
              },
            ],
          },
        ],
      },
      theme: "dark",
    },
    handler
  );

  assert.equal(merged.theme, "dark");
  assert.ok(merged.hooks);

  for (const eventName of FLIGHT_RECORDER_CLAUDE_HOOK_EVENTS) {
    assert.ok(Array.isArray(merged.hooks?.[eventName]));
    assert.ok(
      merged.hooks?.[eventName].some((rule) =>
        rule.hooks.some(
          (hook) =>
            hook.command === handler.command &&
            JSON.stringify(hook.args ?? []) === JSON.stringify(handler.args ?? [])
        )
      )
    );
  }

  assert.ok(
    merged.hooks?.Notification.some((rule) =>
      rule.hooks.some((hook) => hook.command === "echo existing")
    )
  );
});

test("mergeFlightRecorderHooks is idempotent for the same command", () => {
  const handler = buildFlightRecorderHookHandler(
    "${CLAUDE_PROJECT_DIR}/.claude/hooks/flight-recorder-log-hook.sh",
    "${CLAUDE_PROJECT_DIR}/.claude/flight-recorder-hooks.jsonl"
  );
  const once = mergeFlightRecorderHooks({}, handler);
  const twice = mergeFlightRecorderHooks(once, handler);

  for (const eventName of FLIGHT_RECORDER_CLAUDE_HOOK_EVENTS) {
    const matchingRuleCount =
      twice.hooks?.[eventName].filter((rule) =>
        rule.hooks.some(
          (hook) =>
            hook.command === handler.command &&
            JSON.stringify(hook.args ?? []) === JSON.stringify(handler.args ?? [])
        )
      ).length ?? 0;
    assert.equal(matchingRuleCount, 1);
  }
});

test("buildFlightRecorderHookHandler targets the repo-local hook log path", () => {
  const handler = buildFlightRecorderHookHandler(
    "${CLAUDE_PROJECT_DIR}/.claude/hooks/flight-recorder-log-hook.sh",
    "${CLAUDE_PROJECT_DIR}/.claude/flight-recorder-hooks.jsonl"
  );
  assert.equal(handler.command.includes("${CLAUDE_PROJECT_DIR}"), true);
  assert.equal(handler.args?.[0].includes("${CLAUDE_PROJECT_DIR}"), true);
  assert.equal(handler.args?.[0].includes(FLIGHT_RECORDER_HOOK_LOG_BASENAME), true);
});

test("mergeFlightRecorderHooks replaces older Flight Recorder hook definitions", () => {
  const handler = buildFlightRecorderHookHandler(
    "${CLAUDE_PROJECT_DIR}/.claude/hooks/flight-recorder-log-hook.sh",
    "${CLAUDE_PROJECT_DIR}/.claude/flight-recorder-hooks.jsonl"
  );

  const merged = mergeFlightRecorderHooks(
    {
      hooks: {
        SessionEnd: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command:
                  "mkdir -p \"$(dirname \"${CLAUDE_PROJECT_DIR}/.claude/flight-recorder-hooks.jsonl\")\" && cat >> \"${CLAUDE_PROJECT_DIR}/.claude/flight-recorder-hooks.jsonl\"",
              },
            ],
          },
        ],
      },
    },
    handler
  );

  const sessionEndRules = merged.hooks?.SessionEnd ?? [];
  assert.equal(sessionEndRules.length, 1);
  assert.deepEqual(sessionEndRules[0].hooks, [handler]);
});
