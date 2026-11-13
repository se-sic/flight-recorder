import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Every filesystem path that enters Flight Recorder (VS Code URIs, assistant
// logs, git output, settings) goes through `normalizePath` once, so that
// paths can be compared as plain strings everywhere else. See AGENTS.md.
//
// The canonical form is absolute, with native separators, no trailing
// separator, and an upper-case Windows drive letter. VS Code reports `e:\`
// while most other tools report `E:\`. The rest of the path keeps its case,
// so file names in commits stay exact.

/** Resolves path segments (like `path.resolve`) into the canonical form described above. */
export function normalizePath(...segments: string[]): string {
  return path
    .resolve(...segments)
    .replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/**
 * Converts a VS Code URI to a normalized path. This is the only place that
 * reads `uri.fsPath` (lint rejects it elsewhere). Typed structurally so that
 * modules without a runtime `vscode` import can use it too.
 */
export function uriToPath(uri: { readonly fsPath: string }): string {
  return normalizePath(uri.fsPath);
}

/** Converts a `file://` URI string to a normalized path, or returns null if it is not a valid file URI. */
export function pathFromFileUri(uri: string): string | null {
  try {
    return normalizePath(fileURLToPath(uri));
  } catch {
    return null;
  }
}

/**
 * Returns whether two paths name the same file or directory. Paths are
 * compared case-insensitively on Windows, where user-typed paths (e.g. a
 * terminal's `cwd`) can differ in case from the real ones.
 */
export function samePath(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Returns `filePath` relative to `root` with `/` separators (`""` for the
 * root itself), or null if it lies outside `root`.
 */
export function relativePathInside(root: string, filePath: string): string | null {
  const rel = path.relative(normalizePath(root), normalizePath(filePath));
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/**
 * Resolves symlinks in a directory path (e.g. macOS `/var` → `/private/var`),
 * so a root reported by git and one reported by Node compare equal. Use it
 * for roots such as the repository or a worktree, not for files: a symlinked
 * file in the repository must stay the link itself.
 */
export function realDirectoryPath(dir: string): string {
  try {
    return normalizePath(fs.realpathSync.native(dir));
  } catch {
    return normalizePath(dir);
  }
}
