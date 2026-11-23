import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  configureClaudeHooks,
  configureOpenCodePlugin,
  getApi,
  git,
  HOOK_LOG,
  humanEdit,
  repoRoot,
  resetRepo,
  setSetting,
  sleep,
  startRecording,
  stopRecording,
  stubDialogs,
} from "./helpers";

// Live tests drive the real Claude Code and OpenCode CLIs against the e2e
// workspace. They use the logged-in subscriptions (Claude Code login, OpenCode's
// GitHub Copilot login), never an API key, and only run with FR_LIVE=1
// (`npm run test:live`). Models can choose their tools freely, so the checks
// are about which files end up in which kind of commit, not exact subjects.

const LIVE = process.env.FR_LIVE === "1";
const BRANCH = "flight-recorder/main";
const OPENCODE_LOG = ".opencode/flight-recorder-events.jsonl";

/** The environment for a CLI run: no API keys, and nothing inherited from a surrounding Claude Code session. */
function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|OPENAI_API_KEY$)/.test(key)) {
      delete env[key];
    }
  }
  // OpenCode takes its project directory from PWD, not from the process's cwd.
  env.PWD = repoRoot();
  return env;
}

/** Runs a CLI in the workspace and resolves with its output; rejects on a non-zero exit or after `timeoutMs`. */
function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot(), env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not finish within ${timeoutMs} ms:\n${output}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const strays = strayFiles();
      if (strays.length > 0) {
        reject(new Error(`${command} changed files outside the test workspace: ${strays.join(", ")}`));
      } else if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} exited with ${code}:\n${output}`));
      }
    });
  });
}

/** Files the assistants were asked to touch that showed up in the extension checkout instead of the workspace. */
function strayFiles(): string[] {
  const checkout = path.resolve(__dirname, "..", "..", "..");
  return ["notes.txt", "index.js"].filter((name) => fs.existsSync(path.join(checkout, name)));
}

/** Sends one prompt to Claude Code in print mode, allowing edits and simple shell commands (or only `tools`). */
function claude(prompt: string, tools = "Read,Edit,Write,Bash(echo:*),Bash(cat:*)"): Promise<string> {
  return run("claude", [
    "-p", prompt,
    "--model", process.env.FR_LIVE_CLAUDE_MODEL ?? "haiku",
    ...(tools.includes("Edit") ? ["--permission-mode", "acceptEdits"] : []),
    "--allowedTools", tools,
    "--max-turns", "4",
  ], 180_000);
}

/** Sends one prompt to OpenCode with its own private server, auto-approving permissions. */
function opencode(prompt: string, model = process.env.FR_LIVE_OPENCODE_MODEL): Promise<string> {
  return run("opencode", ["run", "--standalone", "--auto", ...(model ? ["--model", model] : []), prompt], 300_000);
}

type RecordedCommit = { subject: string; files: string[]; body: string };

/** Lists the recorded commits on the final branch (oldest first) with the files each one changed. */
function recordedCommitsWithFiles(): RecordedCommit[] {
  const root = repoRoot();
  return git(root, "rev-list", "--reverse", `e2e-base..${BRANCH}`).split("\n").filter(Boolean).map((sha) => {
    const message = git(root, "log", "-1", "--format=%B", sha);
    return {
      subject: message.split("\n")[0],
      body: message,
      files: git(root, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean),
    };
  });
}

/** The commits that changed `file`. */
function commitsFor(commits: RecordedCommit[], file: string): RecordedCommit[] {
  return commits.filter((commit) => commit.files.includes(file));
}

/** Keeps the raw assistant logs of a live run next to the compiled tests, for turning into fixtures. */
function keepLogs(name: string, rels: string[]): void {
  const dir = path.resolve(__dirname, "..", "..", "live-logs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of rels) {
    const file = path.join(repoRoot(), rel);
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(dir, path.basename(rel)));
    }
  }
}

(LIVE ? suite : suite.skip)("Live assistants", () => {
  let dialogs: ReturnType<typeof stubDialogs>;

  suiteSetup(async () => {
    await getApi();
    await setSetting("commitMode", "trackingWorktree");
    await setSetting("debounceMs", 1_000);
  });

  setup(async () => {
    await resetRepo();
  });

  teardown(() => dialogs?.restore());

  test("Claude Code: human edit, Edit tool, shell command and read are attributed correctly", async function () {
    this.timeout(900_000);
    await configureClaudeHooks();
    dialogs = stubDialogs({});
    await startRecording();
    await humanEdit("readme.md", "\nhuman line\n");
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repoRoot(), "index.js")));

    await claude("Use your Edit tool to add the line `// live edit` as the very first line of index.js. Change nothing else.");
    await sleep(3_000);
    await claude("Run exactly this shell command and nothing else: echo 'live shell' >> notes.txt");
    await sleep(3_000);
    await claude("Read readme.md and answer with its first word only. Do not change any file.");
    await sleep(3_000);
    await stopRecording();
    keepLogs("claude", [HOOK_LOG]);

    const commits = recordedCommitsWithFiles();
    const summary = commits.map((commit) => `${commit.subject}: ${commit.files.join(", ")}`).join("\n");
    assert.deepEqual(commitsFor(commits, "readme.md").map((c) => c.subject), ["Flight Recorder: human edits (1 file)"], summary);
    const edit = commitsFor(commits, "index.js");
    assert.equal(edit.length, 1, summary);
    assert.match(edit[0].subject, /Flight Recorder: assistant tool edit/, summary);
    assert.match(edit[0].body, /"confidence":"(high|medium)"/, summary);
    assert.ok(commitsFor(commits, "notes.txt").every((c) => /assistant/.test(c.subject)) && commitsFor(commits, "notes.txt").length === 1, summary);
    assert.ok(commits.some((commit) => commit.files.some((file) => file.startsWith(".log/claude-"))), summary);
    assert.match(fs.readFileSync(path.join(repoRoot(), "index.js"), "utf8"), /^\/\/ live edit/);
  });

  test("OpenCode: human edit, edit tool and shell command are attributed correctly", async function () {
    this.timeout(900_000);
    await configureOpenCodePlugin();
    dialogs = stubDialogs({});
    await startRecording();
    await humanEdit("readme.md", "\nhuman line\n");

    await opencode("Use your edit tool to add the line `// opencode live` as the very first line of index.js. Change nothing else.");
    await sleep(3_000);
    await opencode("Run exactly this shell command and nothing else: echo 'opencode shell' >> notes.txt");
    await sleep(3_000);
    await stopRecording();
    keepLogs("opencode", [OPENCODE_LOG]);

    const records = fs.readFileSync(path.join(repoRoot(), OPENCODE_LOG), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const kinds = new Set(records.map((record) => record.kind));
    for (const kind of ["setup", "pre", "post", "step", "idle"]) {
      assert.ok(kinds.has(kind), `plugin wrote a ${kind} record (kinds: ${[...kinds].join(", ")})`);
    }
    assert.ok(records.some((record) => record.kind === "idle" && record.outcome === "succeeded"), "run end recorded");
    // B0: the plugin was loaded for this repository by OpenCode 2.x.
    const setup = records.find((record) => record.kind === "setup");
    assert.equal(fs.realpathSync(setup.directory), fs.realpathSync(repoRoot()));
    assert.match(String(setup.app?.version), /^2\./);

    const commits = recordedCommitsWithFiles();
    const summary = commits.map((commit) => `${commit.subject}: ${commit.files.join(", ")}`).join("\n");
    assert.deepEqual(commitsFor(commits, "readme.md").map((c) => c.subject), ["Flight Recorder: human edits (1 file)"], summary);
    const edit = commitsFor(commits, "index.js");
    assert.equal(edit.length, 1, summary);
    assert.match(edit[0].subject, /Flight Recorder: assistant/, summary);
    // B2: index.js was never open in an editor, so only the diff evidence counts.
    assert.match(edit[0].body, /"path":"index.js","origin":"assistant-tool-edit","confidence":"medium"/, edit[0].body);
    assert.ok(commitsFor(commits, "notes.txt").every((c) => /assistant/.test(c.subject)) && commitsFor(commits, "notes.txt").length === 1, summary);
    assert.ok(commits.some((commit) => commit.files.some((file) => file.startsWith(".log/opencode"))), summary);
  });

  test("OpenCode with a GPT model: edits and new files are the assistant's (patch tool if the model gets it)", async function () {
    this.timeout(900_000);
    // Default: the local gpt-oss through Ollama (free; OpenCode gives it edit/write).
    // Hosted OpenAI GPT models get the `patch` tool; set FR_LIVE_OPENCODE_PATCH_MODEL
    // to one your Copilot plan allows for OpenCode.
    const model = process.env.FR_LIVE_OPENCODE_PATCH_MODEL ?? "ollama/gpt-oss:20b";
    if (model.startsWith("ollama/") && !(await fetch("http://127.0.0.1:11434/api/tags").then((res) => res.ok, () => false))) {
      this.skip();
    }
    await configureOpenCodePlugin();
    dialogs = stubDialogs({});
    await startRecording();

    // GPT models edit through OpenCode's `patch` tool instead of `edit`.
    await opencode(
      "Add the line `// patched` as the very first line of index.js, and create a new file hello.txt containing the single line `hello`. Change nothing else.",
      model
    );
    await sleep(3_000);
    await stopRecording();
    keepLogs("opencode-patch", [OPENCODE_LOG]);

    const records = fs.readFileSync(path.join(repoRoot(), OPENCODE_LOG), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const tools = [...new Set(records.filter((record) => record.kind === "pre").map((record) => record.tool))];
    console.log(`Live GPT run (${model}) used the tools: ${tools.join(", ")}`);
    // B3: a file the model creates with `write` is reported as new.
    const writes = records.filter((record) => record.kind === "post" && record.tool === "write" && /hello\.txt$/.test(String(record.input?.path ?? record.input?.filePath)));
    for (const write of writes) {
      assert.equal(write.output?.existed, false, JSON.stringify(write.output));
    }
    if (tools.includes("patch")) {
      assert.ok(records.some((record) => record.kind === "post" && record.tool === "patch"), "patch post record");
    }
    const commits = recordedCommitsWithFiles();
    const summary = commits.map((commit) => `${commit.subject}: ${commit.files.join(", ")}`).join("\n");
    for (const file of ["index.js", "hello.txt"]) {
      const touching = commitsFor(commits, file);
      assert.equal(touching.length, 1, `${file}\n${summary}`);
      assert.match(touching[0].subject, /Flight Recorder: assistant/, summary);
    }
    assert.match(fs.readFileSync(path.join(repoRoot(), "index.js"), "utf8"), /^\/\/ patched/);
  });

  test("Claude Code: a denied edit leaves the participant's later edit of that file human", async function () {
    this.timeout(600_000);
    await configureClaudeHooks();
    dialogs = stubDialogs({});
    await startRecording();

    // Without permission for Edit, print mode denies the edit like a participant would.
    await claude("Use your Edit tool to add the line `// denied` as the first line of index.js.", "Read").catch((err) => console.log(String(err).slice(0, 300)));
    await sleep(3_000);
    await humanEdit("index.js", "// written by the participant\n");
    await sleep(3_000);
    await stopRecording();
    keepLogs("claude-denied", [HOOK_LOG]);

    const hooks = fs.readFileSync(path.join(repoRoot(), HOOK_LOG), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    console.log(`Denied-edit run hooks: ${hooks.map((hook) => `${hook.hook_event_name}${hook.tool_name ? ` ${hook.tool_name}` : ""}`).join(", ")}`);
    const commits = recordedCommitsWithFiles();
    const summary = commits.map((commit) => `${commit.subject}: ${commit.files.join(", ")}`).join("\n");
    assert.doesNotMatch(fs.readFileSync(path.join(repoRoot(), "index.js"), "utf8"), /\/\/ denied/);
    assert.deepEqual(commitsFor(commits, "index.js").map((commit) => commit.subject), ["Flight Recorder: human edits (1 file)"], summary);
  });
});
