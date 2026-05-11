# Flight Recorder

Flight Recorder monitors Copilot-related edit events from VS Code logs, commits them to a repository, exports Copilot chat logs, and provides functionality to anonymize and analyze the collected data.

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
- `Flight Recorder: Export All Chats` (`flightRecorder.exportAllChats`)
- `Flight Recorder: Anonymize Repository` (`flightRecorder.anonymizeRepo`)
- `Flight Recorder: Edit History Visualization` (`flightRecorder.editHistoryVisualization`)
- `Flight Recorder: Print Copilot Log Path` (`flightRecorder.printLog`)

## Requirements

- VS Code `1.108.0+`
- Git available in your `PATH`
- Python `3.x` available in your `PATH` to create the extension-managed `git-filter-repo` environment for repository anonymization
- Opened folder is a Git repository
- GitHub Copilot Chat extension installed
- Debug-level GitHub Copilot Chat logging must be enabled by VS Code; the extension attempts to configure this automatically when recording starts
- Trusted workspace for repository anonymization

## Quick Start

1. Open a Git repository in VS Code.
2. Click `Start Flight Recorder` in the status bar, or run the start command from the command palette.
3. Work with Copilot (inline suggestions and/or agent edits).
4. Check progress in the `Flight Recorder` output channel.
5. Click `Stop Flight Recorder` in the status bar to finish the session.

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

- `debounceMs` (default `0`): wait for an idle period before committing.
- `addAll` (default `false`): stage all changed files before commit.
- `allowEmpty` (default `false`): allow empty commits.
- `dryRun` (default `false`): print actions without creating commits.
- `forceAddGeneratedLogs` (default `true`): force-stage generated `.log` and `.chat-log` artifacts so repository ignore rules do not block their dedicated commits.
- `exportChatsOnStop` (default `true`): automatically export chat session files into `.chat-log` and commit them in a separate shutdown commit when recording stops.
- `absolutePathHandling` (default `repoOnly`): controls how absolute paths are rewritten during repository anonymization. `none` leaves paths unchanged, `repoOnly` rewrites only absolute paths containing the repository root, and `all` rewrites all detected absolute paths and file URIs in file contents and commit/tag messages. `absolutePathHandling` applies when running `Flight Recorder: Anonymize Repository`, including generated `.log` and `.chat-log` artifacts in repository history.
