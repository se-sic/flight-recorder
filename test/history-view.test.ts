import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingBranchUiState } from "../src/recording/session";
import type { RecordingHistory, RecordingHistoryEntry } from "../src/history-panel/history";
import { buildHtml } from "../src/history-panel/view";

const CSP = "vscode-webview://test";

function state(overrides: Partial<RecordingBranchUiState> = {}): RecordingBranchUiState {
  return {
    repoRoot: "/repo",
    isRecording: false,
    commitMode: "trackingWorktree",
    sourceBranchName: "main",
    finalBranchName: "flight-recorder/main",
    displayBranchName: "flight-recorder/main",
    finalized: true,
    ...overrides,
  };
}

function entry(overrides: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry {
  return {
    hash: "a".repeat(40),
    shortHash: "aaaaaaa",
    authorDate: "2026-11-04T10:00:00+01:00",
    author: "Test User",
    subject: "Flight Recorder: human edits (1 file)",
    kind: "human",
    files: ["readme.md"],
    origins: [],
    ...overrides,
  };
}

function history(entries: RecordingHistoryEntry[], overrides: Partial<RecordingHistory> = {}): RecordingHistory {
  return {
    branchName: "flight-recorder/main",
    entries,
    upstream: null,
    ahead: null,
    behind: null,
    ...overrides,
  };
}

/** Returns the opening tag of the element with the given id. */
function tagWithId(html: string, id: string): string {
  const match = html.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`));
  assert.ok(match, `element #${id} should exist`);
  return match[0];
}

test("panel without any recording asks to start one", () => {
  const html = buildHtml(null, null, null, 0, CSP, false);
  assert.match(html, /Start a recording to see Flight Recorder history/);
  assert.match(tagWithId(html, "push"), /disabled/);
  assert.doesNotMatch(html, /id="recover"/);
});

test("push is disabled while recording and enabled once finalized", () => {
  const recording = buildHtml(
    state({ isRecording: true, finalized: false, displayBranchName: "flight-recorder-active/main/x" }),
    history([entry()]),
    null,
    0,
    CSP,
    false
  );
  assert.match(tagWithId(recording, "push"), /disabled/);
  assert.match(recording, /Push available after recording stops/);
  assert.match(recording, /flight-recorder-active\/main\/x/);

  const finalized = buildHtml(state(), history([entry()]), null, 0, CSP, false);
  assert.doesNotMatch(tagWithId(finalized, "push"), /disabled/);
  assert.match(finalized, /Ready to push/);
  assert.match(finalized, /no upstream \(ahead\/behind unknown\)/);

  const pushing = buildHtml(state(), history([entry()]), null, 0, CSP, true);
  assert.match(tagWithId(pushing, "push"), /disabled/);
});

test("remote status shows ahead and behind counts", () => {
  const html = buildHtml(
    state(),
    history([entry()], { upstream: "origin/flight-recorder/main", ahead: 2, behind: 1 }),
    null,
    0,
    CSP,
    false
  );
  assert.match(html, /origin\/flight-recorder\/main \(2 ahead, 1 behind\)/);
});

test("unfinished recordings show a Recover button that is disabled while recording", () => {
  const idle = buildHtml(null, null, null, 2, CSP, false);
  assert.match(idle, /2 earlier recording\(s\) were not finalized/);
  assert.doesNotMatch(tagWithId(idle, "recover"), /disabled/);
  assert.doesNotMatch(idle, /Start a recording/);

  const recording = buildHtml(state({ isRecording: true, finalized: false }), history([]), null, 1, CSP, false);
  assert.match(tagWithId(recording, "recover"), /disabled/);
});

test("entries show kind, origins and files, with long file lists truncated", () => {
  const html = buildHtml(
    state(),
    history([
      entry({
        kind: "assistant",
        subject: "Flight Recorder: assistant tool edit (6 files)",
        origins: ["assistant-tool-edit"],
        files: ["a", "b", "c", "d", "e", "f"],
      }),
      entry({ kind: "log", subject: "recording stopped: x", files: [] }),
    ]),
    null,
    0,
    CSP,
    false
  );
  assert.match(html, /Assistant: assistant-tool-edit/);
  assert.match(html, /6 files/);
  assert.match(html, /\+2 more/);
  assert.match(html, /Log snapshot/);
  assert.match(html, /No file metadata/);
});

test("commit data and messages are HTML-escaped", () => {
  const html = buildHtml(
    state({ displayBranchName: "flight-recorder/<b>" }),
    history([entry({ subject: "<script>alert(1)</script>", author: "\"Eve\" & co", files: ["<img src=x>"] })]),
    "Pushed <now>",
    0,
    CSP,
    false
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;Eve&quot; &amp; co/);
  assert.match(html, /flight-recorder\/&lt;b&gt;/);
  assert.match(html, /Pushed &lt;now&gt;/);
});

test("the webview only runs its own nonce-tagged script", () => {
  const html = buildHtml(state(), history([entry()]), null, 0, CSP, false);
  const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  assert.match(html, /default-src 'none'/);
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  assert.deepEqual(scripts, [`<script nonce="${nonce}">`]);
  assert.notEqual(buildHtml(state(), history([]), null, 0, CSP, false).match(/nonce-([^']+)/)?.[1], nonce);
});
