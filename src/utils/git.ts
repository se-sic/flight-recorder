import { spawn } from "child_process";

export type GitCommandResult = {
  code: number;
  out: string;
  err: string;
  spawnError?: Error;
};

/** Runs `git` with the given arguments in `cwd` and collects its exit code, stdout, and stderr. */
export function gitCmd(
  args: string[],
  cwd: string
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd });
    let out = "";
    let err = "";
    let spawnError: Error | undefined;
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (error) => {
      spawnError = error;
    });
    p.on("close", (code) =>
      resolve({ code: code ?? 1, out, err, spawnError })
    );
  });
}
