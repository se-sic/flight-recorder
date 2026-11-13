# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.

## Rules for `README.md`

`README.md` is the **VS Code Marketplace page** of this extension. It is written for end users who are deciding whether to install the extension and want to get started. It is not developer documentation.

- **Do not edit `README.md` as part of routine changes** such as refactors, bug fixes, new internal behavior, new tests or small settings.
- Edit it **only when a change makes it wrong or incomplete for a user**: a renamed or removed command or setting, changed defaults it lists, changed requirements, a changed recording location or branch name, or a major new user-facing feature. Change only the affected lines and keep its tone and structure.
- Do not add implementation details, architecture, source file paths, test instructions or changelogs to it. Put those in this file instead.
- When unsure, leave the README unchanged and mention the possible update to the user.

## What the extension does

Flight Recorder is a VS Code extension (publisher `SE-SIC`) for studying how developers work with AI coding assistants. While recording, it:

1. Watches VS Code workspace edits (text changes, create, rename, delete).
2. Tails the active assistant's log and parses it into a shared `AssistantEvent` model.
3. Splits the edit stream into **human** and **assistant** windows and commits each window separately to a recording branch.
4. On stop, commits a snapshot of the assistant log (`.log/`) and, optionally, the chat sessions active during the recording (`.chat-log/`).

Other features: a recording history sidebar with push support, recovery of interrupted recordings, a line-level edit-history visualization based on `git blame`, and repository anonymization via `git-filter-repo`.

## Repository layout

```
src/
  extension.ts                 Activation: log channel, status bar, command registration, test API
  recording/
    session.ts                 Recording lifecycle: start/stop, status bar, recovery, log tailing, wiring
    staging-tracker.ts         Human/assistant window model and commit subjects
    commits.ts                 Git side: readiness checks, hidden worktree, tracking/final branches,
                               commit of windows, log and chat snapshots, finalize/recover
    chat-export.ts             Export of Copilot Chat and Copilot CLI sessions to .chat-log/
    event.ts                   Integration-independent AssistantEvent model
    integration.ts             AssistantIntegration contract and registry
    agents/
      copilot/                 GitHub Copilot: log discovery and debug logging, log parser,
                               Chat session files, Copilot CLI session-state
      claude/                  Claude Code: hook setup and hook script, transcript/hook parser,
                               config dir resolution
  history-panel/               "Recording History" webview: git queries, HTML, push
  visualization/               Edit history view: blame/ownership, coloring modes, palettes,
                               decorations, legend webview
  anonymization/               git-filter-repo install in a private venv, rewrite of identities
                               and absolute paths
  utils/                       git runner, logging channel, file tailer, constants;
                               fs-path.ts: path normalization (see "File paths" below)
test/                          Unit tests (node:test), run outside VS Code
test/e2e/                      End-to-end tests (mocha, run inside VS Code via @vscode/test-cli)
assets/                        Extension icons
package.json                   Commands, views, menus and settings (the contributes section)
```

## Key concepts

### Assistant integrations

`src/recording/integration.ts` defines `AssistantIntegration`. An integration prepares recording for a repository and returns a log file, a parser (`feed(chunk) → AssistantEvent[]`) and optional runtime event sources. The result can be `ok`, `pending` (wait for the log to appear) or failed with an optional setup action. The recorder core only consumes `AssistantEvent`s from `event.ts`, so adding an assistant should only require a new folder under `agents/`, registration in `AVAILABLE_ASSISTANT_INTEGRATIONS`, and a new value for `flightRecorder.activeIntegration` in `package.json`.

- **Copilot** turns on Copilot Chat debug logging, because edit-tool and inline-completion signals are only logged at debug level. Copilot CLI sessions under `~/.copilot/session-state/` are matched to the repository by `cwd` or `git_root`.
- **Claude Code** reads either a hook log (`claudeSource = hookLog`, default) or transcripts under `~/.claude/projects/`. `Configure Claude Hooks` writes a hook script and registers it in `.claude/settings(.local).json`. The integration is experimental.

### Attribution model

Attribution is window-based, not per-edit:

- Edits before an assistant event are human.
- From an assistant event until `flightRecorder.debounceMs` of assistant inactivity, all edits belong to the assistant, including manual ones.
- After the timeout, edits are human again.

At the human-to-assistant boundary, files named by the first assistant event go to the assistant, because VS Code change events can arrive before the assistant log line that caused them. Commit subjects are `Flight Recorder: human edits (N files)` and `Flight Recorder: assistant <origin> (N files)`. The visualization parses these subjects (`visualization/coloring.ts`), so keep both in sync.

This trade-off is part of the study protocol. Do not change it without the maintainers agreeing.

### Recording branches

With `commitMode = trackingWorktree` (default), recording happens in a hidden worktree on `flight-recorder-active/<source-branch>/<session-id>`. On stop, the final branch `flight-recorder/<source-branch>` is fast-forwarded or created, and the worktree and active branch are removed. If fast-forwarding is not possible, both are kept for **Recover Unfinished Recordings**, which can save the result as `flight-recorder/<source-branch>-<session-id>`. Recording branches are **never force-updated**. `commitMode = currentBranch` commits directly in the user's checkout.

Push uses an explicit refspec and only pushes the recording branch. The last recording branch is stored in workspace state.

### Chat export

`Export All Chats` copies sessions as-is: Copilot Chat → `.chat-log/copilot-chat/<YYYY-MM-DD_HHMM>_<title>.jsonl`, Copilot CLI → `.chat-log/copilot-cli/<YYYY-MM-DD_HHMM>_<title>/`. On stop (`exportChatsOnStop`), only sessions active during the recording are exported and committed separately. `forceAddGeneratedLogs` stages `.log/` and `.chat-log/` even if they are ignored.

### Anonymization

Creates `anonymous-repo-<timestamp>` in a chosen folder using a pinned `git-filter-repo` installed in a private Python venv under the extension's global storage. It rewrites authors and committers to `Anonymous Developer`, `Anonymous Developer 2`, … and replaces absolute paths according to `absolutePathHandling` (`none`, `repoOnly`, `all`) in file contents, generated logs, and commit and tag messages. It requires a trusted workspace.

### Edit history visualization

Combines `git blame` with patch replay (`visualization/blame.ts`) to assign each line to a commit. Lines are colored by commit age in the whole history (`global`) or in the file (`file`), or by event origin (`event`: agent edit, inline completion, mixed). The legend webview lets the user switch mode and palette (Paul Tol color schemes). Only saved `file:` documents are decorated.

## File paths

The extension must work on Windows, macOS and Linux, and paths reach it from several sources that spell the same file differently. VS Code reports `e:\repo\a.ts`, Claude Code `E:\repo\a.ts`, Copilot logs `file:///e%3A/repo/a.ts`, and on macOS git may report `/private/var/...` where Node sees `/var/...`. Comparing such strings directly makes attribution, snapshots and anonymization silently fail.

All path handling therefore goes through `src/utils/fs-path.ts`:

- **Normalize every path where it enters the extension**, and compare plain strings afterwards. The entry points are VS Code URIs, assistant logs, hook payloads, git output and settings.
  - `normalizePath(...segments)`: use it instead of `path.resolve` for any path that is stored or compared. It returns an absolute path with native separators, no trailing separator and an upper-case Windows drive letter. The rest of the path keeps its case.
  - `uriToPath(uri)`: use it instead of `uri.fsPath`. Lint rejects `.fsPath` everywhere else.
  - `pathFromFileUri(uri)`: use it for `file://` strings in logs. Do not parse URIs by hand.
- **Compare and relate paths with the helpers:**
  - `samePath(a, b)`: case-insensitive on Windows. Use it for roots and directories that users may type, such as a terminal `cwd`.
  - `relativePathInside(root, p)`: returns a relative path with `/`, or null if `p` is outside `root`. Do not use `startsWith(root)`.
  - `realDirectoryPath(dir)`: resolves symlinks. Use it only for directories such as the repository or worktree roots, never for files, because a symlinked file must be committed as the link.
- **Text matching is a separate case.** Anonymization searches for paths inside log text, so it has to list every spelling of the repository root (`repoRootReplacementPairs` in `anonymization/path-sanitization.ts`). Add new spellings there.
- **Tests must hold on every OS:**
  - Build file URIs with `pathToFileURL` and expected paths with `normalizePath`. Do not concatenate strings such as `file://${dir}`.
  - Mark tests for platform-specific behavior with `{ skip: process.platform !== "win32" }` or a similar check.
  - Expect missing permissions: creating symlinks on Windows requires Developer Mode.

## Development

```sh
npm install
npm run compile      # tsc → out/
npm run lint         # eslint src
npm run test:unit    # unit tests in test/*.test.ts (node:test, no VS Code)
npm test             # compile + lint + e2e tests in a VS Code instance
```

E2E tests (`.vscode-test.mjs`) create a fresh throwaway Git repository as the workspace and start VS Code with other extensions disabled. `activate()` returns a read-only `FlightRecorderApi` used only by these tests.

## Conventions

- TypeScript, strict mode. Shell out to Git with `gitCmd` from `utils/git.ts`. Log to the shared output channel with `getLogChannel()`.
- Handle file paths only through `utils/fs-path.ts` (see "File paths").
- Give exported functions a one-line `/** … */` doc comment that says what the function does.
- New commands and settings must be declared in `package.json` `contributes`. Commands use the `flightRecorder.` prefix and a `Flight Recorder: …` title.
- Never modify the user's checked-out branch, index or working tree in `trackingWorktree` mode, and never force-push or force-update recording branches.
- Add unit tests for pure logic (parsers, attribution, path sanitization, coloring) and e2e tests for recording lifecycle changes.
- Follow the README rules at the top of this file.
