import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatchToAttributedLines,
  mergeLineAttribution,
  type AttributedLine,
} from "../src/visualization/blame";

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
