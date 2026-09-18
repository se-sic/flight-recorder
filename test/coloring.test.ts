import assert from "node:assert/strict";
import test from "node:test";
import { eventOriginFromSummary } from "../src/visualization/coloring";

test("eventOriginFromSummary classifies simplified Flight Recorder subjects", () => {
  assert.equal(
    eventOriginFromSummary("Flight Recorder: assistant inline completion (1 file)"),
    "inline-completion"
  );
  assert.equal(
    eventOriginFromSummary("Flight Recorder: assistant agent chat (2 files)"),
    "agent-edit"
  );
  assert.equal(
    eventOriginFromSummary("Flight Recorder: assistant tool edit (1 file)"),
    "agent-edit"
  );
  assert.equal(
    eventOriginFromSummary("Flight Recorder: assistant mixed (3 files)"),
    "mixed"
  );
});

test("eventOriginFromSummary reads compact and legacy JSON origin metadata", () => {
  assert.equal(
    eventOriginFromSummary(
      "{\"origins\":[\"assistant-agent-chat\",\"assistant-inline-completion\",\"mixed\"]}"
    ),
    "mixed"
  );
  assert.equal(
    eventOriginFromSummary(
      "{\"origin\":\"assistant-inline-completion\"}\n{\"origin\":\"assistant-inline-completion\"}"
    ),
    "inline-completion"
  );
});
