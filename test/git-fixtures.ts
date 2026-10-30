import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Runs git synchronously in `cwd` and returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Creates a throwaway directory that is removed when the process exits. */
export function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Creates a git repository on `main` with a local identity and one initial commit. */
export function makeRepo(): string {
  const dir = makeTempDir("fr-test-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Commits an empty change on the currently checked-out branch of `cwd`. */
export function commitEmpty(cwd: string, message: string): string {
  git(cwd, "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Lists local branch names, sorted. */
export function listBranches(repo: string): string[] {
  return git(repo, "branch", "--format=%(refname:short)")
    .split("\n")
    .filter(Boolean)
    .sort();
}
