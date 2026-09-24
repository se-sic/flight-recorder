# Flight Recorder

Flight Recorder monitors coding-assistant events, combines them with fine-grained VS Code workspace edit events, commits them to a repository, exports Copilot chat logs, and provides functionality to anonymize and analyze the collected data.

## UI Usage

- A permanent status bar button is shown at the bottom of VS Code for recording control.
- When idle, the button shows `Start Flight Recorder`.
- While recording, the same button changes to `Stop Flight Recorder`.
- A second permanent status bar button, `Anonymize Repository`, starts creation of an anonymized copy of the current repository.
- Start and stop are also contributed to the editor title area and the command palette, but the status bar buttons are the most reliable entry point.

## Commands

The following commands can be executed from the command palette:

- `Flight Recorder: Start Recording` (`flightRecorder.start`)
- `Flight Recorder: Stop Recording` (`flightRecorder.stop`)
- `Flight Recorder: Configure Claude Hooks` (`flightRecorder.configureClaudeHooks`)
- `Flight Recorder: Export All Chats` (`flightRecorder.exportAllChats`)
- `Flight Recorder: Anonymize Repository` (`flightRecorder.anonymizeRepo`)
- `Flight Recorder: Edit History Visualization` (`flightRecorder.editHistoryVisualization`)
- `Flight Recorder: Print Assistant Log Path` (`flightRecorder.printLog`)

## Requirements

- VS Code `1.108.0+`
- Git available in your `PATH`
- Python `3.x` available in your `PATH` to create the extension-managed `git-filter-repo` environment for repository anonymization
- Opened folder is a Git repository
- GitHub Copilot Chat extension installed if you use the `github-copilot` integration
- Claude Code installed and actively writing session data if you use the `claude-code` integration
- Debug-level GitHub Copilot Chat logging must be enabled by VS Code for the Copilot integration; the extension attempts to configure this automatically when recording starts
- Trusted workspace for repository anonymization

## Quick Start

1. Open a Git repository in VS Code.
2. Click `Start Flight Recorder` in the status bar, or run the start command from the command palette.
3. Work with Copilot (inline suggestions and/or agent edits).
4. Check progress in the `Flight Recorder` output channel.
5. Click `Stop Flight Recorder` in the status bar to finish the session.

## Assistant Integrations

Flight Recorder resolves one active assistant integration at startup through `flightRecorder.activeIntegration`.

- Current built-in integrations: `github-copilot`, `claude-code`
- Set `activeIntegration` to `askOnStartup` to be prompted for a choice each time you start recording instead of always using a fixed integration
- The selected integration controls recording setup, primary log discovery, event parsing, and assistant-log snapshot naming.
- The recorder core remains integration-agnostic; adding another assistant should mainly require registering another implementation of the integration contract documented in [docs/assistant-event-model.md](/Users/ben/Productivity/UDS/Hiwi Job/FlightRecorder/flight-recorder/docs/assistant-event-model.md:1).

### Claude Code (Experimental)

Claude Code support is new and less battle-tested than the Copilot integration; expect rough edges.

Flight Recorder can track Claude Code via structured hook payloads (preferred, set by `flightRecorder.claudeSource = hookLog`) or by parsing local transcript JSONL files under `~/.claude/projects/` (`transcript`, or override the directory with `CLAUDE_CONFIG_DIR`); `auto` prefers the hook log when present. Run `Flight Recorder: Configure Claude Hooks` for the lowest-friction setup: it registers Flight Recorder's hook script in your Claude project settings, switches this workspace to `activeIntegration = claude-code` and `claudeSource = hookLog`, and reminds you to start a fresh Claude session so it picks up the new hook config. Without hooks, the integration falls back to transcript parsing, which is less precise about concrete file operations.

## Fine-Grained Staging

Flight Recorder continuously tracks file changes from VS Code while recording is active.

- Human edits are collected continuously through VS Code workspace events such as text-document changes, file creation, rename, and deletion.
- When Flight Recorder detects an assistant event from the active assistant integration, it closes the current human window and commits those changes as `Flight Recorder: human edits`.
- From that moment on, every tracked file change is attributed to the assistant window until there has been no further assistant-related activity for `flightRecorder.debounceMs`.
- When that debounce window expires, Flight Recorder commits the accumulated assistant-side changes as `Flight Recorder: assistant edits`.
- When recording stops, any still-open human or assistant window is flushed before the final assistant-log snapshot and optional chat export are committed.

### Attribution Model

The implementation intentionally uses a window-based ownership model instead of trying to classify every single low-level edit operation in isolation:

- `before first assistant event` => human
- `from assistant event until debounce timeout` => assistant
- `after assistant timeout` => human again

This is conservative and reproducible, but it also means that if a user manually edits files during an open assistant window, those edits are still attributed to the assistant window. That tradeoff matches the intended study protocol and keeps the commit boundaries explicit and auditable in git history.

At the human-to-assistant boundary, Flight Recorder also prefers assistant ownership for files mentioned by the first assistant event, because VS Code document change notifications can arrive slightly before the assistant telemetry event that explains their cause.

## Chat Export

- `Flight Recorder: Export All Chats` exports the current workspace's `chatSessions` files into the opened repository under `.chat-log/<workspaceStorageId>/chatSessions`.
- Exported files are copied as-is; absolute path replacement happens later during `Flight Recorder: Anonymize Repository`.
- If `flightRecorder.exportChatsOnStop` is enabled, the same export is also performed automatically when recording stops and then committed in a dedicated git commit.

## Repository Anonymization

- `Flight Recorder: Anonymize Repository` creates a separate anonymized copy of the currently opened repository in a folder you choose.
- The resulting repository is a normal working-tree repository named `anonymous-repo-<timestamp>`.
- Author and committer identities from git history are rewritten to generated placeholders such as `Anonymous Developer`, `Anonymous Developer 2`, and so on.
- Absolute path replacement during anonymization is configurable: disable it entirely, limit it to paths containing the repository root, or replace all detected absolute paths in file contents and commit/tag messages.
- The command uses an extension-managed private Python virtual environment under VS Code global storage and installs a pinned `git-filter-repo` version there when needed.

## Settings

All settings use the `flightRecorder.*` prefix:

- `debounceMs` (default `0`): assistant-window debounce in milliseconds. Human edits are staged continuously; after an assistant event is detected, Flight Recorder keeps attributing subsequent tracked changes to the assistant until this idle timeout expires.
- `activeIntegration` (default `github-copilot`): selects which assistant integration Flight Recorder uses for recording and primary log discovery.
- `claudeSource` (default `auto`): for the Claude Code integration, choose whether Flight Recorder uses the hook log, the local transcript store, or auto-detects between them.
- `claudeHookLogPath` (default `.claude/flight-recorder-hooks.jsonl`): for the Claude Code integration, path to the JSONL hook log file. Relative paths are resolved against the repository root.
- `claudeConfigDir` (default empty): optional override for the Claude Code configuration directory. When empty, Flight Recorder uses `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.
- `claudeMissingSourceBehavior` (default `wait`): for the Claude Code integration, choose whether Flight Recorder should wait for the first repo-specific hook log/transcript to appear or fail startup immediately when no source exists yet.
- `addAll` (default `false`): stage all changed files before commit.
- `allowEmpty` (default `false`): allow empty commits.
- `dryRun` (default `false`): print actions without creating commits.
- `forceAddGeneratedLogs` (default `true`): force-stage generated `.log` and `.chat-log` artifacts so repository ignore rules do not block their dedicated commits.
- `exportChatsOnStop` (default `true`): automatically export chat session files into `.chat-log` and commit them in a separate shutdown commit when recording stops.
- `absolutePathHandling` (default `repoOnly`): controls how absolute paths are rewritten during repository anonymization. `none` leaves paths unchanged, `repoOnly` rewrites only absolute paths containing the repository root, and `all` rewrites all detected absolute paths and file URIs in file contents and commit/tag messages. `absolutePathHandling` applies when running `Flight Recorder: Anonymize Repository`, including generated `.log` and `.chat-log` artifacts in repository history.
