# Flight Recorder

Flight Recorder is a VS Code extension for recording interactions with AI coding assistants. It records changes to a Git repository as a sequence of commits, separating edits made by the developer from edits made by the assistant, and stores the assistant log and chat sessions alongside them. The resulting recordings can be inspected, visualized and anonymized for analysis.

Supported assistants:

- GitHub Copilot (inline completions, Chat, agent mode, Copilot CLI)
- Claude Code (experimental)
- OpenCode 2.0 or later (experimental)

## Requirements

- VS Code 1.108 or later
- Git available on `PATH`
- The opened folder must be a Git repository
- A supported coding assistant (currently GitHub Copilot, Claude Code or OpenCode)
- For repository anonymization: Python 3 available on `PATH`

## Usage

1. Open a Git repository in VS Code.
2. Start recording with `Start Flight Recorder` in the status bar or `Flight Recorder: Start Recording` in the command palette.
3. Work with the assistant.
4. Stop recording with `Stop Flight Recorder` in the status bar.

The recording is stored on the branch `flight-recorder/<source-branch>`. Recording takes place in a separate, hidden Git worktree, so the current branch, index and working tree are not modified. The `Flight Recorder` view in the activity bar lists the commits of the last recording.

### Claude Code

Run `Flight Recorder: Configure Claude Hooks` once per repository. This registers a hook script in the Claude Code project settings and sets the workspace to use the Claude Code integration. Start a new Claude Code session afterwards so that the hooks are loaded. Without hooks, Flight Recorder falls back to reading Claude Code transcripts, which is less precise.

### OpenCode

Run `Flight Recorder: Configure OpenCode Plugin` once per repository. This installs a small plugin in `.opencode/plugins/` that OpenCode loads automatically, and sets the workspace to use the OpenCode integration. Run the command again after updating Flight Recorder; it warns when the installed plugin is outdated. OpenCode 1.x is not supported.

The assistant to record is selected with `flightRecorder.activeIntegration`. Set it to `askOnStartup` to choose each time a recording starts.

## Recorded data

A recording branch contains:

- `Flight Recorder: human edits` commits with changes made by the developer
- `Flight Recorder: assistant ...` commits with changes made while the assistant was active
- a snapshot of the assistant log in `.log/`
- the chat sessions active during the recording in `.chat-log/` (if `flightRecorder.exportChatsOnStop` is enabled)

Changes are attributed by time: after an assistant event, all changes are attributed to the assistant until no further assistant activity has occurred for `flightRecorder.debounceMs` milliseconds. Manual edits made during this interval are therefore attributed to the assistant.

Recordings are not uploaded automatically. `Flight Recorder: Push Recording Branch` pushes only the recording branch. Note that recordings include chat prompts and assistant logs.

## Commands

- `Flight Recorder: Start Recording` / `Flight Recorder: Stop Recording`
- `Flight Recorder: Push Recording Branch` – push the last recording branch
- `Flight Recorder: Recover Unfinished Recordings` – finalize recordings that were interrupted, e.g. by closing VS Code
- `Flight Recorder: Open Edit History Visualization` – color the lines of the current file by the commit that last changed them
- `Flight Recorder: Anonymize Repository` – create a copy of the repository with anonymized authors and absolute paths
- `Flight Recorder: Export All Chats` – export the chat sessions of the workspace to `.chat-log/`
- `Flight Recorder: Configure Claude Hooks` – set up the Claude Code integration
- `Flight Recorder: Configure OpenCode Plugin` – set up the OpenCode integration

## Configuration

Commonly used settings:

- `flightRecorder.activeIntegration` (default `github-copilot`): assistant to record (`github-copilot`, `claude-code`, `opencode`, `askOnStartup`)
- `flightRecorder.debounceMs` (default `1000`): time in milliseconds after the last assistant activity during which changes are attributed to the assistant
- `flightRecorder.exportChatsOnStop` (default `true`): export chat sessions when recording stops
- `flightRecorder.absolutePathHandling` (default `repoOnly`): absolute paths replaced during anonymization (`none`, `repoOnly`, `all`)

All settings are described in the VS Code settings under Extensions › Flight Recorder.

## License
The source code to this extension is available on https://github.com/se-sic/flight-recorder and licensed under the MIT license.
