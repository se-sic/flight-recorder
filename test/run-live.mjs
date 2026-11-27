// Runs the live e2e tests (test/e2e/live.test.ts) with FR_LIVE=1. A script
// instead of `FR_LIVE=1 vscode-test` in package.json, which Windows shells
// do not understand.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "node_modules", "@vscode", "test-cli", "out", "bin.mjs");
const result = spawnSync(process.execPath, [cli, "--grep", "Live assistants", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, FR_LIVE: "1" },
});
process.exit(result.status ?? 1);
