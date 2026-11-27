import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  applyPatchToAttributedLines,
  buildFileOwnershipRanges,
  mergeLineAttribution,
  type AttributedLine,
} from "../src/visualization/blame";
import { git, makeRepo } from "./git-fixtures";

function lineText(line: AttributedLine): string {
  return line.spans.map((span) => `${span.commitHash}:${span.text}`).join("|");
}

test("mergeLineAttribution preserves unchanged tokens and attributes inserts to the new commit", () => {
  const previousLine: AttributedLine = {
    spans: [{ text: "const total = value;", commitHash: "aaaa" }],
  };

  const merged = mergeLineAttribution(
    previousLine,
    "const total = newValue;",
    "bbbb"
  );

  assert.deepEqual(merged.spans, [
    { text: "const total = ", commitHash: "aaaa" },
    { text: "newValue", commitHash: "bbbb" },
    { text: ";", commitHash: "aaaa" },
  ]);
});

test("applyPatchToAttributedLines preserves older spans inside modified lines", () => {
  const previousLines: AttributedLine[] = [
    { spans: [{ text: "const total = value;", commitHash: "aaaa" }] },
  ];
  const nextLines = ["const total = newValue;"];
  const diff = [
    "@@ -1 +1 @@",
    "-const total = value;",
    "+const total = newValue;",
    "",
  ].join("\n");

  const updated = applyPatchToAttributedLines(
    previousLines,
    nextLines,
    diff,
    "bbbb"
  );

  assert.equal(updated.length, 1);
  assert.equal(
    lineText(updated[0]),
    "aaaa:const total = |bbbb:newValue|aaaa:;"
  );
});

test("applyPatchToAttributedLines attributes inserted lines to the new commit", () => {
  const previousLines: AttributedLine[] = [
    { spans: [{ text: "const a = 1;", commitHash: "aaaa" }] },
  ];
  const nextLines = ["const a = 1;", "const b = 2;"];
  const diff = [
    "@@ -1,0 +2 @@",
    "+const b = 2;",
    "",
  ].join("\n");

  const updated = applyPatchToAttributedLines(
    previousLines,
    nextLines,
    diff,
    "bbbb"
  );

  assert.equal(updated.length, 2);
  assert.equal(lineText(updated[0]), "aaaa:const a = 1;");
  assert.equal(lineText(updated[1]), "bbbb:const b = 2;");
});

test("buildFileOwnershipRanges attributes lines to a recording branch that HEAD does not contain", async () => {
  // The recording branch has the assistant's commit; the checked-out branch
  // only has the same text as an uncommitted change.
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "human\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "human line");
  git(repo, "checkout", "-q", "-b", "flight-recorder/main");
  fs.writeFileSync(path.join(repo, "a.txt"), "human\nassistant\n");
  git(repo, "commit", "-q", "-am", "Flight Recorder: assistant tool edit (1 file)");
  const recordingCommit = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "human\nassistant\n");

  const ownerOfLine = async (revision?: string) => {
    const result = await buildFileOwnershipRanges(repo, "a.txt", "human\nassistant\n", revision);
    assert.ok(result.ok);
    return result.ranges.find((range) => range.lineNumber === 2)?.commitHash;
  };

  assert.equal(await ownerOfLine("flight-recorder/main"), recordingCommit);
  assert.notEqual(await ownerOfLine(), recordingCommit);
});
