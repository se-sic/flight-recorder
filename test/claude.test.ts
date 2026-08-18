import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeParser } from "../src/recording/agents/claude/parser";

test("ClaudeCodeParser parses FileChanged hook payloads", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        session_id: "session-1",
        transcript_path: "/Users/test/.claude/projects/demo/session-1.jsonl",
        cwd: "/Users/test/demo",
        hook_event_name: "FileChanged",
        file_path: "/Users/test/demo/src/app.ts",
        event: "change",
      })}\n`
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].source.assistantId, "claude-code");
  assert.equal(events[0].source.rawSignal, "FileChanged");
  assert.equal(events[0].kind, "edit-applied");
  assert.deepEqual(events[0].fileOperations, [
    {
      kind: "update",
      path: "/Users/test/demo/src/app.ts",
    },
  ]);
});

test("ClaudeCodeParser opens a tool window for transcript file-edit tool_use blocks", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        sessionId: "session-2",
        timestamp: "2026-06-25T10:00:00.000Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: {
                file_path: "/Users/test/demo/src/app.ts",
              },
            },
          ],
        },
      })}\n`
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].source.rawSignal, "transcript.tool_use");
  assert.equal(events[0].capability, "tool-call");
  assert.equal(events[0].kind, "tool-called");
  assert.equal(events[0].sessionId, "session-2");
  assert.equal(events[0].toolName, "Edit");
  assert.deepEqual(events[0].fileOperations, [
    {
      kind: "update",
      path: "/Users/test/demo/src/app.ts",
    },
  ]);
});

test("ClaudeCodeParser parses successful transcript tool_result file edits", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        sessionId: "session-2",
        timestamp: "2026-06-25T10:00:02.000Z",
        type: "user",
        toolUseResult: {
          filePath: "/Users/test/demo/src/app.ts",
          oldString: "before",
          newString: "after",
          structuredPatch: [],
          userModified: false,
          replaceAll: false,
        },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-123",
              content: "updated",
            },
          ],
        },
      })}\n`
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].source.rawSignal, "transcript.tool_result");
  assert.equal(events[0].capability, "file-edit");
  assert.equal(events[0].kind, "edit-applied");
  assert.equal(events[0].sessionId, "session-2");
  assert.deepEqual(events[0].fileOperations, [
    {
      kind: "update",
      path: "/Users/test/demo/src/app.ts",
    },
  ]);
});

test("ClaudeCodeParser parses hook tool payloads", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        session_id: "session-3",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "npm test",
        },
      })}\n`
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool-called");
  assert.equal(events[0].capability, "command");
  assert.equal(events[0].toolName, "Bash");
});

test("ClaudeCodeParser emits a deferred boundary for hook PreToolUse file edits", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        session_id: "session-3a",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: "/Users/test/demo/src/app.ts",
          content: "hello",
        },
      })}\n`
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool-called");
  assert.equal(events[0].capability, "tool-call");
  assert.equal(events[0].toolName, "Write");
  assert.deepEqual(events[0].fileOperations, [
    {
      kind: "unknown",
      path: "/Users/test/demo/src/app.ts",
    },
  ]);
});

test("ClaudeCodeParser parses confirmed hook PostToolUse file creations", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        session_id: "session-3b",
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: "/Users/test/demo/src/app.ts",
          content: "hello",
        },
        tool_response: {
          type: "create",
          filePath: "/Users/test/demo/src/app.ts",
          content: "hello",
          originalFile: null,
        },
      })}\n`
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "edit-applied");
  assert.equal(events[0].capability, "file-edit");
  assert.equal(events[0].toolName, "Write");
  assert.deepEqual(events[0].fileOperations, [
    {
      kind: "create",
      path: "/Users/test/demo/src/app.ts",
    },
  ]);
});

test("ClaudeCodeParser parses PostToolUseFailure hook payloads", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        session_id: "session-3c",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Write",
        tool_input: {
          file_path: "/Users/test/demo/src/app.ts",
        },
      })}\n`
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool-called");
  assert.equal(events[0].toolName, "Write");
  assert.deepEqual(events[0].fileOperations, [
    {
      kind: "unknown",
      path: "/Users/test/demo/src/app.ts",
    },
  ]);
});

test("ClaudeCodeParser ignores rejected transcript file-edit tool results", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        sessionId: "session-4",
        timestamp: "2026-06-25T10:00:03.000Z",
        type: "user",
        toolDenialKind: "user-rejected",
        toolUseResult: {
          filePath: "/Users/test/demo/src/app.ts",
          oldString: "before",
          newString: "after",
        },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-999",
              content: "rejected",
              is_error: true,
            },
          ],
        },
      })}\n`
    )
  );

  assert.equal(events.length, 0);
});
