import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { ClaudeCodeParser } from "../src/recording/agents/claude/parser";
import { AssistantEvent } from "../src/recording/event";
import { FineGrainedStagingTracker, WindowCommit } from "../src/recording/staging-tracker";
import { normalizePath } from "../src/utils/fs-path";

// A real Claude Code hook log, recorded in a manual test (2026-11-27) and
// stripped of personal paths: Read, Edit, a Bash append, Stop, Notification,
// PostToolBatch and SubagentStop, in the order Claude Code wrote them.
const FIXTURE = path.join(__dirname, "..", "..", "..", "test", "fixtures", "claude-hooks-real.jsonl");
const REPO = normalizePath("/fixture/repo");

/** Reads the fixture as one parsed payload per line. */
function payloads(): Array<Record<string, unknown>> {
  return fs.readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Parses each payload separately, keeping the payloads that produced no event. */
function parseEach(): Array<{ payload: Record<string, unknown>; events: AssistantEvent[] }> {
  const parser = new ClaudeCodeParser();
  return payloads().map((payload) => ({ payload, events: Array.from(parser.feed(`${JSON.stringify(payload)}\n`)) }));
}

test("real Claude hooks: only tool and turn events produce assistant events", () => {
  for (const { payload, events } of parseEach()) {
    const name = payload.hook_event_name;
    if (["SessionStart", "Notification", "PostToolBatch", "SubagentStop"].includes(name as string)) {
      assert.equal(events.length, 0, `${name} should be ignored`);
    } else {
      assert.equal(events.length, 1, `${name} ${payload.tool_name ?? ""}`);
    }
  }
});

test("real Claude hooks: Read is read-only, Edit carries evidence, Bash is a paired tool run, Stop ends all runs", () => {
  for (const { payload, events: [event] } of parseEach()) {
    if (!event) {
      continue;
    }
    switch (payload.tool_name ?? payload.hook_event_name) {
      case "Read":
        assert.equal(event.capability, "read-only");
        break;
      case "Edit":
        assert.equal(event.origin, "assistant-tool-edit");
        assert.deepEqual(event.fileOperations.map((op) => op.path), [path.join(REPO, "index.js")]);
        assert.ok((event.evidence?.[0].details?.editTextHashes as string[]).length >= 1);
        break;
      case "Bash":
        assert.equal(event.toolCall?.id, payload.tool_use_id);
        assert.equal(event.toolCall?.phase, payload.hook_event_name === "PreToolUse" ? "started" : "finished");
        break;
      case "Stop":
        assert.deepEqual(event.toolCall, { phase: "finished" });
        assert.equal(event.capability, "read-only");
        break;
      default:
        assert.fail(`unexpected event for ${String(payload.hook_event_name)}`);
    }
  }
});

test("real Claude hooks replayed with file changes give human, tool-edit and shell commits", () => {
  const tracker = new FineGrainedStagingTracker(1_000);
  const commits: WindowCommit[] = [];
  const readme = path.join(REPO, "readme.md");
  const index = path.join(REPO, "index.js");
  const license = path.join(REPO, "license");
  let at = 1_000;
  tracker.recordHumanChange([readme], at);

  for (const { payload, events } of parseEach()) {
    at += 300;
    for (const event of events) {
      commits.push(...tracker.recordAssistantEvent(event, at));
    }
    // The file changes land between each tool's Pre- and PostToolUse hooks.
    if (payload.hook_event_name === "PreToolUse" && payload.tool_name === "Edit") {
      tracker.recordDiskChange([index], at + 100);
    }
    if (payload.hook_event_name === "PreToolUse" && payload.tool_name === "Bash" &&
      String((payload.tool_input as { command?: string }).command).includes("license")) {
      tracker.recordDiskChange([license], at + 100);
    }
    // The fixture has no timestamps; prompts were minutes apart.
    if (payload.hook_event_name === "Stop") {
      at += 60_000;
    }
    const idle = tracker.flushAssistantWindowIfIdle(at);
    if (idle) {
      commits.push(idle);
    }
  }
  commits.push(...tracker.flushAll(at + 10_000));

  const summary = commits.map((commit) => `${commit.kind}:${commit.files.map((file) => path.basename(file)).join(",")}`);
  assert.equal(summary[0], "human:readme.md");
  assert.ok(summary.includes("assistant:index.js"), summary.join(" | "));
  assert.ok(summary.includes("assistant:license"), summary.join(" | "));
  assert.equal(summary.filter((entry) => entry.startsWith("human")).length, 1, summary.join(" | "));
  const edit = commits.find((commit) => commit.kind === "assistant" && commit.files.includes(index));
  assert.ok(edit && edit.kind === "assistant");
  assert.equal(edit.fileAttributions[0].confidence, "medium");
});
