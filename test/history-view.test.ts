import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingBranchUiState } from "../src/recording/session";
import type { RecordingHistory, RecordingHistoryEntry } from "../src/history-panel/history";
import { buildHtml } from "../src/history-panel/view";

const CSP = "vscode-webview://test";
const NOW = Date.parse("2026-11-04T10:30:00+01:00");

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
    saved: true,
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

test("panel without any recording explains how to start one", () => {
  const html = buildHtml(null, null, null, 0, CSP, NOW);
  assert.match(html, /No recording for this branch yet/);
  assert.match(html, /Start Flight Recorder/);
  assert.doesNotMatch(html, /id="recover"/);
  assert.doesNotMatch(html, /id="push"/);
});

test("commits of a running recording are listed apart from saved ones", () => {
  const html = buildHtml(
    state({ isRecording: true, finalized: false, assistantDisplayName: "Claude Code", displayBranchName: "flight-recorder-active/main/x" }),
    history([entry({ saved: false, hash: "b".repeat(40) }), entry()]),
    null,
    0,
    CSP,
    NOW
  );
  assert.match(html, /Recording with Claude Code/);
  assert.match(html, /<span>Current recording<\/span><span class="count"[^>]*>1<\/span>/);
  assert.match(html, /<span>Saved<\/span><span class="count"[^>]*>1<\/span>/);
  assert.ok(html.indexOf("Current recording") < html.indexOf("<span>Saved</span>"));
});

test("a saved recording shows only the saved section and how to push it", () => {
  const html = buildHtml(state(), history([entry()]), null, 0, CSP, NOW);
  assert.match(html, /Recording saved/);
  assert.doesNotMatch(html, /Current recording/);
  assert.match(html, /Not pushed yet/);
  assert.match(html, /git push -u origin flight-recorder\/main/);
});

test("the edit history button is shown only when the branch has commits", () => {
  const withCommits = buildHtml(state(), history([entry()]), null, 0, CSP, NOW);
  assert.match(tagWithId(withCommits, "visualize"), /<button/);
  assert.match(withCommits, /postMessage\(\{ type: "visualize" \}\)/);

  const empty = buildHtml(state(), history([]), null, 0, CSP, NOW);
  assert.doesNotMatch(empty, /id="visualize"/);
});

test("remote status shows ahead and behind counts", () => {
  const html = buildHtml(
    state(),
    history([entry()], { upstream: "origin/flight-recorder/main", ahead: 2, behind: 1 }),
    null,
    0,
    CSP,
    NOW
  );
  assert.match(html, /Pushed to <code>origin\/flight-recorder\/main<\/code> · 2 ahead, 1 behind/);
  assert.doesNotMatch(html, /git push/);
});

test("unfinished recordings show a Recover button that is disabled while recording", () => {
  const idle = buildHtml(null, null, null, 2, CSP, NOW);
  assert.match(idle, /2 earlier recording\(s\) were not finalized/);
  assert.doesNotMatch(tagWithId(idle, "recover"), /disabled/);
  assert.doesNotMatch(idle, /No recording for this branch yet/);

  const recording = buildHtml(state({ isRecording: true, finalized: false }), history([]), null, 1, CSP, NOW);
  assert.match(tagWithId(recording, "recover"), /disabled/);
});

test("entries show kind, readable origins, relative time and file names", () => {
  const html = buildHtml(
    state(),
    history([
      entry({
        kind: "assistant",
        subject: "Flight Recorder: assistant tool edit (6 files)",
        origins: ["assistant-tool-edit"],
        files: ["src/a.ts", "b", "c", "d", "e", "f"],
      }),
      entry({ kind: "log", subject: "recording stopped: x", files: [] }),
    ]),
    null,
    0,
    CSP,
    NOW
  );
  assert.match(html, /Assistant · tool edit/);
  assert.match(html, /30 min ago/);
  assert.match(html, /title="src\/a.ts">a.ts</);
  assert.match(html, />\+2</);
  assert.match(html, /Assistant log/);
});

test("commit data and messages are HTML-escaped", () => {
  const html = buildHtml(
    state({ finalBranchName: "flight-recorder/<b>" }),
    history([entry({ kind: "unknown", subject: "<script>alert(1)</script>", author: "\"Eve\" & co", files: ["<img src=x>"] })]),
    "Pushed <now>",
    0,
    CSP,
    NOW
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;Eve&quot; &amp; co/);
  assert.match(html, /flight-recorder\/&lt;b&gt;/);
  assert.match(html, /Pushed &lt;now&gt;/);
});

test("the webview only runs its own nonce-tagged script", () => {
  const html = buildHtml(state(), history([entry()]), null, 0, CSP, NOW);
  const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  assert.match(html, /default-src 'none'/);
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  assert.deepEqual(scripts, [`<script nonce="${nonce}">`]);
  assert.notEqual(buildHtml(state(), history([]), null, 0, CSP, NOW).match(/nonce-([^']+)/)?.[1], nonce);
});

test("edits without a known origin are labeled as coming from another tool", () => {
  const html = buildHtml(
    state(),
    history([entry({ kind: "assistant", subject: "Flight Recorder: assistant edits (1 file)", origins: ["assistant-unknown"], files: ["license"] })]),
    null,
    0,
    CSP
  );
  assert.match(html, /Assistant · other tool/);
  assert.doesNotMatch(html, /unknown/);
});
