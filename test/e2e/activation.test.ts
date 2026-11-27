import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { EXTENSION_ID, getApi } from "./helpers";

type Manifest = {
  contributes: {
    commands: Array<{ command: string }>;
    views: Record<string, Array<{ id: string }>>;
  };
};

suite("E1 activation", () => {
  test("every command in package.json is registered after activation", async () => {
    await getApi();
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const manifest = extension.packageJSON as Manifest;
    const registered = new Set(await vscode.commands.getCommands(true));

    const missing = manifest.contributes.commands
      .map((entry) => entry.command)
      .filter((command) => !registered.has(command));

    assert.deepEqual(missing, []);
  });

  test("every registered flightRecorder command is declared in package.json", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const manifest = extension.packageJSON as Manifest;
    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));

    const undeclared = (await vscode.commands.getCommands(true))
      .filter((command) => command.startsWith("flightRecorder."))
      // VS Code generates focus/open/... commands for every contributed view.
      .filter((command) => !command.startsWith("flightRecorder.historyView."))
      .filter((command) => !declared.has(command));

    assert.deepEqual(undeclared, []);
  });

  test("the history view is contributed", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const manifest = extension.packageJSON as Manifest;
    const views = Object.values(manifest.contributes.views).flat().map((view) => view.id);
    assert.ok(views.includes("flightRecorder.historyView"));
  });

  test("a fresh workspace is not recording and has no branch state", async () => {
    const api = await getApi();
    assert.equal(api.isRecording(), false);
    assert.deepEqual(await api.listUnfinishedRecordings(), []);
  });
});
