import assert from "node:assert/strict";
import test from "node:test";
import {
  FineGrainedStagingTracker,
  formatWindowCommitMessage,
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

test("keeps collecting changes inside the assistant debounce window", () => {
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
  tracker.recordHumanChange(["/tmp/follow-up.ts"], 10_200);

  assert.equal(tracker.flushAssistantWindowIfIdle(10_900), null);

  const commit = tracker.flushAssistantWindowIfIdle(11_201);
  assert.ok(commit);
  assert.equal(commit.kind, "assistant");
  assert.deepEqual(commit.files, ["/tmp/assistant.ts", "/tmp/follow-up.ts"]);
  assert.equal(commit.startedAt, 10_000);
  assert.equal(commit.endedAt, 10_200);
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

test("flushAll emits the active assistant window during shutdown", () => {
  const tracker = new FineGrainedStagingTracker(1_000);

  const preAssistantCommits = tracker.recordAssistantEvent(
    makeAssistantEvent(),
    2_000
  );
  assert.equal(preAssistantCommits.length, 0);
  tracker.recordHumanChange(["/tmp/assistant-follow-up.ts"], 2_100);

  const commits = tracker.flushAll(5_000);

  assert.equal(commits.length, 1);
  assert.equal(commits[0].kind, "assistant");
  assert.deepEqual(commits[0].files, [
    "/tmp/assistant-follow-up.ts",
    "/tmp/demo.ts",
  ]);
});

test("assistant commit messages include window metadata and per-event payloads", () => {
  const tracker = new FineGrainedStagingTracker(0);
  tracker.recordAssistantEvent(
    makeAssistantEvent({
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
  assert.match(message, /Flight Recorder: assistant edits/);
  assert.match(message, /"eventCount":1/);
  assert.match(message, /"requestId":"req-123"/);
});
