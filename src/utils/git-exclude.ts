import * as fs from "fs";
import * as path from "path";
import { gitCmd } from "./git";
import { normalizePath, relativePathInside } from "./fs-path";

/** Resolves the git repository's top-level directory, throwing if the folder is not a git repository. */
export async function getGitTopLevel(repoRoot: string): Promise<string> {
  const res = await gitCmd(["rev-parse", "--show-toplevel"], repoRoot);
  if (res.code !== 0 || res.out.trim().length === 0) {
    throw new Error("The opened folder is not a git repository.");
  }

  return normalizePath(res.out.trim());
}

/** Appends a line to a file if it is not already present (trimmed comparison), creating the file/directory if needed. */
export function ensureLineInFile(filePath: string, line: string): void {
  const normalizedLine = line.trim();
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8");
    const existingLines = existing.split(/\r?\n/).map((entry) => entry.trim());
    if (existingLines.includes(normalizedLine)) {
      return;
    }
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, existing + prefix + normalizedLine + "\n", "utf8");
}

/** Adds absolute paths that lie inside the repository to its `.git/info/exclude`, skipping paths outside it. */
export async function addGitExcludeEntries(
  repoRoot: string,
  absolutePaths: string[]
): Promise<void> {
  const gitTopLevel = await getGitTopLevel(repoRoot);
  const excludePath = path.join(gitTopLevel, ".git", "info", "exclude");

  for (const absolutePath of absolutePaths) {
    const relative = relativePathInside(gitTopLevel, absolutePath);
    if (!relative) {
      continue;
    }
    ensureLineInFile(excludePath, relative);
  }
}
