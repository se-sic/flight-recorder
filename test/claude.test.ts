import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { ClaudeCodeParser } from "../src/recording/agents/claude/parser";
import { FineGrainedStagingTracker, hashInsertedText } from "../src/recording/staging-tracker";

// The parser resolves paths, so on Windows this becomes C:\Users\test\...
const APP_PATH = path.resolve("/Users/test/demo/src/app.ts");

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
      path: APP_PATH,
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
      path: APP_PATH,
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
      path: APP_PATH,
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
      path: APP_PATH,
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
      path: APP_PATH,
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
      path: APP_PATH,
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

test("ClaudeCodeParser labels file edits from Claude's tools as assistant tool edits", () => {
  const parser = new ClaudeCodeParser();
  const events = Array.from(
    parser.feed(
      `${JSON.stringify({
        session_id: "session-1",
        cwd: "/Users/test/demo",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/Users/test/demo/src/app.ts", old_string: "a", new_string: "b" },
        tool_response: { filePath: "/Users/test/demo/src/app.ts", success: true },
      })}\n`
    )
  );

  const edit = events.find((event) => event.kind === "edit-applied");
  assert.ok(edit);
  assert.equal(edit.origin, "assistant-tool-edit");
});

/** Feeds hook payloads (one JSON line each) to a fresh parser. */
function parseHooks(...payloads: Array<Record<string, unknown>>) {
  const parser = new ClaudeCodeParser();
  return Array.from(
    parser.feed(payloads.map((payload) => `${JSON.stringify({ session_id: "s", cwd: "/Users/test/demo", ...payload })}\n`).join(""))
  );
}

test("ClaudeCodeParser marks read-only tools so they never claim files", () => {
  const events = parseHooks(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/Users/test/demo/src/app.ts" } },
    { hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: { pattern: "x", path: "/Users/test/demo/src" } }
  );

  assert.deepEqual(events.map((event) => event.capability), ["read-only", "read-only"]);
  assert.equal(events.some((event) => event.toolCall), false);
});

test("ClaudeCodeParser reports start and end of shell commands by tool_use_id", () => {
  const events = parseHooks(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "mv a b" } },
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "mv a b" } },
    { hook_event_name: "PreToolUse", tool_name: "mcp__fs__write", tool_use_id: "t2", tool_input: {} }
  );

  assert.deepEqual(events.map((event) => event.toolCall), [
    { id: "t1", phase: "started" },
    { id: "t1", phase: "finished" },
    { id: "t2", phase: "started" },
  ]);
  assert.equal(events[0].capability, "command");
});

test("ClaudeCodeParser treats Stop and UserPromptSubmit as the end of all running tools", () => {
  const events = parseHooks(
    { hook_event_name: "UserPromptSubmit", prompt: "hi" },
    { hook_event_name: "Stop" },
    { hook_event_name: "SessionStart" }
  );

  assert.deepEqual(
    events.map((event) => [event.capability, event.toolCall]),
    [
      ["read-only", { phase: "finished" }],
      ["read-only", { phase: "finished" }],
    ]
  );
});

const EDIT_INPUT = {
  file_path: "/Users/test/demo/src/app.ts",
  old_string: "export const a = 1;",
  new_string: "// The answer\nexport const a = 1;",
};

test("Claude Edit hooks carry hashes of the new text and of the whole lines it adds", () => {
  const [pre, post] = parseHooks(
    { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: EDIT_INPUT },
    { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: EDIT_INPUT, tool_response: { filePath: EDIT_INPUT.file_path } }
  );

  for (const event of [pre, post]) {
    assert.equal(event.evidence?.length, 1);
    assert.equal(event.evidence?.[0].path, APP_PATH);
    assert.deepEqual(event.evidence?.[0].details?.editTextHashes, [
      hashInsertedText(EDIT_INPUT.new_string),
      hashInsertedText("// The answer\n"),
    ]);
  }
});

test("Claude MultiEdit and Write hooks carry evidence; Bash and Read carry none", () => {
  const [multi, write, bash, read] = parseHooks(
    {
      hook_event_name: "PreToolUse",
      tool_name: "MultiEdit",
      tool_input: { file_path: EDIT_INPUT.file_path, edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
    },
    { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: EDIT_INPUT.file_path, content: "x\n" } },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: EDIT_INPUT.file_path } }
  );

  assert.equal((multi.evidence?.[0].details?.editTextHashes as string[]).length, 4);
  assert.ok((write.evidence?.[0].details?.editTextHashes as string[]).includes(hashInsertedText("x\n")));
  assert.equal(bash.evidence, undefined);
  assert.equal(read.evidence, undefined);
});

test("a Claude edit of an open file is attributed with high confidence when the editor reports the added lines", () => {
  const [pre, post] = parseHooks(
    { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: EDIT_INPUT },
    { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: EDIT_INPUT, tool_response: { filePath: EDIT_INPUT.file_path } }
  );
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(pre, 2_000);
  // VS Code reloads the changed file and reports the inserted line.
  tracker.recordTextDocumentChange(
    [{
      path: APP_PATH,
      insertedTextHashes: [hashInsertedText("// The answer\n")],
      insertedTextLength: 14,
      ranges: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }],
    }],
    2_003
  );
  tracker.recordAssistantEvent(post, 2_005);

  const commit = tracker.flushAssistantWindowIfIdle(5_000);
  assert.ok(commit && commit.kind === "assistant");
  assert.equal(commit.fileAttributions[0].confidence, "high");
  assert.equal(commit.fileAttributions[0].matched, true);
});

test("a Claude edit of a closed file gets medium confidence from its evidence", () => {
  const [pre, post] = parseHooks(
    { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: EDIT_INPUT },
    { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: EDIT_INPUT, tool_response: { filePath: EDIT_INPUT.file_path } }
  );
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(pre, 2_000);
  tracker.recordAssistantEvent(post, 2_005);

  const commit = tracker.flushAssistantWindowIfIdle(5_000);
  assert.ok(commit && commit.kind === "assistant");
  assert.equal(commit.fileAttributions[0].confidence, "medium");
});
