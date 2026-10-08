import assert from "node:assert/strict";
import test from "node:test";
import {
  FineGrainedStagingTracker,
  formatWindowCommitMessage,
  hashInsertedText,
} from "../src/recording/staging-tracker";
import type { AssistantEvent } from "../src/recording/event";

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
    files: ["/tmp/human-2.ts", "/tmp/human.ts"].sort(),
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
  assert.deepEqual(commit.files, ["/tmp/assistant.ts"]);
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
      path: "/tmp/assistant.ts",
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
  assert.deepEqual(assistantCommit.files, ["/tmp/assistant.ts"]);

  const pendingCommits = tracker.flushAll(12_000);
  assert.equal(pendingCommits.length, 1);
  assert.equal(pendingCommits[0].kind, "human");
  assert.deepEqual(pendingCommits[0].files, ["/tmp/human-during-assistant.ts"]);
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
  assert.deepEqual(commits[0].files, ["/tmp/human-only.ts"]);

  const assistantCommit = tracker.flushAll(4_000)[0];
  assert.equal(assistantCommit.kind, "assistant");
  assert.deepEqual(assistantCommit.files, [
    "/tmp/assistant-only.ts",
    "/tmp/shared.ts",
  ]);
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
  assert.deepEqual(assistantCommit.files, ["/tmp/shared.ts"]);
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
  assert.deepEqual(commit.files, ["/tmp/existing.ts"]);
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
  assert.deepEqual(commits[0].files, ["/tmp/demo.ts"]);
  assert.equal(commits[1].kind, "human");
  assert.deepEqual(commits[1].files, ["/tmp/assistant-follow-up.ts"]);
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
