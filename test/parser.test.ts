import assert from "node:assert/strict";
import test from "node:test";
import * as path from "path";
import { CopilotLogParser } from "../src/recording/parser";

const SAMPLE_LINE =
  "2026-04-28 10:12:56.872 [debug] [edit-tool:efcf0ac7-59d2-4c9b-b0d4-4d84a23ce134] " +
  "[{\"input\":\"*** Begin Patch\\n*** Update File: /tmp/demo/foo.py\\n@@\\n-\\\"hello\\\"\\n import csv\\n import numpy as np\\n import os\\n*** End Patch\",\"success\":true}]";

const SAMPLE_MESSAGE_VARIANT =
  "2026-04-28 10:12:56.872 [debug] [github.copilot-chat] " +
  "[edit-tool:efcf0ac7-59d2-4c9b-b0d4-4d84a23ce134] " +
  "[{\"input\":\"*** Begin Patch\\n*** Update File: /tmp/demo/foo.py\\n@@\\n-\\\"hello\\\"\\n import csv\\n import numpy as np\\n import os\\n*** End Patch\",\"success\":true}]";

const SAMPLE_GET_COMPLETIONS =
  "2026-04-28 10:48:28.385 [debug] [getCompletions] " +
  "Requesting for file:///tmp/demo/foo.py " +
  "at 13:0 between \"from src.sampling import sample_random, sample_twise\\r\\n\" and \"\\r\\n\\r\\n\".";

const SAMPLE_GHOSTTEXT_ACCEPTED =
  "2026-04-28 10:48:28.900 [debug] [postInsertion] " +
  "ghostText.accepted choiceIndex: 0 Inserted at 123";

test("CopilotLogParser parses edit-tool patch events", () => {
  const parser = new CopilotLogParser();
  const events = Array.from(parser.feed(`${SAMPLE_LINE}\n`));

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.kind, "edit-applied");
  assert.equal(ev.capability, "file-edit");
  assert.equal(ev.requestId, "efcf0ac7-59d2-4c9b-b0d4-4d84a23ce134");
  assert.equal(ev.source.assistantId, "github-copilot");
  assert.equal(ev.source.rawSignal, "edit-tool");

  const expectedPath = path.resolve("/tmp/demo/foo.py");
  assert.deepEqual(ev.fileOperations, [
    {
      kind: "update",
      path: expectedPath,
    },
  ]);
});

test("CopilotLogParser parses edit-tool when marker is in message", () => {
  const parser = new CopilotLogParser();
  const events = Array.from(parser.feed(`${SAMPLE_MESSAGE_VARIANT}\n`));

  assert.equal(events.length, 1);
  const ev = events[0];

  assert.equal(ev.kind, "edit-applied");
  assert.equal(ev.capability, "file-edit");
  assert.equal(ev.requestId, "efcf0ac7-59d2-4c9b-b0d4-4d84a23ce134");

  const expectedPath = path.resolve("/tmp/demo/foo.py");
  assert.deepEqual(ev.fileOperations, [
    {
      kind: "update",
      path: expectedPath,
    },
  ]);
});

test("CopilotLogParser parses inline completion acceptance", () => {
  const parser = new CopilotLogParser();
  const events = Array.from(
    parser.feed(`${SAMPLE_GET_COMPLETIONS}\n${SAMPLE_GHOSTTEXT_ACCEPTED}\n`)
  );

  assert.equal(events.length, 1);
  const ev = events[0];

  assert.equal(ev.kind, "suggestion-accepted");
  assert.equal(ev.capability, "inline-completion");
  assert.deepEqual(ev.cursorPosition, {
    line: 14,
    column: 1,
  });

  const normalizedExpected = path.normalize("/tmp/demo/foo.py");
  assert.deepEqual(
    ev.fileOperations.map((operation) => ({
      kind: operation.kind,
      path: path.normalize(operation.path ?? ""),
    })),
    [
      {
        kind: "update",
        path: normalizedExpected,
      },
    ]
  );
});
