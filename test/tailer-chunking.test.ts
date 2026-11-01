import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { ClaudeCodeParser } from "../src/recording/agents/claude/parser";
import { CopilotLogParser } from "../src/recording/agents/copilot/parser";
import { AssistantEventParser } from "../src/recording/integration";
import { AssistantEvent } from "../src/recording/event";
import { Tailer } from "../src/utils/tailer";
import { makeTempDir } from "./git-fixtures";

// --- U7: Tailer ---

test("Tailer started from the end returns only content appended afterwards", () => {
  const file = path.join(makeTempDir("fr-test-tail-"), "log.jsonl");
  fs.writeFileSync(file, "old line\n");
  const tailer = new Tailer(file);
  tailer.open();
  tailer.startFromEnd();

  assert.equal(tailer.readNew(), "");
  fs.appendFileSync(file, "first\n");
  fs.appendFileSync(file, "second\n");
  assert.equal(tailer.readNew(), "first\nsecond\n");
  assert.equal(tailer.readNew(), "");
  tailer.close();
  assert.equal(tailer.readNew(), "");
});

test("Tailer restarts from the beginning when the file is truncated or replaced", () => {
  const file = path.join(makeTempDir("fr-test-tail-"), "log.jsonl");
  fs.writeFileSync(file, "a long line before rotation\n");
  const tailer = new Tailer(file);
  tailer.open();
  tailer.startFromEnd();

  fs.writeFileSync(file, "new\n");
  assert.equal(tailer.readNew(), "new\n");
  tailer.close();
});

test("Tailer passes multi-byte characters split across appends through intact", () => {
  const file = path.join(makeTempDir("fr-test-tail-"), "log.jsonl");
  fs.writeFileSync(file, "");
  const tailer = new Tailer(file);
  tailer.open();
  tailer.startFromEnd();
  const bytes = Buffer.from("größe ✓\n", "utf8");

  let text = "";
  for (let i = 0; i < bytes.length; i++) {
    fs.appendFileSync(file, bytes.subarray(i, i + 1));
    text += tailer.readNew();
  }

  assert.equal(text, "größe ✓\n");
  tailer.close();
});

// --- U8: parsers fed arbitrary chunks ---

/** Reduces an event to its stable, comparable fields. */
function summarize(event: AssistantEvent) {
  return {
    kind: event.kind,
    capability: event.capability,
    rawSignal: event.source.rawSignal,
    origin: event.origin,
    toolName: event.toolName,
    requestId: event.requestId,
    files: event.fileOperations?.map((op) => `${op.kind}:${op.path}`),
  };
}

/** Feeds `input` to a fresh parser in pieces of the given sizes (cycled). */
function feedInChunks(makeParser: () => AssistantEventParser, input: string, sizes: number[]) {
  const parser = makeParser();
  const events: AssistantEvent[] = [];
  let offset = 0;
  for (let i = 0; offset < input.length; i++) {
    const size = sizes[i % sizes.length];
    events.push(...parser.feed(input.slice(offset, offset + size)));
    offset += size;
  }
  return events.map(summarize);
}

/** Asserts that chunked feeding yields the same events as feeding everything at once. */
function assertChunkingInvariant(makeParser: () => AssistantEventParser, input: string) {
  const whole = Array.from(makeParser().feed(input)).map(summarize);
  assert.ok(whole.length > 0, "fixture should produce events");
  for (const sizes of [[1], [7], [64], [3, 50, 11], [input.length - 1, 1]]) {
    assert.deepEqual(feedInChunks(makeParser, input, sizes), whole, `chunk sizes ${sizes.join(",")}`);
  }
}

const CLAUDE_HOOK_LOG = [
  {
    session_id: "s1",
    cwd: "/Users/test/demo",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/Users/test/demo/src/app.ts", old_string: "a", new_string: "ä ✓" },
  },
  {
    session_id: "s1",
    cwd: "/Users/test/demo",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/Users/test/demo/src/app.ts", old_string: "a", new_string: "ä ✓" },
    tool_response: { filePath: "/Users/test/demo/src/app.ts", success: true },
  },
  {
    session_id: "s1",
    cwd: "/Users/test/demo",
    hook_event_name: "FileChanged",
    file_path: "/Users/test/demo/src/other.ts",
    event: "change",
  },
].map((line) => `${JSON.stringify(line)}\n`).join("");

const COPILOT_LOG = [
  "2026-04-28 10:12:56.872 [debug] [edit-tool:efcf0ac7-59d2-4c9b-b0d4-4d84a23ce134] " +
    "[{\"input\":\"*** Begin Patch\\n*** Update File: /tmp/demo/foo.py\\n@@\\n-x\\n+y\\n*** End Patch\",\"success\":true}]",
  "2026-04-28 10:48:28.385 [debug] [getCompletions] Requesting for file:///tmp/demo/foo.py " +
    "at 13:0 between \"a\\r\\n\" and \"\\r\\n\".",
  "2026-04-28 10:48:28.900 [debug] [postInsertion] ghostText.accepted choiceIndex: 0 Inserted at 123",
].map((line) => `${line}\n`).join("");

test("ClaudeCodeParser yields the same events however the hook log is chunked", () => {
  assertChunkingInvariant(() => new ClaudeCodeParser(), CLAUDE_HOOK_LOG);
});

test("CopilotLogParser yields the same events however the log is chunked", () => {
  assertChunkingInvariant(() => new CopilotLogParser(), COPILOT_LOG);
});
