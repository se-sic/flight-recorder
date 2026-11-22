import { ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

// Drives a real VS Code window from outside over the Chrome DevTools Protocol
// (VS Code's workbench is a Chromium page). Unlike the e2e tests, which run
// inside the extension host, these tests survive "Reload Window", closing the
// window, or killing VS Code, and use the UI the way a participant would:
// command palette, typing, saving.

/** The checkout this test was compiled from (the nearest folder with the extension's package.json). */
function findExtensionRoot(): string {
  for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === "flight-recorder") {
      return dir;
    }
  }
  throw new Error(`No flight-recorder package.json above ${__dirname}`);
}

export const EXTENSION_ROOT = findExtensionRoot();
const CDP_TIMEOUT_MS = 15_000;

/** Every window launched by this process, so a failing test cannot leave one running. */
const openWindows = new Set<VsCodeWindow>();

/** Kills every VS Code window this process launched. */
export async function closeAllWindows(): Promise<void> {
  await Promise.all([...openWindows].map((window) => window.kill()));
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

/** A minimal CDP connection to one page target. */
class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (waiter) {
        this.pending.delete(message.id!);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  /** Opens a session on the target's WebSocket debugger URL. */
  static open(url: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpSession(socket)));
      socket.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)));
    });
  }

  /** Sends one CDP command and resolves with its result. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} got no answer within ${CDP_TIMEOUT_MS} ms`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `condition` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor<T>(condition: () => T | Promise<T>, what: string, timeoutMs = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) {
        return value as NonNullable<T>;
      }
    } catch {
      // Not ready yet (e.g. the page is reloading).
    }
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** Finds a free TCP port for the debugging endpoint. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

type Target = { type: string; url: string; webSocketDebuggerUrl: string };

/** One running VS Code instance with the extension under development. */
export class VsCodeWindow {
  private page: CdpSession | null = null;

  private constructor(
    private readonly process: ChildProcess,
    private readonly port: number,
    readonly workspace: string
  ) {}

  /**
   * Launches VS Code on `workspace` with the compiled extension from this
   * checkout. `userDataDir` keeps settings and workspace state across
   * launches of the same test.
   */
  static async launch(workspace: string, userDataDir: string): Promise<VsCodeWindow> {
    const executable = await downloadAndUnzipVSCode({ cachePath: path.join(EXTENSION_ROOT, ".vscode-test") });
    const port = await freePort();
    const child = spawn(executable, [
      workspace,
      `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
      `--remote-debugging-port=${port}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--new-window",
    ], { stdio: "ignore" });
    const window = new VsCodeWindow(child, port, workspace);
    openWindows.add(window);
    await window.connect();
    return window;
  }

  /** Connects to the workbench page and waits until the Flight Recorder status bar item is shown. */
  async connect(): Promise<void> {
    this.page?.close();
    const target = await waitFor(async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as Target[];
      return targets.find((candidate) => candidate.type === "page" && candidate.url.includes("workbench"));
    }, "the VS Code workbench page", 60_000);
    this.page = await CdpSession.open(target.webSocketDebuggerUrl);
    await waitFor(async () => /Flight Recorder/.test(await this.bodyText()), "the Flight Recorder status bar item", 60_000);
  }

  /** Evaluates an expression in the workbench page. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.page!.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true });
    return result.result.value;
  }

  /** The visible text of the workbench (status bar, notifications, editors). */
  bodyText(): Promise<string> {
    return this.evaluate<string>("document.body.innerText");
  }

  /** Presses one key, with optional CDP modifiers (1 Alt, 2 Ctrl, 4 Meta, 8 Shift). */
  async press(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.page!.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.page!.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Types text into whatever has the focus. */
  async type(text: string): Promise<void> {
    await this.page!.send("Input.insertText", { text });
  }

  /** Runs a command by its title through the command palette, like a user. */
  async runCommand(title: string): Promise<void> {
    await this.press("F1", "F1", 112);
    await waitFor(() => this.evaluate<boolean>("!!document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input')"), "the command palette");
    await this.type(title);
    await waitFor(
      () => this.evaluate<boolean>(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((row) => row.innerText.includes(${JSON.stringify(title)}))`),
      `the command "${title}"`
    );
    await this.press("Enter", "Enter", 13);
    await sleep(500);
  }

  /** Opens a workspace file through Quick Open and waits for its editor. */
  async openFile(rel: string): Promise<void> {
    await this.runCommand("Go to File...");
    await this.type(rel);
    await sleep(700);
    await this.press("Enter", "Enter", 13);
    await waitFor(() => this.evaluate<boolean>(`!!document.querySelector('.tab.active[aria-label*=${JSON.stringify(path.basename(rel))}]')`), `the editor for ${rel}`);
    await sleep(300);
  }

  /** Reads the text of every webview (e.g. the Flight Recorder panel) the window shows. */
  async webviewTexts(): Promise<string[]> {
    const targets = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as Target[];
    const texts: string[] = [];
    const webviews = targets.filter((candidate) => candidate.type === "iframe" && candidate.url.startsWith("vscode-webview://"));
    for (const target of webviews) {
      const session = await CdpSession.open(target.webSocketDebuggerUrl);
      try {
        const result = await session.send<{ result: { value: string } }>("Runtime.evaluate", {
          // The webview host page shows the extension's HTML in an inner frame.
          expression: "(document.querySelector('iframe')?.contentDocument?.body ?? document.body)?.innerText ?? ''",
          returnByValue: true,
        });
        texts.push(result.result.value);
      } finally {
        session.close();
      }
    }
    return texts;
  }

  /** Saves the active editor with the platform's save shortcut. */
  async save(): Promise<void> {
    await this.press("s", "KeyS", 83, process.platform === "darwin" ? 4 : 2);
    await sleep(800);
  }

  /** Runs "Developer: Reload Window" and reconnects once the new workbench is up. */
  async reload(): Promise<void> {
    await this.runCommand("Developer: Reload Window");
    await sleep(2_000);
    await this.connect();
  }

  /** Kills VS Code without giving it any chance to shut down, like a crash. */
  async kill(): Promise<void> {
    openWindows.delete(this);
    this.page?.close();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      const exited = new Promise((resolve) => this.process.once("exit", resolve));
      this.process.kill("SIGKILL");
      await exited;
    }
  }

  /** Closes VS Code normally and waits for it to exit. */
  async quit(): Promise<void> {
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    await this.press("q", "KeyQ", 81, process.platform === "darwin" ? 4 : 2);
    await Promise.race([exited, sleep(30_000).then(() => this.process.kill("SIGKILL"))]);
    openWindows.delete(this);
    this.page?.close();
  }
}

/** Creates a fresh git repository set up for recording with Claude's hook log. */
export function makeWorkspace(): { workspace: string; userDataDir: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fr-ui-")));
  const workspace = path.join(root, "repo");
  const userDataDir = path.join(root, "ud");
  fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.mkdirSync(path.join(userDataDir, "User"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "readme.md"), "# UI test repo\n");
  fs.writeFileSync(path.join(workspace, "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(workspace, ".claude", "flight-recorder-hooks.jsonl"), "");
  fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
    "flightRecorder.activeIntegration": "claude-code",
    "flightRecorder.claudeSource": "hookLog",
    "flightRecorder.exportChatsOnStop": false,
    "flightRecorder.debounceMs": 1000,
  }, null, 2));
  fs.writeFileSync(path.join(userDataDir, "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "files.autoSave": "off",
    "git.enabled": false,
    "chat.disableAIFeatures": true,
  }, null, 2));
  const exclude = [".claude/", ".vscode/"].join("\n");
  git(workspace, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(workspace, ".git", "info", "exclude"), `${exclude}\n`);
  git(workspace, "config", "user.name", "UI Test");
  git(workspace, "config", "user.email", "ui@example.com");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "add", ".");
  git(workspace, "commit", "-q", "-m", "initial commit");
  return { workspace, userDataDir };
}

/** Runs git in `cwd` and returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Appends one Claude hook payload to the workspace's hook log. */
export function appendHook(workspace: string, payload: Record<string, unknown>): void {
  fs.appendFileSync(
    path.join(workspace, ".claude", "flight-recorder-hooks.jsonl"),
    `${JSON.stringify({ session_id: "ui-session", cwd: workspace, ...payload })}\n`
  );
}

/** Lists local branch names. */
export function branches(workspace: string): string[] {
  return git(workspace, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);
}
