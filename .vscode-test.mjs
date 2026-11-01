import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Every e2e run gets a fresh throwaway git repository as its workspace.
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-e2e-workspace-')));
const git = (...args) => execFileSync('git', args, { cwd: workspace });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'E2E User');
git('config', 'user.email', 'e2e@example.com');
git('config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(workspace, 'readme.md'), '# E2E repo\n');
fs.writeFileSync(path.join(workspace, 'index.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules/\n');
git('add', '.');
git('commit', '-q', '-m', 'initial commit');
git('tag', 'e2e-base');

// VS Code's IPC socket path must stay under ~103 characters, so keep user data short.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-e2e-ud-'));

export default defineConfig({
	files: 'out/test/e2e/**/*.test.js',
	workspaceFolder: workspace,
	launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userDataDir}`],
	mocha: {
		ui: 'tdd',
		timeout: 60000,
	},
});
