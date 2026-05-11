import * as path from "path";
import * as vscode from "vscode";
import { buildCommitAgeEntriesFromRanges } from "./ownership";
import {
  buildFileOwnershipRanges,
  classifyVisualizationGitFailure,
  VisualizationGitFailure,
  VisualizationGitFailureKind,
} from "./blame";
import {
  buildDecorationBuckets,
  buildSelectedDecorationBuckets,
  buildVisualOwnershipRanges,
  findCommitAtPosition,
  type VisualOwnershipRange,
} from "./decorations";
import {
  buildLegendEmptyHtml,
  buildLegendHtml,
  ensureLegendPanel,
  setLegendHtml,
  type LegendPanelCallbacks,
} from "./legend";
import {
  computeFilePalettes,
  computeGlobalPalettes,
  computeEventPalettes,
  type CommitDecorationPalette,
  type EventOriginKind,
  type VisualizationColoringMode,
} from "./coloring";
import {
  findSequentialPalette,
  findQualitativePalette,
  DEFAULT_SEQUENTIAL_PALETTE_VALUE,
  DEFAULT_QUALITATIVE_PALETTE_VALUE,
} from "./palettes";
import { EXTENSION_NAME } from "../utils/constants";
import { gitCmd } from "../utils/git";
import { getLogChannel } from "../utils/logging";

type ActiveVisualization = {
  editorUri: string;
  filePath: string;
  decorationTypes: vscode.TextEditorDecorationType[];
  selectedDecorationTypes: vscode.TextEditorDecorationType[];
  commitAgeEntries: ReturnType<typeof buildCommitAgeEntriesFromRanges>;
  paletteByCommit: Map<string, CommitDecorationPalette>;
  kindByCommit: Map<string, EventOriginKind> | null;
  visualRanges: VisualOwnershipRange[];
  selectedCommitHash: string | null;
};

type VisualizationController = {
  enabled: boolean;
  subscriptions: vscode.Disposable[];
  activeVisualization: ActiveVisualization | null;
  legendPanel: vscode.WebviewPanel | null;
  extensionContext: vscode.ExtensionContext | null;
  shownFailureKinds: Set<VisualizationGitFailureKind>;
  coloringMode: VisualizationColoringMode;
  sequentialPaletteValue: string;
  qualitativePaletteValue: string;
  lastRunTimestamp: number;
};

const visualizationController: VisualizationController = {
  enabled: false,
  subscriptions: [],
  activeVisualization: null,
  legendPanel: null,
  extensionContext: null,
  shownFailureKinds: new Set<VisualizationGitFailureKind>(),
  coloringMode: "global",
  sequentialPaletteValue: DEFAULT_SEQUENTIAL_PALETTE_VALUE,
  qualitativePaletteValue: DEFAULT_QUALITATIVE_PALETTE_VALUE,
  lastRunTimestamp: 0,
};

function findVisualizationEditor(): vscode.TextEditor | undefined {
  const uri = visualizationController.activeVisualization?.editorUri;
  if (uri) {
    const found = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uri
    );
    if (found) {
      return found;
    }
  }
  const active = vscode.window.activeTextEditor;
  return active?.document.uri.scheme === "file" ? active : undefined;
}

function clearActiveVisualization(): void {
  if (!visualizationController.activeVisualization) {
    return;
  }
  for (const decorationType of visualizationController.activeVisualization.decorationTypes) {
    decorationType.dispose();
  }
  for (const decorationType of visualizationController.activeVisualization.selectedDecorationTypes) {
    decorationType.dispose();
  }
  visualizationController.activeVisualization = null;
}

function disposeSubscriptions(): void {
  for (const subscription of visualizationController.subscriptions) {
    subscription.dispose();
  }
  visualizationController.subscriptions = [];
}

function ensureLegendPanelForController(): vscode.WebviewPanel | null {
  const callbacks: LegendPanelCallbacks = {
    onColoringModeChange: (mode) => {
      if (visualizationController.coloringMode === mode) {
        return;
      }
      visualizationController.coloringMode = mode;
      if (visualizationController.enabled) {
        void applyVisualizationToEditor(findVisualizationEditor());
      }
    },
    onPaletteChange: (value) => {
      if (visualizationController.coloringMode === "event") {
        if (visualizationController.qualitativePaletteValue === value) {
          return;
        }
        visualizationController.qualitativePaletteValue = value;
      } else {
        if (visualizationController.sequentialPaletteValue === value) {
          return;
        }
        visualizationController.sequentialPaletteValue = value;
      }
      if (visualizationController.enabled) {
        void applyVisualizationToEditor(findVisualizationEditor());
      }
    },
    onDispose: () => {
      visualizationController.legendPanel = null;
      if (visualizationController.enabled) {
        stopEditHistoryVisualization();
      }
    },
  };

  const panel = ensureLegendPanel(
    visualizationController.legendPanel,
    visualizationController.extensionContext,
    callbacks
  );

  if (!panel) {
    return null;
  }

  visualizationController.legendPanel = panel;
  return panel;
}

function renderLegendEmpty(reason: string): void {
  const panel = ensureLegendPanelForController();
  if (!panel) {
    return;
  }
  setLegendHtml(panel, buildLegendEmptyHtml(reason));
}

function isEditorDarkTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return (
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast
  );
}

function updateLegendPanel(
  filePath: string,
  commits: ReturnType<typeof buildCommitAgeEntriesFromRanges>,
  paletteByCommit: Map<string, CommitDecorationPalette>,
  kindByCommit: Map<string, EventOriginKind> | null,
  selectedCommitHash: string | null
): void {
  const panel = ensureLegendPanelForController();
  if (!panel) {
    return;
  }

  const mode = visualizationController.coloringMode;
  const selectedPaletteValue = mode === "event"
    ? visualizationController.qualitativePaletteValue
    : visualizationController.sequentialPaletteValue;

  setLegendHtml(
    panel,
    buildLegendHtml(filePath, commits, paletteByCommit, kindByCommit, mode, selectedPaletteValue, selectedCommitHash)
  );
}

function updateSelectedCommitDecorations(
  activeVisualization: ActiveVisualization,
  editor: vscode.TextEditor
): void {
  for (const decorationType of activeVisualization.selectedDecorationTypes) {
    decorationType.dispose();
  }
  activeVisualization.selectedDecorationTypes = [];

  if (!activeVisualization.selectedCommitHash) {
    return;
  }

  const selectedRanges = activeVisualization.visualRanges.filter(
    (range) => range.commitHash === activeVisualization.selectedCommitHash
  );
  if (selectedRanges.length === 0) {
    return;
  }

  const palette = activeVisualization.paletteByCommit.get(activeVisualization.selectedCommitHash);
  if (!palette) {
    return;
  }

  const buckets = buildSelectedDecorationBuckets(editor, selectedRanges, palette);
  for (const { decorationType, options } of buckets.values()) {
    editor.setDecorations(decorationType, options);
    activeVisualization.selectedDecorationTypes.push(decorationType);
  }
}

function updateLegendSelectionForEditor(editor: vscode.TextEditor | undefined): void {
  if (!visualizationController.enabled || !editor) {
    return;
  }

  const activeVisualization = visualizationController.activeVisualization;
  if (!activeVisualization) {
    return;
  }

  if (activeVisualization.editorUri !== editor.document.uri.toString()) {
    return;
  }

  const selectedCommitHash = findCommitAtPosition(
    activeVisualization.visualRanges,
    editor.selection.active
  );

  if (activeVisualization.selectedCommitHash === selectedCommitHash) {
    return;
  }

  activeVisualization.selectedCommitHash = selectedCommitHash;
  updateSelectedCommitDecorations(activeVisualization, editor);
  updateLegendPanel(
    activeVisualization.filePath,
    activeVisualization.commitAgeEntries,
    activeVisualization.paletteByCommit,
    activeVisualization.kindByCommit,
    activeVisualization.selectedCommitHash
  );
}

function gitFailureUiMessage(kind: VisualizationGitFailureKind, fallback: string): string {
  switch (kind) {
    case "git_not_found":
      return `${EXTENSION_NAME} could not find Git. Install Git and make sure it is available in PATH.`;
    case "not_a_repo":
      return `${EXTENSION_NAME} requires the active file to be inside a git repository.`;
    case "unknown_git_error":
    default:
      return `${EXTENSION_NAME} encountered a git error while building the visualization: ${fallback}`;
  }
}

function reportVisualizationGitFailure(failure: VisualizationGitFailure): boolean {
  const output = getLogChannel();
  output.error(`${failure.msg}\n${failure.err}`);

  if (!visualizationController.shownFailureKinds.has(failure.kind)) {
    visualizationController.shownFailureKinds.add(failure.kind);
    void vscode.window.showErrorMessage(gitFailureUiMessage(failure.kind, failure.msg));
  }

  return failure.kind === "git_not_found";
}

const repoRootCache = new Map<string, string>();

async function resolveRepoRootForFile(
  filePath: string
): Promise<
  | { ok: true; repoRoot: string }
  | { ok: false; failure: VisualizationGitFailure }
> {
  const parentDir = path.dirname(filePath);
  const cached = repoRootCache.get(parentDir);
  if (cached) {
    return { ok: true, repoRoot: cached };
  }

  const gitVersion = await gitCmd(["--version"], parentDir);
  if (gitVersion.code !== 0) {
    return {
      ok: false,
      failure: classifyVisualizationGitFailure(gitVersion, "Failed to run git."),
    };
  }

  const repoCheck = await gitCmd(["rev-parse", "--show-toplevel"], parentDir);
  if (repoCheck.code !== 0) {
    return {
      ok: false,
      failure: classifyVisualizationGitFailure(
        repoCheck,
        "Failed to validate the active file's git repository."
      ),
    };
  }

  const repoRoot = repoCheck.out.trim();
  if (repoRoot.length > 0) {
    repoRootCache.set(parentDir, repoRoot);
    return { ok: true, repoRoot };
  }
  return {
    ok: false,
    failure: {
      kind: "not_a_repo",
      msg: "The active file is not inside a git repository.",
      err: "git rev-parse --show-toplevel returned an empty path.",
    },
  };
}

async function applyVisualizationToEditor(
  editor: vscode.TextEditor | undefined
): Promise<void> {
  const timestamp = Date.now();
  visualizationController.lastRunTimestamp = timestamp;
  const isStale = () => timestamp !== visualizationController.lastRunTimestamp;

  if (!visualizationController.enabled) {
    renderLegendEmpty("Edit history visualization is disabled.");
    return;
  }

  if (!editor || editor.document.uri.scheme !== "file") {
    renderLegendEmpty("Open a saved file in the active editor to view edit history ownership.");
    return;
  }

  if (editor.document.isDirty) {
    renderLegendEmpty("Save the active file to refresh edit history ownership.");
    return;
  }

  const filePath = editor.document.uri.fsPath;
  const repoRootResult = await resolveRepoRootForFile(filePath);
  if (isStale()) { return; }
  if (!repoRootResult.ok) {
    const shouldStop = reportVisualizationGitFailure(repoRootResult.failure);
    renderLegendEmpty(gitFailureUiMessage(repoRootResult.failure.kind, repoRootResult.failure.msg));
    if (shouldStop) { stopEditHistoryVisualization(); }
    return;
  }
  visualizationController.shownFailureKinds.clear();
  const repoRoot = repoRootResult.repoRoot;

  const relativeFilePath = path.relative(repoRoot, filePath);
  const ownership = await buildFileOwnershipRanges(
    repoRoot,
    relativeFilePath,
    editor.document.getText()
  );
  if (isStale()) { return; }
  if (!ownership.ok) {
    const shouldStop = reportVisualizationGitFailure(ownership.failure);
    renderLegendEmpty(gitFailureUiMessage(ownership.failure.kind, ownership.failure.msg));
    if (shouldStop) { stopEditHistoryVisualization(); }
    return;
  }

  if (ownership.ranges.length === 0) {
    renderLegendEmpty("No commit ownership information was found for the active file.");
    return;
  }

  const commitAgeEntries = buildCommitAgeEntriesFromRanges(ownership.ranges);
  const ageEntryByCommit = new Map(
    commitAgeEntries.map((entry) => [entry.commitHash, entry] as const)
  );

  const coloringMode = visualizationController.coloringMode;
  const isDark = isEditorDarkTheme();
  const seqPalette = findSequentialPalette(visualizationController.sequentialPaletteValue);
  const qualPalette = findQualitativePalette(visualizationController.qualitativePaletteValue);
  const paletteResult =
    coloringMode === "file"
      ? computeFilePalettes(commitAgeEntries, isDark, seqPalette)
      : coloringMode === "event"
      ? computeEventPalettes(commitAgeEntries, isDark, qualPalette)
      : await computeGlobalPalettes(repoRoot, commitAgeEntries, isDark, seqPalette);
  if (isStale()) { return; }

  if (!paletteResult.ok) {
    const shouldStop = reportVisualizationGitFailure(paletteResult.failure);
    renderLegendEmpty(gitFailureUiMessage(paletteResult.failure.kind, paletteResult.failure.msg));
    if (shouldStop) { stopEditHistoryVisualization(); }
    return;
  }

  const { paletteByCommit, kindByCommit } = paletteResult;
  const visualRanges = buildVisualOwnershipRanges(editor, ownership.ranges);
  const decorationsByCommit = buildDecorationBuckets(
    editor, visualRanges, paletteByCommit, ageEntryByCommit, isDark, seqPalette
  );

  if (!visualizationController.enabled || isStale()) {
    for (const commitBuckets of decorationsByCommit.values()) {
      for (const { decorationType } of commitBuckets.values()) {
        decorationType.dispose();
      }
    }
    return;
  }

  clearActiveVisualization();

  for (const commitBuckets of decorationsByCommit.values()) {
    for (const { decorationType, options } of commitBuckets.values()) {
      editor.setDecorations(decorationType, options);
    }
  }

  visualizationController.activeVisualization = {
    editorUri: editor.document.uri.toString(),
    filePath,
    decorationTypes: Array.from(decorationsByCommit.values()).flatMap(
      (commitBuckets) =>
        Array.from(commitBuckets.values()).map((entry) => entry.decorationType)
    ),
    selectedDecorationTypes: [],
    commitAgeEntries,
    paletteByCommit,
    kindByCommit,
    visualRanges,
    selectedCommitHash: findCommitAtPosition(visualRanges, editor.selection.active),
  };

  updateLegendPanel(
    filePath,
    commitAgeEntries,
    paletteByCommit,
    kindByCommit,
    visualizationController.activeVisualization.selectedCommitHash
  );
  updateSelectedCommitDecorations(
    visualizationController.activeVisualization,
    editor
  );
}

function registerVisualizationListeners(context: vscode.ExtensionContext): void {
  visualizationController.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        return;
      }
      void applyVisualizationToEditor(editor);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }
      if (activeEditor.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      void applyVisualizationToEditor(activeEditor);
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      void applyVisualizationToEditor(findVisualizationEditor());
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      updateLegendSelectionForEditor(event.textEditor);
    })
  );

  context.subscriptions.push(...visualizationController.subscriptions);
}

export async function startEditHistoryVisualization(
  context: vscode.ExtensionContext
): Promise<void> {
  visualizationController.extensionContext = context;
  visualizationController.shownFailureKinds.clear();

  if (visualizationController.enabled) {
    await applyVisualizationToEditor(vscode.window.activeTextEditor);
    vscode.window.showInformationMessage(
      "Edit history visualization is already active."
    );
    return;
  }

  visualizationController.enabled = true;
  registerVisualizationListeners(context);
  await applyVisualizationToEditor(vscode.window.activeTextEditor);
  const activeEditor = vscode.window.activeTextEditor;
  const hasActiveFile =
    !!activeEditor &&
    activeEditor.document.uri.scheme === "file" &&
    !activeEditor.document.isDirty;

  vscode.window.showInformationMessage(
    hasActiveFile
      ? `${EXTENSION_NAME} edit history visualization enabled.`
      : `${EXTENSION_NAME} edit history visualization enabled. Open or focus a saved file to show the legend and highlights.`
  );
}

export function isEditHistoryVisualizationEnabled(): boolean {
  return visualizationController.enabled;
}

export function stopEditHistoryVisualization(): void {
  if (!visualizationController.enabled) {
    vscode.window.showInformationMessage(
      "Edit history visualization is not active."
    );
    return;
  }

  visualizationController.enabled = false;
  visualizationController.shownFailureKinds.clear();
  clearActiveVisualization();
  disposeSubscriptions();
  visualizationController.legendPanel?.dispose();
  visualizationController.legendPanel = null;
  visualizationController.extensionContext = null;
  vscode.window.showInformationMessage(
    `${EXTENSION_NAME} edit history visualization disabled.`
  );
}

export function disposeEditHistoryVisualization(): void {
  visualizationController.enabled = false;
  visualizationController.shownFailureKinds.clear();
  clearActiveVisualization();
  disposeSubscriptions();
  visualizationController.legendPanel?.dispose();
  visualizationController.legendPanel = null;
  visualizationController.extensionContext = null;
}
