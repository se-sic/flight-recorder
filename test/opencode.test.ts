import assert from "node:assert/strict";
import test from "node:test";
import {
  hunkAddedText,
  hunkOldSideRange,
  parseUnifiedDiffHunks,
} from "../src/recording/agents/opencode/diff";
import { OpenCodeParser } from "../src/recording/agents/opencode/parser";
import {
  buildOpenCodePluginSource,
  OPENCODE_PLUGIN_SCHEMA_VERSION,
  readOpenCodePluginSchemaVersion,
} from "../src/recording/agents/opencode/plugin-source";
import {
  FineGrainedStagingTracker,
  hashInsertedText,
} from "../src/recording/staging-tracker";
import type { AssistantEvent } from "../src/recording/event";

const REPO = "/Users/test/demo";
const SESSION = "ses_demo";

// Payload shapes below are trimmed from a real OpenCode 2.2.2 session.
const TEST_JS_PATCH =
  "Index: test.js\n" +
  "===================================================================\n" +
  "--- test.js\n" +
  "+++ test.js\n" +
  "@@ -1,4 +1,5 @@\n" +
  "+// pLimit: A concurrency limiting utility for JavaScript promises\n" +
  " import process from 'node:process';\n" +
  " import {AsyncLocalStorage} from 'node:async_hooks';\n" +
  " import {setTimeout as delay} from 'node:timers/promises';\n" +
  " import test from 'ava';\n";

/** Serializes plugin records into JSONL. */
function jsonl(...records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify({ fr: 1, ...record })).join("\n") + "\n";
}

/** Builds the setup record the plugin writes when OpenCode loads it. */
function setupRecord(): Record<string, unknown> {
  return {
    ts: 1_000,
    kind: "setup",
    app: { name: "cli", version: "2.2.2", channel: "latest" },
    directory: REPO,
  };
}

/** Builds a pre/post record pair for one tool call. */
function toolCall(
  tool: string,
  callID: string,
  messageID: string,
  input: Record<string, unknown>,
  post: Record<string, unknown>
): Record<string, unknown>[] {
  const shared = { tool, sessionID: SESSION, messageID, callID, agent: "build", input };
  return [
    { ts: 2_000, kind: "pre", ...shared },
    { ts: 2_005, kind: "post", ...shared, status: "completed", ...post },
  ];
}

/** Feeds JSONL into a fresh parser and collects every event. */
function parseAll(text: string): AssistantEvent[] {
  return Array.from(new OpenCodeParser().feed(text));
}

test("parseUnifiedDiffHunks reads hunk headers and added/removed lines", () => {
  const hunks = parseUnifiedDiffHunks(
    "--- a.js\n+++ a.js\n" +
      "@@ -1,2 +1,2 @@\n-old\n+new\n same\n" +
      "@@ -10 +10,2 @@\n line\n+added\n" +
      "\\ No newline at end of file\n"
  );

  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    addedLines: ["new"],
    removedLines: ["old"],
  });
  assert.equal(hunks[1].oldLines, 1);
  assert.deepEqual(hunks[1].addedLines, ["added"]);
});

test("parseUnifiedDiffHunks does not mistake a following file header for hunk lines", () => {
  const hunks = parseUnifiedDiffHunks(
    "@@ -1 +1 @@\n-a\n+b\n--- next.js\n+++ next.js\n@@ -0,0 +1 @@\n+c\n"
  );

  assert.deepEqual(hunks.map((hunk) => hunk.addedLines), [["b"], ["c"]]);
  assert.deepEqual(hunks.map((hunk) => hunk.removedLines), [["a"], []]);
});

test("hunkOldSideRange uses zero-based pre-change coordinates", () => {
  const [replace] = parseUnifiedDiffHunks("@@ -3,2 +3,4 @@\n-x\n-y\n+a\n+b\n+c\n+d\n");
  assert.deepEqual(hunkOldSideRange(replace), {
    startLine: 2,
    startColumn: 0,
    endLine: 4,
    endColumn: 0,
  });

  const [insert] = parseUnifiedDiffHunks("@@ -5,0 +6,1 @@\n+new\n");
  assert.deepEqual(hunkOldSideRange(insert), {
    startLine: 5,
    startColumn: 0,
    endLine: 5,
    endColumn: 0,
  });
  assert.equal(hunkAddedText(insert), "new\n");
});

test("OpenCodeParser turns a file tool's pre record into a deferred boundary", () => {
  const events = parseAll(
    jsonl(setupRecord(), {
      ts: 2_000,
      kind: "pre",
      tool: "edit",
      sessionID: SESSION,
      messageID: "msg_1",
      callID: "call_1",
      input: { path: `${REPO}/test.js`, oldString: "a", newString: "b" },
    })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool-called");
  assert.equal(events[0].capability, "tool-call");
  assert.equal(events[0].source.assistantId, "opencode");
  assert.equal(events[0].source.rawSignal, "pre:edit");
  assert.equal(events[0].sessionId, SESSION);
  assert.equal(events[0].requestId, "msg_1");
  assert.equal(events[0].timestamp, new Date(2_000).toISOString());
  assert.deepEqual(events[0].fileOperations, [{ kind: "update", path: `${REPO}/test.js` }]);
});

test("OpenCodeParser builds high-confidence evidence from a completed edit", () => {
  const newString =
    "// pLimit: A concurrency limiting utility for JavaScript promises\nimport process from 'node:process';";
  const files = [
    { file: "test.js", patch: TEST_JS_PATCH, status: "modified", additions: 1, deletions: 0 },
  ];
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall(
        "edit",
        "call_1",
        "msg_1",
        { path: `${REPO}/test.js`, oldString: "import process from 'node:process';", newString },
        { output: { files, replacements: 1 }, metadata: { files } }
      )
    )
  );

  const edit = events[1];
  assert.equal(edit.kind, "edit-applied");
  assert.equal(edit.capability, "file-edit");
  assert.equal(edit.origin, "assistant-tool-edit");
  assert.deepEqual(edit.fileOperations, [{ kind: "update", path: `${REPO}/test.js` }]);
  assert.equal(edit.metadata?.opencodeVersion, "2.2.2");
  assert.equal(edit.metadata?.callId, "call_1");

  const evidence = edit.evidence?.[0];
  assert.equal(evidence?.type, "opencode-tool-result");
  assert.equal(evidence?.confidence, "high");
  const hashes = evidence?.details?.editTextHashes as string[];
  assert.ok(hashes.includes(hashInsertedText(newString)));
  assert.ok(
    hashes.includes(
      hashInsertedText("// pLimit: A concurrency limiting utility for JavaScript promises\n")
    )
  );
  assert.deepEqual(evidence?.details?.ranges, [
    { startLine: 0, startColumn: 0, endLine: 4, endColumn: 0 },
  ]);
});

test("OpenCodeParser maps write results to create or update operations", () => {
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall(
        "write",
        "call_1",
        "msg_1",
        { path: `${REPO}/notes.md`, content: "# Notes\n" },
        {
          output: {
            operation: "write",
            target: `${REPO}/notes.md`,
            resource: "notes.md",
            existed: false,
          },
        }
      ),
      ...toolCall(
        "write",
        "call_2",
        "msg_2",
        { path: `${REPO}/readme.md`, content: "# Readme\n" },
        { output: { operation: "write", target: `${REPO}/readme.md`, existed: true } }
      )
    )
  );

  assert.deepEqual(events[0].fileOperations, [{ kind: "unknown", path: `${REPO}/notes.md` }]);
  assert.deepEqual(events[1].fileOperations, [{ kind: "create", path: `${REPO}/notes.md` }]);
  assert.deepEqual(events[1].evidence?.[0].details?.editTextHashes, [
    hashInsertedText("# Notes\n"),
  ]);
  assert.deepEqual(events[3].fileOperations, [{ kind: "update", path: `${REPO}/readme.md` }]);
});

test("OpenCodeParser maps patch tool headers and applied results", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+export {};",
    "*** Update File: src/old.ts",
    "*** Move to: src/moved.ts",
    "*** Delete File: src/gone.ts",
    "*** End Patch",
  ].join("\n");
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall("patch", "call_1", "msg_1", { patchText }, {
        output: {
          applied: [
            { type: "add", resource: "src/new.ts", target: `${REPO}/src/new.ts` },
            { type: "update", resource: "src/moved.ts", target: `${REPO}/src/moved.ts` },
            { type: "delete", resource: "src/gone.ts", target: `${REPO}/src/gone.ts` },
          ],
        },
      })
    )
  );

  assert.deepEqual(events[0].fileOperations, [
    { kind: "create", path: `${REPO}/src/new.ts` },
    { kind: "update", path: `${REPO}/src/old.ts` },
    { kind: "create", path: `${REPO}/src/moved.ts` },
    { kind: "delete", path: `${REPO}/src/gone.ts` },
  ]);
  assert.deepEqual(events[1].fileOperations, [
    { kind: "create", path: `${REPO}/src/new.ts` },
    { kind: "update", path: `${REPO}/src/moved.ts` },
    { kind: "delete", path: `${REPO}/src/gone.ts` },
  ]);
  assert.equal(events[1].evidence?.length, 2);
});

test("OpenCodeParser emits failed file tools without file operations", () => {
  const events = parseAll(
    jsonl(setupRecord(), {
      ts: 2_005,
      kind: "post",
      tool: "edit",
      sessionID: SESSION,
      messageID: "msg_1",
      callID: "call_1",
      input: { path: `${REPO}/test.js` },
      status: "error",
      error: "oldString not found",
    })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool-called");
  assert.deepEqual(events[0].fileOperations, []);
  assert.equal(events[0].metadata?.error, "oldString not found");
});

test("OpenCodeParser keeps read-only tools free of file operations", () => {
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall("read", "call_1", "msg_1", { path: `${REPO}/index.js` }, {})
    )
  );

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.kind, "tool-called");
    assert.deepEqual(event.fileOperations, []);
  }
});

test("OpenCodeParser attributes shell edits from step snapshots", () => {
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall("shell", "call_1", "msg_shell", { command: "echo x >> demo.js" }, {}),
      {
        ts: 3_000,
        kind: "step",
        sessionID: SESSION,
        messageID: "msg_shell",
        files: ["demo.js"],
        snapshot: "abc123",
      }
    )
  );

  assert.equal(events.length, 3);
  assert.equal(events[0].capability, "command");
  const step = events[2];
  assert.equal(step.kind, "edit-applied");
  assert.equal(step.source.rawSignal, "step:snapshot");
  assert.deepEqual(step.fileOperations, [{ kind: "unknown", path: `${REPO}/demo.js` }]);
  assert.equal(step.evidence?.[0].type, "opencode-step-snapshot");
  assert.equal(step.evidence?.[0].confidence, "medium");
});

test("OpenCodeParser ignores step snapshots already covered by file tools or without commands", () => {
  const files = [{ file: "test.js", patch: TEST_JS_PATCH, status: "modified" }];
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall("edit", "call_1", "msg_edit", { path: `${REPO}/test.js` }, { metadata: { files } }),
      { ts: 3_000, kind: "step", sessionID: SESSION, messageID: "msg_edit", files: ["test.js"] },
      ...toolCall("shell", "call_2", "msg_mixed", { command: "npm test" }, {}),
      ...toolCall("edit", "call_3", "msg_mixed", { path: `${REPO}/test.js` }, { metadata: { files } }),
      { ts: 4_000, kind: "step", sessionID: SESSION, messageID: "msg_mixed", files: ["test.js"] }
    )
  );

  assert.equal(
    events.filter((event) => event.source.rawSignal === "step:snapshot").length,
    0
  );
});

test("OpenCodeParser buffers partial lines and dedupes repeated tool calls", () => {
  const parser = new OpenCodeParser();
  const text = jsonl(
    setupRecord(),
    ...toolCall("read", "call_1", "msg_1", { path: `${REPO}/a.js` }, {}),
    ...toolCall("read", "call_1", "msg_1", { path: `${REPO}/a.js` }, {})
  );
  const middle = Math.floor(text.length / 2);

  const events = [
    ...Array.from(parser.feed(text.slice(0, middle))),
    ...Array.from(parser.feed(text.slice(middle))),
  ];

  assert.equal(events.length, 2);
});

test("OpenCodeParser skips malformed lines and unknown record kinds", () => {
  const events = parseAll(
    "not json\n" + jsonl({ kind: "something-new" }, { ts: 1 }) + "\n"
  );

  assert.equal(events.length, 0);
});

test("staging tracker attributes a matching OpenCode edit with high confidence", () => {
  const files = [{ file: "test.js", patch: TEST_JS_PATCH, status: "modified" }];
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall("edit", "call_1", "msg_1", { path: `${REPO}/test.js` }, { metadata: { files } })
    )
  );
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(events[0], 2_000);
  tracker.recordTextDocumentChange(
    [
      {
        path: `${REPO}/test.js`,
        insertedTextHashes: [
          hashInsertedText("// pLimit: A concurrency limiting utility for JavaScript promises\n"),
        ],
        insertedTextLength: 66,
        ranges: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }],
      },
    ],
    2_003
  );
  tracker.recordAssistantEvent(events[1], 2_005);

  const commit = tracker.flushAssistantWindowIfIdle(5_000);
  assert.ok(commit);
  assert.equal(commit.kind, "assistant");
  assert.deepEqual(commit.files, [`${REPO}/test.js`]);
  assert.equal(commit.fileAttributions[0].confidence, "high");
});

test("buildOpenCodePluginSource embeds the schema version and repo root", () => {
  const source = buildOpenCodePluginSource('/Users/test/my "repo"');

  assert.equal(readOpenCodePluginSchemaVersion(source), OPENCODE_PLUGIN_SCHEMA_VERSION);
  assert.ok(source.includes('const REPO_ROOT = "/Users/test/my \\"repo\\""'));
  assert.ok(source.includes('ctx.tool.hook("execute.before"'));
  assert.ok(source.includes('ctx.tool.hook("execute.after"'));
  assert.equal(readOpenCodePluginSchemaVersion("export default {}"), null);
});
