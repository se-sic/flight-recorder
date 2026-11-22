import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { OpenCodeParser } from "../src/recording/agents/opencode/parser";
import { AssistantEvent } from "../src/recording/event";
import { normalizePath } from "../src/utils/fs-path";

// Real records of the generated OpenCode plugin from live runs (OpenCode
// 2.2.2, 2026-11-27): an edit, a shell command, and a GPT model's write and
// edit. Paths were replaced with /fixture/repo.
const FIXTURE = path.join(__dirname, "..", "..", "..", "test", "fixtures", "opencode-plugin-real.jsonl");
const REPO = normalizePath("/fixture/repo");

/** Parses the fixture and returns each event with the record kind and tool it came from. */
function events(): AssistantEvent[] {
  return Array.from(new OpenCodeParser(REPO).feed(fs.readFileSync(FIXTURE, "utf8")));
}

/** Events whose raw signal is `signal` (e.g. `post:edit`). */
function bySignal(signal: string): AssistantEvent[] {
  return events().filter((event) => event.source.rawSignal === signal);
}

test("real OpenCode records: completed edits carry diff evidence for the repo file", () => {
  const edits = bySignal("post:edit");
  assert.equal(edits.length, 2);
  for (const edit of edits) {
    assert.equal(edit.origin, "assistant-tool-edit");
    assert.deepEqual(edit.fileOperations.map((op) => op.path), [path.join(REPO, "index.js")]);
    assert.ok((edit.evidence?.[0].details?.editTextHashes as string[]).length >= 1);
  }
});

test("real OpenCode records: a shell command is a paired tool run and its step names the file", () => {
  const [started] = bySignal("pre:shell");
  const [finished] = bySignal("post:shell");
  assert.equal(started.toolCall?.phase, "started");
  assert.equal(finished.toolCall?.phase, "finished");
  assert.equal(started.toolCall?.id, finished.toolCall?.id);
  const steps = bySignal("step:snapshot").flatMap((event) => event.fileOperations.map((op) => op.path));
  assert.ok(steps.includes(path.join(REPO, "notes.txt")), steps.join(", "));
});

test("real OpenCode records: write creates a new file, reads and globs claim nothing", () => {
  const [write] = bySignal("post:write");
  assert.deepEqual(write.fileOperations, [{ kind: "create", path: path.join(REPO, "hello.txt") }]);
  for (const signal of ["pre:read", "post:read", "pre:glob", "post:glob"]) {
    for (const event of bySignal(signal)) {
      assert.equal(event.capability, "read-only", signal);
      assert.deepEqual(event.fileOperations, [], signal);
    }
  }
});
