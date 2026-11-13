import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  normalizePath,
  pathFromFileUri,
  realDirectoryPath,
  relativePathInside,
  samePath,
  uriToPath,
} from "../src/utils/fs-path";

const isWindows = process.platform === "win32";
const ROOT = normalizePath("/work/repo");

test("normalizePath resolves segments and drops trailing separators", () => {
  assert.equal(normalizePath("/work/repo/"), ROOT);
  assert.equal(normalizePath("/work", "repo", "src", "..", "a.ts"), path.join(ROOT, "a.ts"));
  assert.ok(path.isAbsolute(normalizePath("relative.ts")));
});

test("normalizePath upper-cases the Windows drive letter only", { skip: !isWindows }, () => {
  assert.equal(normalizePath("e:\\Work\\Repo"), "E:\\Work\\Repo");
  assert.equal(normalizePath("e:/Work/Repo"), "E:\\Work\\Repo");
  assert.equal(uriToPath({ fsPath: "e:\\Work\\a.ts" }), "E:\\Work\\a.ts");
});

test("pathFromFileUri accepts every spelling of the same file", () => {
  const file = path.join(ROOT, "my dir", "a.ts");
  assert.equal(pathFromFileUri(pathToFileURL(file).href), file);
  assert.equal(pathFromFileUri("https://example.com/a.ts"), null);
  assert.equal(pathFromFileUri("not a uri"), null);
});

test("pathFromFileUri handles the URI forms VS Code writes on Windows", { skip: !isWindows }, () => {
  for (const uri of ["file:///e%3A/Work/a.ts", "file:///e:/Work/a.ts", "file:///E:/Work/a.ts"]) {
    assert.equal(pathFromFileUri(uri), "E:\\Work\\a.ts", uri);
  }
});

test("samePath follows the platform's case sensitivity", () => {
  assert.equal(samePath("/work/repo", "/work/repo/"), true);
  assert.equal(samePath("/work/repo", "/work/other"), false);
  assert.equal(samePath("/work/Repo", "/work/repo"), isWindows);
});

test("relativePathInside returns POSIX-style paths inside the root only", () => {
  assert.equal(relativePathInside(ROOT, path.join(ROOT, "src", "a.ts")), "src/a.ts");
  assert.equal(relativePathInside(ROOT, path.join(ROOT, "..foo")), "..foo");
  assert.equal(relativePathInside(ROOT, ROOT), "");
  assert.equal(relativePathInside(ROOT, normalizePath("/work/repo2/a.ts")), null);
  assert.equal(relativePathInside(ROOT, normalizePath("/elsewhere/a.ts")), null);
});

test("relativePathInside ignores drive-letter case", { skip: !isWindows }, () => {
  assert.equal(relativePathInside("e:\\work\\repo", "E:\\work\\repo\\a.ts"), "a.ts");
});

test("realDirectoryPath resolves symlinks and tolerates missing directories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-test-fs-path-"));
  assert.equal(realDirectoryPath(dir), normalizePath(fs.realpathSync.native(dir)));
  const missing = path.join(dir, "missing");
  assert.equal(realDirectoryPath(missing), normalizePath(missing));
});
