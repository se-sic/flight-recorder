import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  CopilotCliEventParser,
  CopilotCliSessionWatcher,
  findCopilotCliSessionsForRepo,
  parseCopilotCliWorkspace,
} from "../src/recording/agents/copilot/cli-sessions";
import type { AssistantEvent } from "../src/recording/event";

function toolStart(id: string, toolName: string, args: unknown): string {
  return JSON.stringify({
    type: "tool.execution_start",
    data: { toolCallId: id, toolName, arguments: args, turnId: "1", model: "m" },
    timestamp: "2026-10-11T15:40:01.000Z",
  }) + "\n";
}

function toolComplete(id: string, success = true): string {
  return JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: id, success },
    timestamp: "2026-10-11T15:40:02.000Z",
  }) + "\n";
}

function writeSession(stateDir: string, id: string, yaml: string): string {
  const dir = path.join(stateDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.yaml"), yaml, "utf8");
  fs.writeFileSync(path.join(dir, "events.jsonl"), "{}\n", "utf8");
  return dir;
}

test("parseCopilotCliWorkspace reads dirs, creation time and name", () => {
  const workspace = parseCopilotCliWorkspace(
    "id: abc\r\ncwd: c:\\repo\\sub\r\ngit_root: 'C:\\repo'\r\nbranch: master\r\n" +
      "name: |-\r\n  Implement a database\r\n\r\n  More details\r\n" +
      "created_at: 2026-10-11T15:39:44.281Z\r\n"
  );
  assert.deepEqual(workspace, {
    dirs: ["c:\\repo\\sub", "C:\\repo"],
    name: "Implement a database",
    createdAt: new Date("2026-10-11T15:39:44.281Z"),
  });
});

test("findCopilotCliSessionsForRepo matches sessions by cwd or git_root", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cli-sessions-"));
  const repo = path.join(stateDir, "repo");
  const other = path.join(stateDir, "other");

  const byCwd = writeSession(stateDir, "s1", `id: s1\ncwd: ${repo}\n`);
  const byGitRoot = writeSession(
    stateDir,
    "s2",
    `id: s2\ncwd: ${path.join(repo, "src")}\ngit_root: ${repo}${path.sep}\n`
  );
  writeSession(stateDir, "s3", `id: s3\ncwd: ${other}\ngit_root: ${other}\n`);
  fs.mkdirSync(path.join(stateDir, "no-yaml"));

  const found = await findCopilotCliSessionsForRepo(repo, stateDir);
  assert.deepEqual(found.map((s) => s.dir).sort(), [byCwd, byGitRoot].sort());
});

test("CopilotCliEventParser emits events for successful edit tools only", () => {
  const parser = new CopilotCliEventParser("session-1");
  // The CLI reports upper-case drive letters; VS Code uses lower-case ones.
  const vscodePath = (p: string) => p.replace(/^[A-Z]:/, (d) => d.toLowerCase());
  const file = vscodePath(path.resolve("repo", "src", "main.py"));
  const cliFile = file.replace(/^[a-z]:/, (d) => d.toUpperCase());
  const patch = `*** Begin Patch\n*** Update File: ${cliFile}\n@@\n-a\n+b\n*** End Patch\n`;

  const input =
    toolStart("c1", "view", { path: file }) +
    toolComplete("c1") +
    toolStart("c2", "apply_patch", patch) +
    toolStart("c3", "create", { path: "new.py", file_text: "x" }) +
    toolStart("c4", "edit", { path: file, old_str: "a", new_str: "b" }) +
    toolComplete("c3") +
    toolComplete("c4", false);

  // Split mid-line to exercise partial-line buffering.
  const cut = input.length - 20;
  const events = [
    ...parser.feed(input.slice(0, cut)),
    ...parser.feed(input.slice(cut) + toolComplete("c2")),
  ];

  assert.equal(events.length, 2);
  assert.equal(events[0].toolName, "create");
  assert.deepEqual(events[0].fileOperations, [
    { kind: "create", path: vscodePath(path.resolve("new.py")) },
  ]);
  assert.equal(events[1].toolName, "apply_patch");
  assert.deepEqual(events[1].fileOperations, [{ kind: "update", path: file }]);
  assert.equal(events[1].origin, "assistant-tool-edit");
  assert.equal(events[1].sessionId, "session-1");
  assert.equal(events[1].evidence?.[0]?.type, "copilot-cli-edit-tool");
});

test("CopilotCliSessionWatcher tails only new events for the repo", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cli-watch-"));
  const repo = path.join(stateDir, "repo");
  const file = path.join(repo, "a.py");

  const existing = writeSession(stateDir, "old", `cwd: ${repo}\n`);
  fs.writeFileSync(
    path.join(existing, "events.jsonl"),
    toolStart("old1", "create", { path: file }) + toolComplete("old1"),
    "utf8"
  );

  const watcher = new CopilotCliSessionWatcher(repo, stateDir, 60_000);
  const events: AssistantEvent[] = [];
  const disposable = await watcher.start((ev) => events.push(ev));
  try {
    await watcher.poll((ev) => events.push(ev));
    assert.equal(events.length, 0, "pre-existing history must not replay");

    fs.appendFileSync(
      path.join(existing, "events.jsonl"),
      toolStart("e1", "edit", { path: file }) + toolComplete("e1"),
      "utf8"
    );
    const fresh = writeSession(stateDir, "new", `cwd: ${repo}\n`);
    fs.writeFileSync(
      path.join(fresh, "events.jsonl"),
      toolStart("n1", "create", { path: file }) + toolComplete("n1"),
      "utf8"
    );
    writeSession(stateDir, "elsewhere", `cwd: ${path.join(stateDir, "x")}\n`);

    await watcher.poll((ev) => events.push(ev));
    assert.deepEqual(
      events.map((ev) => ev.requestId).sort(),
      ["e1", "n1"]
    );
  } finally {
    disposable.dispose();
  }
});

test("findCopilotCliSessionsForRepo returns empty list for missing state dir", async () => {
  const found = await findCopilotCliSessionsForRepo(
    "/nonexistent/repo",
    path.join(os.tmpdir(), "fr-cli-sessions-missing-dir")
  );
  assert.deepEqual(found, []);
});
