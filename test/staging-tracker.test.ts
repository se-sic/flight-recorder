import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
  FineGrainedStagingTracker,
  formatWindowCommitMessage,
  hashInsertedText,
} from "../src/recording/staging-tracker";
import { ClaudeCodeParser } from "../src/recording/agents/claude/parser";
import type { AssistantEvent } from "../src/recording/event";

/** The tracker resolves paths, so on Windows "/tmp/x" becomes "C:\tmp\x". */
function resolved(...files: string[]): string[] {
  return files.map((file) => path.resolve(file));
}

function makeAssistantEvent(
  overrides: Partial<AssistantEvent> = {}
): AssistantEvent {
  return {
    timestamp: "2026-06-25T10:00:05.000Z",
    kind: "edit-applied",
    capability: "file-edit",
    source: {
      assistantId: "github-copilot",
      adapterId: "copilot-log-parser",
      rawSignal: "edit-tool",
    },
    fileOperations: [
      {
        kind: "update",
        path: "/tmp/demo.ts",
      },
    ],
    ...overrides,
  };
}

test("flushes human window when the first assistant event arrives", () => {
  const tracker = new FineGrainedStagingTracker(1000);

  tracker.recordHumanChange(["/tmp/human.ts"], 1_000);
  tracker.recordHumanChange(["/tmp/human-2.ts"], 1_500);

  const commits = tracker.recordAssistantEvent(
    makeAssistantEvent({
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/assistant.ts",
        },
      ],
    }),
    2_000
  );

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    kind: "human",
    files: resolved("/tmp/human-2.ts", "/tmp/human.ts").sort(),
    startedAt: 1_000,
    endedAt: 1_500,
  });
});

test("keeps same-file changes inside the assistant debounce window", () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(
    makeAssistantEvent({
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/assistant.ts",
        },
      ],
    }),
    10_000
  );
  tracker.recordHumanChange(["/tmp/assistant.ts"], 10_200);

  assert.equal(tracker.flushAssistantWindowIfIdle(10_900), null);

  const commit = tracker.flushAssistantWindowIfIdle(11_201);
  assert.ok(commit);
  assert.equal(commit.kind, "assistant");
  assert.deepEqual(commit.files, resolved("/tmp/assistant.ts"));
  assert.equal(commit.startedAt, 10_000);
  assert.equal(commit.endedAt, 10_200);
});

test("records high-confidence materialization when observed text matches assistant evidence", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const inserted = "const value = 1;\n";

  tracker.recordAssistantEvent(
    makeAssistantEvent({
      origin: "assistant-agent-chat",
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/assistant.ts",
        },
      ],
      evidence: [
        {
          type: "copilot-chat-text-edit-group",
          confidence: "high",
          requestId: "req-1",
          sessionId: "chat-1",
          details: {
            editTextHashes: [hashInsertedText(inserted)],
            ranges: [
              {
                startLine: 0,
                startColumn: 0,
                endLine: 0,
                endColumn: 0,
              },
            ],
          },
        },
      ],
    }),
    10_000
  );

  tracker.recordTextDocumentChange(
    [
      {
        path: "/tmp/assistant.ts",
        insertedTextHashes: [hashInsertedText(inserted)],
        insertedTextLength: inserted.length,
        ranges: [
          {
            startLine: 0,
            startColumn: 0,
            endLine: 0,
            endColumn: 0,
          },
        ],
      },
    ],
    10_200
  );

  const commit = tracker.flushAssistantWindowIfIdle(11_201);
  assert.ok(commit);
  assert.equal(commit.kind, "assistant");
  assert.deepEqual(commit.fileAttributions, [
    {
      path: path.resolve("/tmp/assistant.ts"),
      origin: "assistant-agent-chat",
      confidence: "high",
      matched: true,
      evidenceTypes: ["copilot-chat-text-edit-group"],
      requestIds: ["req-1"],
      sessionIds: ["chat-1"],
      matchedTextHashCount: 1,
      proposedTextHashCount: 1,
      rangeOverlap: true,
    },
  ]);
});

test("keeps unrelated file changes human-owned during assistant windows", () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(
    makeAssistantEvent({
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/assistant.ts",
        },
      ],
    }),
    10_000
  );
  tracker.recordHumanChange(["/tmp/human-during-assistant.ts"], 10_200);

  const assistantCommit = tracker.flushAssistantWindowIfIdle(11_001);
  assert.ok(assistantCommit);
  assert.equal(assistantCommit.kind, "assistant");
  assert.deepEqual(assistantCommit.files, resolved("/tmp/assistant.ts"));

  const pendingCommits = tracker.flushAll(12_000);
  assert.equal(pendingCommits.length, 1);
  assert.equal(pendingCommits[0].kind, "human");
  assert.deepEqual(pendingCommits[0].files, resolved("/tmp/human-during-assistant.ts"));
});

test("assistant boundary drops overlapping files from the flushed human window", () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordHumanChange(["/tmp/shared.ts", "/tmp/human-only.ts"], 1_000);

  const commits = tracker.recordAssistantEvent(
    makeAssistantEvent({
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/shared.ts",
        },
        {
          kind: "create",
          path: "/tmp/assistant-only.ts",
        },
      ],
    }),
    2_000
  );

  assert.equal(commits.length, 1);
  assert.equal(commits[0].kind, "human");
  assert.deepEqual(commits[0].files, resolved("/tmp/human-only.ts"));

  const assistantCommit = tracker.flushAll(4_000)[0];
  assert.equal(assistantCommit.kind, "assistant");
  assert.deepEqual(
    assistantCommit.files,
    resolved("/tmp/assistant-only.ts", "/tmp/shared.ts")
  );
});

test("assistant boundary matches files whose Windows drive letters differ in case", { skip: process.platform !== "win32" }, () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  // VS Code reports `e:\...`, Claude Code reports `E:\...`.
  tracker.recordHumanChange(["e:\\repo\\test.txt"], 1_000);

  const commits = tracker.recordAssistantEvent(
    makeAssistantEvent({
      fileOperations: [{ kind: "create", path: "E:\\repo\\test.txt" }],
    }),
    2_000
  );

  assert.equal(commits.length, 0);
  const assistantCommit = tracker.flushAll(4_000)[0];
  assert.equal(assistantCommit.kind, "assistant");
  assert.deepEqual(assistantCommit.files, ["E:\\repo\\test.txt"]);
});

test("assistant boundary keeps earlier human text of a shared file", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const shared = path.resolve("/tmp/shared.ts");
  const change = (text: string) => ({
    path: shared,
    insertedTextHashes: [],
    insertedTextLength: 1,
    ranges: [],
    text,
  });

  tracker.recordTextDocumentChange([change("h1")], 1_000);
  tracker.recordTextDocumentChange([change("h2")], 5_000);
  // The assistant's edit reaches the editor just before its event is parsed.
  tracker.recordTextDocumentChange([change("h2+ai")], 9_700);

  const commits = tracker.recordAssistantEvent(
    makeAssistantEvent({ fileOperations: [{ kind: "update", path: shared }] }),
    10_000
  );

  assert.equal(commits.length, 1);
  assert.equal(commits[0].kind, "human");
  assert.deepEqual(commits[0].files, [shared]);
  assert.deepEqual(
    commits[0].kind === "human" ? commits[0].snapshots : undefined,
    { [shared]: "h2" }
  );
});

test("assistant tool events with file paths keep later workspace edits out of the human commit", () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordHumanChange(["/tmp/shared.ts"], 1_000);

  const commits = tracker.recordAssistantEvent(
    makeAssistantEvent({
      kind: "tool-called",
      capability: "tool-call",
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/shared.ts",
        },
      ],
    }),
    1_100
  );

  assert.equal(commits.length, 0);

  tracker.recordHumanChange(["/tmp/shared.ts"], 1_200);
  const assistantCommit = tracker.flushAll(3_000)[0];
  assert.equal(assistantCommit.kind, "assistant");
  assert.deepEqual(assistantCommit.files, resolved("/tmp/shared.ts"));
});

test("deferred assistant boundaries do not flush before the file change lands", () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(
    makeAssistantEvent({
      kind: "tool-called",
      capability: "tool-call",
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/existing.ts",
        },
      ],
    }),
    1_000
  );

  assert.equal(tracker.flushAssistantWindowIfIdle(5_000), null);

  tracker.recordHumanChange(["/tmp/existing.ts"], 5_100);
  const commit = tracker.flushAssistantWindowIfIdle(6_200);
  assert.ok(commit);
  assert.equal(commit.kind, "assistant");
  assert.deepEqual(commit.files, resolved("/tmp/existing.ts"));
});

test("flushAll emits active assistant and concurrent human windows during shutdown", () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  const preAssistantCommits = tracker.recordAssistantEvent(
    makeAssistantEvent(),
    2_000
  );
  assert.equal(preAssistantCommits.length, 0);
  tracker.recordHumanChange(["/tmp/assistant-follow-up.ts"], 2_100);

  const commits = tracker.flushAll(5_000);

  assert.equal(commits.length, 2);
  assert.equal(commits[0].kind, "assistant");
  assert.deepEqual(commits[0].files, resolved("/tmp/demo.ts"));
  assert.equal(commits[1].kind, "human");
  assert.deepEqual(commits[1].files, resolved("/tmp/assistant-follow-up.ts"));
});

test("assistant commit messages include compact window metadata", () => {
  const tracker = new FineGrainedStagingTracker(0);
  tracker.recordAssistantEvent(
    makeAssistantEvent({
      origin: "assistant-tool-edit",
      requestId: "req-123",
      cursorPosition: {
        line: 5,
        column: 2,
      },
    }),
    Date.parse("2026-06-25T10:00:00.000Z")
  );

  const commit = tracker.flushAssistantWindowIfIdle(
    Date.parse("2026-06-25T10:00:00.000Z")
  );
  assert.ok(commit);

  const message = formatWindowCommitMessage(commit);
  const lines = message.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "Flight Recorder: assistant tool edit (1 file)");
  assert.match(message, /"eventCount":1/);
  assert.match(message, /"origins":\["assistant-tool-edit"\]/);
  assert.match(message, /"fileAttributions":/);
  assert.doesNotMatch(message, /"requestId":"req-123"/);
  assert.doesNotMatch(message, /"cursorPosition"/);
});

test("assistant commit messages summarize explicit origins", () => {
  const tracker = new FineGrainedStagingTracker(0);

  tracker.recordAssistantEvent(
    makeAssistantEvent({
      origin: "assistant-inline-completion",
    }),
    Date.parse("2026-06-25T10:00:00.000Z")
  );

  tracker.recordAssistantEvent(
    makeAssistantEvent({
      origin: "assistant-agent-chat",
      fileOperations: [
        {
          kind: "update",
          path: "/tmp/agent.ts",
        },
      ],
    }),
    Date.parse("2026-06-25T10:00:01.000Z")
  );

  const commit = tracker.flushAssistantWindowIfIdle(
    Date.parse("2026-06-25T10:00:01.000Z")
  );
  assert.ok(commit);

  const message = formatWindowCommitMessage(commit);
  assert.match(message, /^Flight Recorder: assistant mixed \(2 files\)/);
  assert.match(
    message,
    /"origins":\["assistant-agent-chat","assistant-inline-completion","mixed"\]/
  );
});

test("human commit messages include file count and one metadata payload", () => {
  const tracker = new FineGrainedStagingTracker(0);

  tracker.recordHumanChange(["/tmp/human.ts", "/tmp/other.ts"], 1_000);

  const commit = tracker.flushAll(1_500)[0];
  assert.ok(commit);
  assert.equal(commit.kind, "human");

  const message = formatWindowCommitMessage(commit);
  const lines = message.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "Flight Recorder: human edits (2 files)");
  assert.match(lines[1], /"kind":"human"/);
});

/** Builds a text change for `file` whose document text afterwards is `text`. */
function textChange(file: string, text: string) {
  return {
    path: file,
    insertedTextHashes: [hashInsertedText(text)],
    insertedTextLength: text.length,
    ranges: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }],
    text,
  };
}

test("a long session alternates human and assistant windows with correct files and snapshots", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const [a, b, c] = resolved("/tmp/a.ts", "/tmp/b.ts", "/tmp/c.ts");
  const editOf = (...files: string[]) =>
    makeAssistantEvent({ fileOperations: files.map((file) => ({ kind: "update" as const, path: file })) });

  // Human edits a; the assistant then edits a and b.
  tracker.recordTextDocumentChange([textChange(a, "human 1")], 1_000);
  const first = tracker.recordAssistantEvent(editOf(a, b), 3_000);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "human");
  assert.deepEqual(first[0].files, [a]);
  assert.deepEqual(first[0].kind === "human" && first[0].snapshots, { [a]: "human 1" });

  // Assistant text lands in a; meanwhile the human edits c.
  tracker.recordTextDocumentChange([textChange(a, "human 1 + assistant")], 3_100);
  tracker.recordTextDocumentChange([textChange(c, "human c")], 3_500);
  assert.equal(tracker.flushAssistantWindowIfIdle(3_900), null);
  const assistant = tracker.flushAssistantWindowIfIdle(4_200);
  assert.equal(assistant?.kind, "assistant");
  assert.ok(assistant?.files.includes(a));
  assert.equal(assistant?.files.includes(c), false);

  // Human edits a again; the next assistant event flushes a and c as human.
  tracker.recordTextDocumentChange([textChange(a, "human 2")], 5_000);
  const second = tracker.recordAssistantEvent(editOf(a), 7_000);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].files, [a, c].sort());
  assert.deepEqual(second[0].kind === "human" && second[0].snapshots, { [a]: "human 2" });

  // Shutdown closes the open assistant window.
  const rest = tracker.flushAll(8_000);
  assert.deepEqual(rest.map((commit) => commit.kind), ["assistant"]);
  assert.deepEqual(tracker.flushAll(9_000), []);
});

test("a delete or rename after a human text edit drops the stale snapshot", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const [d, e] = resolved("/tmp/d.ts", "/tmp/e.ts");

  tracker.recordTextDocumentChange([textChange(d, "draft")], 1_000);
  tracker.recordTextDocumentChange([textChange(e, "other")], 1_000);
  tracker.recordHumanChange([d], 1_500);
  const [human] = tracker.recordAssistantEvent(
    makeAssistantEvent({
      fileOperations: [{ kind: "update", path: d }, { kind: "update", path: e }],
    }),
    3_000
  );

  assert.equal(human.kind, "human");
  const snapshots = human.kind === "human" ? human.snapshots ?? {} : {};
  assert.equal(d in snapshots, false);
  assert.equal(snapshots[e], "other");
});

test("human text younger than the assistant event lag is not used as a snapshot", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const [f] = resolved("/tmp/f.ts");

  tracker.recordTextDocumentChange([textChange(f, "settled human text")], 1_000);
  tracker.recordTextDocumentChange([textChange(f, "probably the assistant")], 2_600);
  const [human] = tracker.recordAssistantEvent(
    makeAssistantEvent({ fileOperations: [{ kind: "update", path: f }] }),
    3_000
  );

  assert.deepEqual(human.kind === "human" && human.snapshots, { [f]: "settled human text" });
});

/** Parses Claude hook payloads for `/tmp/...` files into assistant events. */
function claudeHooks(...payloads: Array<Record<string, unknown>>): AssistantEvent[] {
  const parser = new ClaudeCodeParser();
  return Array.from(
    parser.feed(payloads.map((payload) => `${JSON.stringify({ session_id: "s", cwd: "/tmp", ...payload })}\n`).join(""))
  );
}

test("a file the assistant only read stays human-owned when the human edits it later", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const [file] = resolved("/tmp/readme.md");
  let at = 10_000;
  for (const event of claudeHooks(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } },
    { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: file } }
  )) {
    assert.deepEqual(tracker.recordAssistantEvent(event, at += 100), []);
  }

  tracker.recordHumanChange([file], at + 6_000);

  assert.equal(tracker.flushAssistantWindowIfIdle(at + 9_000), null);
  assert.deepEqual(
    tracker.flushAll(at + 10_000).map((commit) => [commit.kind, commit.files]),
    [["human", [file]]]
  );
});

test("reads inside an edit window keep it alive without making its attribution mixed", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const [file] = resolved("/tmp/index.js");
  const input = { file_path: file, old_string: "a", new_string: "b" };
  let at = 10_000;
  for (const event of claudeHooks(
    { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: input },
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } },
    { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: input, tool_response: { filePath: file } }
  )) {
    tracker.recordAssistantEvent(event, at += 400);
  }

  const commit = tracker.flushAssistantWindowIfIdle(at + 1_100);

  assert.equal(commit?.kind, "assistant");
  assert.deepEqual(commit?.kind === "assistant" && commit.fileAttributions.map((a) => a.origin), ["assistant-tool-edit"]);
  assert.deepEqual(commit?.kind === "assistant" && commit.origins, ["assistant-tool-edit"]);
});

test("a running shell command keeps its window open and claims every change it makes", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const [a, b] = resolved("/tmp/a.ts", "/tmp/b.ts");
  const [pre, post] = claudeHooks(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm run gen" } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm run gen" } }
  );

  tracker.recordAssistantEvent(pre, 10_000);
  tracker.recordDiskChange([a], 10_500);
  assert.equal(tracker.flushAssistantWindowIfIdle(20_000), null, "still running after the debounce");
  tracker.recordDiskChange([b], 25_000);
  tracker.recordAssistantEvent(post, 26_000);
  assert.equal(tracker.flushAssistantWindowIfIdle(26_500), null);

  const commit = tracker.flushAssistantWindowIfIdle(27_100);
  assert.equal(commit?.kind, "assistant");
  assert.deepEqual(commit?.files, [a, b]);
  assert.deepEqual(tracker.flushAll(28_000), []);
});

test("a command without a finish signal ends at the next prompt, or after the safety timeout", () => {
  const [pre] = claudeHooks(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "sleep 100" } }
  );
  const [prompt] = claudeHooks({ hook_event_name: "UserPromptSubmit", prompt: "next" });

  const interrupted = new FineGrainedStagingTracker(1_000);
  interrupted.recordAssistantEvent(pre, 10_000);
  interrupted.recordDiskChange(resolved("/tmp/x.ts"), 10_100);
  interrupted.recordAssistantEvent(prompt, 30_000);
  assert.equal(interrupted.flushAssistantWindowIfIdle(31_100)?.kind, "assistant");

  const silent = new FineGrainedStagingTracker(1_000);
  silent.recordAssistantEvent(pre, 10_000);
  silent.recordDiskChange(resolved("/tmp/x.ts"), 10_100);
  assert.equal(silent.flushAssistantWindowIfIdle(10_100 + 4 * 60_000), null);
  assert.equal(silent.flushAssistantWindowIfIdle(10_100 + 5 * 60_000)?.kind, "assistant");
});

test("disk changes reported for ordinary saves keep the human snapshot", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const [file] = resolved("/tmp/saved.ts");

  tracker.recordTextDocumentChange([textChange(file, "human text")], 1_000);
  tracker.recordDiskChange([file], 1_200);
  const [human] = tracker.recordAssistantEvent(
    makeAssistantEvent({ fileOperations: [{ kind: "update", path: file }] }),
    3_000
  );

  assert.deepEqual(human.kind === "human" && human.snapshots, { [file]: "human text" });
});

/** A shell tool run starting, as Claude's PreToolUse Bash or OpenCode's `pre` shell record. */
function shellStarted(): AssistantEvent {
  return makeAssistantEvent({
    kind: "tool-called",
    capability: "command",
    fileOperations: [],
    toolCall: { id: "shell-1", phase: "started" },
  });
}

test("a shell run claims on-disk changes the watcher reported just before its log line", () => {
  const tracker = new FineGrainedStagingTracker(1000);
  tracker.recordTextDocumentChange(
    [{ path: "/tmp/typed.md", insertedTextHashes: [], insertedTextLength: 5, ranges: [], text: "typed" }],
    500
  );
  // The command wrote notes.txt; the watcher saw it 150 ms before the log line was read.
  tracker.recordDiskChange(["/tmp/notes.txt"], 1_000);

  const [human] = tracker.recordAssistantEvent(shellStarted(), 1_150);
  const commits = tracker.flushAll(10_000);

  assert.deepEqual(human.files, resolved("/tmp/typed.md"));
  assert.deepEqual(commits.map((commit) => [commit.kind, commit.files]), [["assistant", resolved("/tmp/notes.txt")]]);
});

test("a shell run leaves older on-disk changes and editor-typed files with the human", () => {
  const tracker = new FineGrainedStagingTracker(1000);
  tracker.recordDiskChange(["/tmp/generated-earlier.txt"], 1_000);
  tracker.recordTextDocumentChange(
    [{ path: "/tmp/typed.md", insertedTextHashes: [], insertedTextLength: 5, ranges: [], text: "typed" }],
    5_900
  );
  tracker.recordDiskChange(["/tmp/typed.md"], 5_950); // the save

  const [human] = tracker.recordAssistantEvent(shellStarted(), 6_000);

  assert.deepEqual(human.files, resolved("/tmp/generated-earlier.txt", "/tmp/typed.md"));
});

test("an edit event naming one file does not claim unrelated on-disk changes", () => {
  const tracker = new FineGrainedStagingTracker(1000);
  tracker.recordDiskChange(["/tmp/other.txt"], 1_000);

  const [human] = tracker.recordAssistantEvent(makeAssistantEvent({ fileOperations: [{ kind: "update", path: "/tmp/demo.ts" }] }), 1_100);

  assert.deepEqual(human.files, resolved("/tmp/other.txt"));
});

test("an edit Claude announced but never made (rejected) does not claim later human edits", () => {
  const parser = new ClaudeCodeParser();
  const parse = (payload: Record<string, unknown>) => Array.from(parser.feed(`${JSON.stringify(payload)}\n`));
  const toolInput = { file_path: "/tmp/rejected.ts", old_string: "a", new_string: "b" };
  const tracker = new FineGrainedStagingTracker(1000);
  const commits = [];

  for (const event of parse({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: toolInput })) {
    commits.push(...tracker.recordAssistantEvent(event, 1_000));
  }
  // The participant rejects the edit: no PostToolUse, no file change, the turn ends.
  for (const event of parse({ hook_event_name: "Stop" })) {
    commits.push(...tracker.recordAssistantEvent(event, 1_500));
  }
  const idle = tracker.flushAssistantWindowIfIdle(3_000);
  tracker.recordTextDocumentChange(
    [{ path: "/tmp/rejected.ts", insertedTextHashes: [], insertedTextLength: 1, ranges: [], text: "manual" }],
    10_000
  );
  commits.push(...tracker.flushAll(20_000));

  assert.equal(idle, null, "the unmaterialized window is dropped without a commit");
  assert.deepEqual(commits.map((commit) => [commit.kind, commit.files]), [["human", resolved("/tmp/rejected.ts")]]);
});

test("without a turn end, an announced edit stops waiting after the safety limit", () => {
  const tracker = new FineGrainedStagingTracker(1000);
  tracker.recordAssistantEvent(makeAssistantEvent({ kind: "tool-called", capability: "tool-call", fileOperations: [{ kind: "update", path: "/tmp/never.ts" }] }), 1_000);

  // Still waiting a minute later, then dropped after the five-minute limit.
  assert.equal(tracker.flushAssistantWindowIfIdle(60_000), null);
  assert.equal(tracker.flushAssistantWindowIfIdle(6 * 60_000), null);
  tracker.recordTextDocumentChange(
    [{ path: "/tmp/never.ts", insertedTextHashes: [], insertedTextLength: 1, ranges: [], text: "y" }],
    6 * 60_000 + 100
  );

  assert.deepEqual(tracker.flushAll(7 * 60_000).map((commit) => [commit.kind, commit.files]), [["human", resolved("/tmp/never.ts")]]);
});
