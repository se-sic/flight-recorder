import assert from "node:assert/strict";
import test from "node:test";
import { eventOriginFromSummary } from "../src/visualization/coloring";

function assistantCommitBody(origins: string[]): string {
  return [
    "Flight Recorder: assistant edits",
    JSON.stringify({
      kind: "assistant",
      files: ["a.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      eventCount: origins.length,
      origins,
      fileAttributions: [],
    }),
  ].join("\n");
}

test("eventOriginFromSummary returns unknown when no origins field is present", () => {
  assert.equal(eventOriginFromSummary("Flight Recorder: human edits\n{}"), "unknown");
});

test("eventOriginFromSummary maps a single inline-completion origin", () => {
  assert.equal(
    eventOriginFromSummary(assistantCommitBody(["assistant-inline-completion"])),
    "inline-completion"
  );
});

test("eventOriginFromSummary maps assistant-agent-chat to agent-edit", () => {
  assert.equal(
    eventOriginFromSummary(assistantCommitBody(["assistant-agent-chat"])),
    "agent-edit"
  );
});

test("eventOriginFromSummary maps assistant-tool-edit to agent-edit", () => {
  assert.equal(
    eventOriginFromSummary(assistantCommitBody(["assistant-tool-edit"])),
    "agent-edit"
  );
});

test("eventOriginFromSummary returns mixed for a mixed origin entry", () => {
  assert.equal(
    eventOriginFromSummary(assistantCommitBody(["mixed"])),
    "mixed"
  );
});

test("eventOriginFromSummary collapses same-kind origins to a single kind", () => {
  assert.equal(
    eventOriginFromSummary(
      assistantCommitBody(["assistant-agent-chat", "assistant-tool-edit"])
    ),
    "agent-edit"
  );
});

test("eventOriginFromSummary returns mixed for distinct kinds", () => {
  assert.equal(
    eventOriginFromSummary(
      assistantCommitBody(["assistant-agent-chat", "assistant-inline-completion", "mixed"])
    ),
    "mixed"
  );
});

test("eventOriginFromSummary maps assistant-unknown to unknown", () => {
  assert.equal(
    eventOriginFromSummary(assistantCommitBody(["assistant-unknown"])),
    "unknown"
  );
});