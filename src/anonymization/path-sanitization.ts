import * as path from "path";
import { pathToFileURL } from "url";
import { CHAT_EXPORT_PATH, LOG_EXPORT_PATH } from "../utils/constants";

export type AbsolutePathHandling = "none" | "repoOnly" | "all";

const PATH_PLACEHOLDER = "<ABSOLUTE_PATH>";
const REPO_ROOT_PLACEHOLDER = "<REPO_ROOT>";
const FILE_URI_PLACEHOLDER = "file:///<ABSOLUTE_PATH>";
const REPO_ROOT_FILE_URI_PLACEHOLDER = "file:///<REPO_ROOT>";
const COPILOT_USER_PLACEHOLDER = "<COPILOT_USER>";
const GENERATED_LOG_PREFIXES = [LOG_EXPORT_PATH, CHAT_EXPORT_PATH] as const;

const ABSOLUTE_PATH_REGEX_PATTERNS = {
  quotedPosix: String.raw`(["'\`])(/[^"'\`\r\n]+)\1`,
  quotedWindows: String.raw`(["'\`])([A-Za-z]:[\\/][^"'\`\r\n]+)\1`,
  // `(?!/)` keeps URLs (`https://...`) and `//` comments from looking like paths.
  posix: String.raw`(^|[\s:="'` + "`" + String.raw`(\[{])(/(?!/)(?:[^\s:="'` + "`" + String.raw`<>]|\\ )+)`,
  windows: String.raw`(^|[\s:="'` + "`" + String.raw`(\[{<])([A-Za-z]:[\\/](?:[^\s:="'` + "`" + String.raw`<>]|\\ )+)`,
  fileUri: String.raw`file:///(?:[A-Za-z]:/|/)?[^\s"'<>]+`,
} as const;

const COPILOT_USER_REGEX_PATTERNS = {
  loggedInAs: String.raw`(\bLogged in as\s+)([^\s,;:]+)`,
  gotTokenFor: String.raw`(\bGot Copilot token for\s+)([^\s,;:]+)`,
  accountLabel: String.raw`("accountLabel"\s*:\s*")([^"]+)(")`,
} as const;

/** Formats a literal-match rule line for `git filter-repo --replace-text`. */
function replaceTextLine(search: string, replacement: string): string {
  return `${search}==>${replacement}`;
}

/** Formats a regex-match rule line for `git filter-repo --replace-text`. */
function regexReplaceTextLine(search: string, replacement: string): string {
  return `regex:${search}==>${replacement}`;
}

/**
 * Renders a string as a Python bytes-literal source expression. Python
 * bytes literals only allow ASCII, so everything else (including quotes and
 * backslashes) is written as `\xNN` escapes of its UTF-8 bytes.
 */
function pythonBytesLiteral(value: string): string {
  let literal = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    literal += byte >= 0x20 && byte < 0x7f && char !== "\"" && char !== "\\"
      ? char
      : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `b"${literal}"`;
}

/**
 * Builds `git filter-repo --replace-text` rule lines that replace every
 * textual form of the repository root path (absolute, POSIX/Windows
 * separators, escaped, and file URI variants) with a repo-root placeholder.
 */
function repoRootReplacementExpressions(repoRoot: string): string[] {
  const rootAbs = path.resolve(repoRoot);
  const rootPosix = rootAbs.replace(/\\/g, "/");
  const rootWin = rootPosix.replace(/\//g, "\\");
  const rootWinEscaped = rootWin.replace(/\\/g, "\\\\");
  const rootUri = pathToFileURL(rootAbs).toString();
  const rootUriDecoded = decodeURIComponent(rootUri);

  const pathPatterns = Array.from(
    new Set([rootAbs, rootPosix, rootWin, rootWinEscaped])
  ).filter(Boolean);
  const uriPatterns = Array.from(new Set([rootUri, rootUriDecoded])).filter(
    Boolean
  );

  return [
    ...pathPatterns.map((pattern) =>
      replaceTextLine(pattern, REPO_ROOT_PLACEHOLDER)
    ),
    ...uriPatterns.map((pattern) =>
      replaceTextLine(pattern, REPO_ROOT_FILE_URI_PLACEHOLDER)
    ),
  ];
}

/**
 * Same textual variants as {@link repoRootReplacementExpressions}, but as
 * plain (search, replacement) string pairs for the generated-log callback,
 * sorted longest-first so nested prefixes are replaced correctly.
 */
function repoRootReplacementPairs(repoRoot: string): Array<[string, string]> {
  const rootAbs = path.resolve(repoRoot);
  const rootPosix = rootAbs.replace(/\\/g, "/");
  const rootWin = rootPosix.replace(/\//g, "\\");
  const rootWinEscaped = rootWin.replace(/\\/g, "\\\\");
  const rootUri = pathToFileURL(rootAbs).toString();
  const rootUriDecoded = decodeURIComponent(rootUri);

  const pairs: Array<[string, string]> = [
    [rootAbs, REPO_ROOT_PLACEHOLDER],
    [rootPosix, REPO_ROOT_PLACEHOLDER],
    [rootWin, REPO_ROOT_PLACEHOLDER],
    [rootWinEscaped, REPO_ROOT_PLACEHOLDER],
    [rootUri, REPO_ROOT_FILE_URI_PLACEHOLDER],
    [rootUriDecoded, REPO_ROOT_FILE_URI_PLACEHOLDER],
  ];

  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Builds `git filter-repo --replace-text` rule lines that scrub every
 * absolute path and file URI found anywhere in file contents, regardless of
 * whether it falls under the repository root.
 */
function allAbsolutePathReplacementExpressions(): string[] {
  return [
    regexReplaceTextLine(
      ABSOLUTE_PATH_REGEX_PATTERNS.quotedPosix,
      String.raw`\1<ABSOLUTE_PATH>\1`
    ),
    regexReplaceTextLine(
      ABSOLUTE_PATH_REGEX_PATTERNS.quotedWindows,
      String.raw`\1<ABSOLUTE_PATH>\1`
    ),
    regexReplaceTextLine(
      ABSOLUTE_PATH_REGEX_PATTERNS.posix,
      String.raw`\1<ABSOLUTE_PATH>`
    ),
    regexReplaceTextLine(
      ABSOLUTE_PATH_REGEX_PATTERNS.windows,
      String.raw`\1<ABSOLUTE_PATH>`
    ),
    regexReplaceTextLine(
      ABSOLUTE_PATH_REGEX_PATTERNS.fileUri,
      FILE_URI_PLACEHOLDER
    ),
  ];
}

/**
 * Builds the `git filter-repo --replace-text` rule lines for the given
 * absolute-path handling mode: none, repo-root-only, or all absolute paths.
 */
export function absolutePathReplacementExpressions(
  repoRoot: string,
  handling: AbsolutePathHandling
): string[] {
  switch (handling) {
    case "none":
      return [];
    case "repoOnly":
      return repoRootReplacementExpressions(repoRoot);
    case "all":
      return allAbsolutePathReplacementExpressions();
    default:
      return [];
  }
}

/**
 * Generates the Python source body for a `git filter-repo
 * --file-info-callback` that sanitizes generated `.log`/`.chat-log` blobs
 * in-place (repo-root, absolute-path, and Copilot-username scrubbing) while
 * leaving all other files untouched.
 */
export function generatedLogSanitizationCallback(repoRoot: string): string {
  const repoRootPairs = repoRootReplacementPairs(repoRoot);
  const prefixes = GENERATED_LOG_PREFIXES.map((prefix) => pythonBytesLiteral(prefix)).join(", ");
  const quotedPosixPattern = pythonBytesLiteral(ABSOLUTE_PATH_REGEX_PATTERNS.quotedPosix);
  const quotedWindowsPattern = pythonBytesLiteral(ABSOLUTE_PATH_REGEX_PATTERNS.quotedWindows);
  const fileUriPattern = pythonBytesLiteral(ABSOLUTE_PATH_REGEX_PATTERNS.fileUri);
  const posixPattern = pythonBytesLiteral(ABSOLUTE_PATH_REGEX_PATTERNS.posix);
  const windowsPattern = pythonBytesLiteral(ABSOLUTE_PATH_REGEX_PATTERNS.windows);
  const quotedPathReplacement = pythonBytesLiteral(`\\1${PATH_PLACEHOLDER}\\1`);
  const fileUriReplacement = pythonBytesLiteral(FILE_URI_PLACEHOLDER);
  const pathReplacement = pythonBytesLiteral(`\\1${PATH_PLACEHOLDER}`);
  const loggedInAsPattern = pythonBytesLiteral(COPILOT_USER_REGEX_PATTERNS.loggedInAs);
  const gotTokenForPattern = pythonBytesLiteral(COPILOT_USER_REGEX_PATTERNS.gotTokenFor);
  const accountLabelPattern = pythonBytesLiteral(COPILOT_USER_REGEX_PATTERNS.accountLabel);
  const copilotUserReplacement = pythonBytesLiteral(`\\1${COPILOT_USER_PLACEHOLDER}`);
  const accountLabelReplacement = pythonBytesLiteral(`\\1${COPILOT_USER_PLACEHOLDER}\\3`);
  const repoRootReplaceLines = repoRootPairs.map(
    ([pattern, replacement]) =>
      `    data = data.replace(${pythonBytesLiteral(pattern)}, ${pythonBytesLiteral(replacement)})`
  ).join("\n");
  return `
import re

QUOTED_POSIX_RE = re.compile(${quotedPosixPattern})
QUOTED_WINDOWS_RE = re.compile(${quotedWindowsPattern})
FILE_URI_RE = re.compile(${fileUriPattern})
POSIX_RE = re.compile(${posixPattern})
WINDOWS_RE = re.compile(${windowsPattern})
GENERATED_LOG_PREFIXES = (${prefixes},)

def sanitize(data):
${repoRootReplaceLines}
    data = QUOTED_POSIX_RE.sub(${quotedPathReplacement}, data)
    data = QUOTED_WINDOWS_RE.sub(${quotedPathReplacement}, data)
    data = FILE_URI_RE.sub(${fileUriReplacement}, data)
    data = POSIX_RE.sub(${pathReplacement}, data)
    data = WINDOWS_RE.sub(${pathReplacement}, data)
    data = re.sub(
        ${loggedInAsPattern},
        ${copilotUserReplacement},
        data
    )
    data = re.sub(
        ${gotTokenForPattern},
        ${copilotUserReplacement},
        data
    )
    data = re.sub(
        ${accountLabelPattern},
        ${accountLabelReplacement},
        data
    )
    return data

if not filename.startswith(GENERATED_LOG_PREFIXES):
    return (filename, mode, blob_id)

contents = value.get_contents_by_identifier(blob_id)
sanitized = sanitize(contents)
if sanitized == contents:
    return (filename, mode, blob_id)

new_blob_id = value.insert_file_with_contents(sanitized)
return (filename, mode, new_blob_id)
`.trim();
}
