import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  computeEventPalettes,
  eventOriginFromSummary,
} from "../src/visualization/coloring";
import { gitCmd } from "../src/utils/git";
import type { buildCommitAgeEntriesFromRanges } from "../src/visualization/ownership";
import { findQualitativePalette } from "../src/visualization/palettes";

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

test("computeEventPalettes classifies legacy Flight Recorder commits from full commit body", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fr-coloring-"));
  await gitCmd(["init"], repoRoot);
  await gitCmd(["config", "user.name", "Test User"], repoRoot);
  await gitCmd(["config", "user.email", "test@example.com"], repoRoot);

  fs.writeFileSync(path.join(repoRoot, "app.ts"), "const value = 1;\n", "utf8");
  await gitCmd(["add", "app.ts"], repoRoot);
  const message = [
    "Flight Recorder: assistant edits",
    "{\"kind\":\"assistant\",\"eventCount\":1}",
    "{\"origin\":\"assistant-inline-completion\"}",
  ].join("\n");
  await gitCmd(["commit", "-m", message], repoRoot);
  const head = await gitCmd(["rev-parse", "HEAD"], repoRoot);
  const commitHash = head.out.trim();

  const commitAgeEntries: ReturnType<typeof buildCommitAgeEntriesFromRanges> = [
    {
      commitHash,
      author: "Test User",
      authorTime: null,
      summary: "Flight Recorder: assistant edits",
      isUncommitted: false,
      lineCount: 1,
      rank: 0,
      total: 1,
    },
  ];

  const result = await computeEventPalettes(
    repoRoot,
    commitAgeEntries,
    false,
    findQualitativePalette("vibrant")
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.kindByCommit?.get(commitHash) : null, "inline-completion");
});
