import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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

test("OpenCodeParser emits failed file tools as non-boundary events for their files", () => {
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
  assert.equal(events[0].capability, "file-edit");
  assert.equal(events[0].toolCall, undefined);
  assert.deepEqual(events[0].fileOperations, [{ kind: "update", path: `${REPO}/test.js` }]);
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
    assert.equal(event.capability, "read-only");
    assert.equal(event.toolCall, undefined);
    assert.deepEqual(event.fileOperations, []);
  }
});

test("OpenCodeParser marks shell and unknown tools as running between pre and post", () => {
  const events = parseAll(
    jsonl(
      setupRecord(),
      ...toolCall("shell", "call_1", "msg_1", { command: "npm test" }, {}),
      ...toolCall("task", "call_2", "msg_1", { prompt: "explore" }, {}),
      ...toolCall("edit", "call_3", "msg_1", { path: `${REPO}/a.js` }, {})
    )
  );

  assert.deepEqual(events[0].toolCall, { id: "call_1", phase: "started" });
  assert.equal(events[0].capability, "command");
  assert.deepEqual(events[1].toolCall, { id: "call_1", phase: "finished" });
  assert.deepEqual(events[2].toolCall, { id: "call_2", phase: "started" });
  assert.equal(events[2].capability, "tool-call");
  assert.deepEqual(events[3].toolCall, { id: "call_2", phase: "finished" });
  assert.equal(events[4].toolCall, undefined);
  assert.equal(events[4].origin, "assistant-tool-edit");
  assert.equal(events[5].toolCall, undefined);
});

test("OpenCodeParser turns the end of a run into a finish-all marker", () => {
  const events = parseAll(
    jsonl(setupRecord(), { ts: 5_000, kind: "idle", sessionID: SESSION, outcome: "interrupted", reason: "user" })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "response-produced");
  assert.equal(events[0].capability, "read-only");
  assert.deepEqual(events[0].toolCall, { phase: "finished" });
  assert.equal(events[0].source.rawSignal, "idle:interrupted");
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

/** Builds a text change in `file` with a human-typed insertion. */
function typed(file: string, text: string) {
  return {
    path: file,
    insertedTextHashes: [hashInsertedText(text)],
    insertedTextLength: text.length,
    ranges: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }],
  };
}

test("staging tracker does not let OpenCode reads claim human edits", () => {
  const events = parseAll(
    jsonl(setupRecord(), ...toolCall("read", "call_1", "msg_1", { path: `${REPO}/a.js` }, {}))
  );
  const tracker = new FineGrainedStagingTracker(1_000);

  for (const event of events) {
    assert.deepEqual(tracker.recordAssistantEvent(event, 2_000), []);
  }
  tracker.recordTextDocumentChange([typed(`${REPO}/a.js`, "x")], 2_100);

  const commits = tracker.flushAll(5_000);
  assert.deepEqual(commits.map((commit) => commit.kind), ["human"]);
});

test("staging tracker keeps the window open while an OpenCode shell command runs", () => {
  const events = parseAll(
    jsonl(setupRecord(), ...toolCall("shell", "call_1", "msg_1", { command: "./gen.sh" }, {}))
  );
  const [pre, post] = events;
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(pre, 2_000);
  tracker.recordDiskChange([`${REPO}/generated.js`], 2_500);
  // Long past the debounce, but the command has not finished yet.
  assert.equal(tracker.flushAssistantWindowIfIdle(10_000), null);

  tracker.recordAssistantEvent(post, 10_500);
  assert.equal(tracker.flushAssistantWindowIfIdle(11_000), null);
  const commit = tracker.flushAssistantWindowIfIdle(12_000);
  assert.ok(commit);
  assert.equal(commit.kind, "assistant");
  assert.deepEqual(commit.files, [`${REPO}/generated.js`]);
});

test("staging tracker closes a window left open by an interrupted OpenCode command once the run ends", () => {
  const events = parseAll(
    jsonl(
      setupRecord(),
      { ts: 2_000, kind: "pre", tool: "shell", sessionID: SESSION, messageID: "msg_1", callID: "call_1", input: {} },
      { ts: 3_000, kind: "idle", sessionID: SESSION, outcome: "interrupted", reason: "user" }
    )
  );
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(events[0], 2_000);
  tracker.recordDiskChange([`${REPO}/partial.js`], 2_200);
  assert.equal(tracker.flushAssistantWindowIfIdle(10_000), null);

  tracker.recordAssistantEvent(events[1], 10_000);
  const commit = tracker.flushAssistantWindowIfIdle(11_500);
  assert.ok(commit);
  assert.deepEqual(commit.files, [`${REPO}/partial.js`]);
});

test("staging tracker releases a failed OpenCode edit without claiming unrelated human edits", () => {
  const events = parseAll(
    jsonl(
      setupRecord(),
      { ts: 2_000, kind: "pre", tool: "edit", sessionID: SESSION, messageID: "msg_1", callID: "call_1", input: { path: `${REPO}/a.js` } },
      { ts: 2_005, kind: "post", tool: "edit", sessionID: SESSION, messageID: "msg_1", callID: "call_1", input: { path: `${REPO}/a.js` }, status: "error", error: "oldString not found" }
    )
  );
  const tracker = new FineGrainedStagingTracker(1_000);

  tracker.recordAssistantEvent(events[0], 2_000);
  tracker.recordAssistantEvent(events[1], 2_005);
  tracker.recordTextDocumentChange([typed(`${REPO}/b.js`, "human")], 2_100);

  // The window closes after the debounce instead of waiting forever for an
  // edit that never materializes, and claims only the file the tool named.
  const assistantCommit = tracker.flushAssistantWindowIfIdle(4_000);
  assert.ok(assistantCommit);
  assert.deepEqual(assistantCommit.files, [`${REPO}/a.js`]);
  const commits = tracker.flushAll(5_000);
  assert.deepEqual(commits.map((commit) => commit.kind), ["human"]);
  assert.deepEqual(commits[0].files, [`${REPO}/b.js`]);
});

/** A fake OpenCode plugin context that captures hooks and replays bus events. */
function fakePluginContext(directory: string, busEvents: Record<string, unknown>[]) {
  const hooks = new Map<string, (event: Record<string, unknown>) => void>();
  let subscribedTypes: string[] = [];
  const ctx = {
    app: { name: "cli", version: "2.2.2" },
    location: { directory },
    tool: {
      hook: async (name: string, handler: (event: Record<string, unknown>) => void) => {
        hooks.set(name, handler);
      },
    },
    event: {
      subscribe: ({ types }: { types: string[] }) => {
        subscribedTypes = types;
        return (async function* () {
          for (const event of busEvents) {
            yield event;
          }
        })();
      },
    },
  };
  return { ctx, hooks, subscribedTypes: () => subscribedTypes };
}

test("generated OpenCode plugin writes records the parser understands", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fr-opencode-"));
  try {
    const pluginPath = path.join(repo, ".opencode", "plugins", "flight-recorder.mjs");
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, buildOpenCodePluginSource(repo));

    const files = [{ file: "a.js", patch: "@@ -0,0 +1 @@\n+hi\n", status: "added" }];
    const { ctx, hooks, subscribedTypes } = fakePluginContext(repo, [
      { type: "session.step.ended", location: { directory: repo }, data: { sessionID: SESSION, assistantMessageID: "msg_1", files: ["b.js"], snapshot: "s1" } },
      { type: "session.step.ended", location: { directory: "/elsewhere" }, data: { sessionID: "other", assistantMessageID: "msg_x", files: ["x.js"] } },
      { type: "session.execution.succeeded", location: { directory: "/elsewhere" }, data: { sessionID: "other" } },
      { type: "session.step.ended", location: { directory: `${repo}-sibling` }, data: { sessionID: "sibling", assistantMessageID: "msg_s", files: ["s.js"] } },
      { type: "session.execution.succeeded", location: { directory: repo }, data: { sessionID: SESSION } },
    ]);
    const plugin = (await import(pathToFileURL(pluginPath).href)).default;
    const dispose = await plugin.setup(ctx);

    const shell = { tool: "shell", sessionID: SESSION, messageID: "msg_1", id: "call_1", agent: "build", input: { command: "echo hi > b.js" } };
    hooks.get("execute.before")?.(shell);
    hooks.get("execute.after")?.({ ...shell, status: "completed", result: { output: "", metadata: {} } });
    const edit = { tool: "write", sessionID: SESSION, messageID: "msg_1", id: "call_2", agent: "build", input: { path: path.join(repo, "a.js"), content: "hi\n" } };
    hooks.get("execute.before")?.(edit);
    hooks.get("execute.after")?.({ ...edit, status: "completed", result: { output: { target: path.join(repo, "a.js"), existed: false }, metadata: { files } } });
    await new Promise((resolve) => setImmediate(resolve));
    dispose?.();

    assert.ok(subscribedTypes().includes("session.execution.interrupted"));
    const log = fs.readFileSync(path.join(repo, ".opencode", "flight-recorder-events.jsonl"), "utf8");
    const records = log.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(records.every((record) => record.fr === OPENCODE_PLUGIN_SCHEMA_VERSION));
    assert.deepEqual(
      records.map((record) => record.kind).sort(),
      ["idle", "post", "post", "pre", "pre", "setup", "step"]
    );

    const events = Array.from(new OpenCodeParser().feed(log));
    const signals = events.map((event) => event.source.rawSignal);
    assert.ok(signals.includes("pre:shell"));
    assert.ok(signals.includes("post:write"));
    assert.ok(signals.includes("step:snapshot"));
    assert.ok(signals.includes("idle:succeeded"));
    const write = events.find((event) => event.source.rawSignal === "post:write");
    assert.deepEqual(write?.fileOperations, [{ kind: "create", path: path.join(repo, "a.js") }]);
    const step = events.find((event) => event.source.rawSignal === "step:snapshot");
    assert.deepEqual(step?.fileOperations, [{ kind: "unknown", path: path.join(repo, "b.js") }]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("OpenCodeParser resolves relative paths against the repo root when it missed the setup record", () => {
  const files = [{ file: "test.js", patch: TEST_JS_PATCH, status: "modified" }];
  const events = Array.from(
    new OpenCodeParser(REPO).feed(
      jsonl(
        ...toolCall("edit", "call_1", "msg_1", { path: `${REPO}/test.js` }, { metadata: { files } }),
        ...toolCall("shell", "call_2", "msg_2", { command: "touch x" }, {}),
        { ts: 3_000, kind: "step", sessionID: SESSION, messageID: "msg_2", files: ["lib/x.js"] }
      )
    )
  );

  assert.deepEqual(events[1].fileOperations, [{ kind: "update", path: `${REPO}/test.js` }]);
  assert.deepEqual(events[4].fileOperations, [{ kind: "unknown", path: `${REPO}/lib/x.js` }]);
});
