import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommitAgeEntries,
  groupCommitOwnershipSegments,
  parseGitBlamePorcelain,
  shortCommitHash,
} from "../src/visualization/ownership";

const SAMPLE_BLAME = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1",
  "author Alice",
  "author-time 1713175200",
  "summary Initial import",
  "\tconst alpha = 1;",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2 1",
  "author Alice",
  "author-time 1713175200",
  "summary Initial import",
  "\tconst beta = 2;",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1",
  "author Bob",
  "author-time 1713261600",
  "summary Copilot refactor",
  "\tconst gamma = alpha + beta;",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 4 4 1",
  "author Alice",
  "author-time 1713175200",
  "summary Initial import",
  "\treturn gamma;",
  "",
].join("\n");

test("parseGitBlamePorcelain extracts per-line commit ownership", () => {
  const ownership = parseGitBlamePorcelain(SAMPLE_BLAME);

  assert.equal(ownership.length, 4);
  assert.equal(ownership[0].commitHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(ownership[0].finalLineNumber, 1);
  assert.equal(ownership[0].author, "Alice");
  assert.equal(ownership[0].summary, "Initial import");
  assert.equal(ownership[2].commitHash, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(ownership[2].finalLineNumber, 3);
  assert.equal(ownership[2].author, "Bob");
  assert.equal(ownership[2].summary, "Copilot refactor");
});

test("groupCommitOwnershipSegments merges only contiguous lines from the same commit", () => {
  const ownership = parseGitBlamePorcelain(SAMPLE_BLAME);
  const segments = groupCommitOwnershipSegments(ownership);

  assert.deepEqual(
    segments.map((segment) => ({
      commitHash: segment.commitHash,
      startLineNumber: segment.startLineNumber,
      endLineNumber: segment.endLineNumber,
    })),
    [
      {
        commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        startLineNumber: 1,
        endLineNumber: 2,
      },
      {
        commitHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        startLineNumber: 3,
        endLineNumber: 3,
      },
      {
        commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        startLineNumber: 4,
        endLineNumber: 4,
      },
    ]
  );
});

test("shortCommitHash special-cases uncommitted working tree lines", () => {
  assert.equal(
    shortCommitHash("0000000000000000000000000000000000000000"),
    "working-tree"
  );
  assert.equal(
    shortCommitHash("1234567890abcdef1234567890abcdef12345678"),
    "12345678"
  );
});

test("buildCommitAgeEntries orders commits from oldest to newest and counts lines", () => {
  const ownership = parseGitBlamePorcelain(SAMPLE_BLAME);
  const segments = groupCommitOwnershipSegments(ownership);
  const entries = buildCommitAgeEntries(segments);

  assert.deepEqual(
    entries.map((entry) => ({
      commitHash: entry.commitHash,
      lineCount: entry.lineCount,
      rank: entry.rank,
      total: entry.total,
    })),
    [
      {
        commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        lineCount: 3,
        rank: 0,
        total: 2,
      },
      {
        commitHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        lineCount: 1,
        rank: 1,
        total: 2,
      },
    ]
  );
});
