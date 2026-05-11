import * as path from "path";
import { pathToFileURL } from "url";
import { CHAT_EXPORT_PATH, LOG_EXPORT_PATH } from "../utils/paths";

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
  posix: String.raw`(^|[\s:="'` + "`" + String.raw`(\[{<])(/(?:[^\s:="'` + "`" + String.raw`<>]|\\ )+)`,
  windows: String.raw`(^|[\s:="'` + "`" + String.raw`(\[{<])([A-Za-z]:[\\/](?:[^\s:="'` + "`" + String.raw`<>]|\\ )+)`,
  fileUri: String.raw`file:///(?:[A-Za-z]:/|/)?[^\s"'<>]+`,
} as const;

const COPILOT_USER_REGEX_PATTERNS = {
  loggedInAs: String.raw`(\bLogged in as\s+)([^\s,;:]+)`,
  gotTokenFor: String.raw`(\bGot Copilot token for\s+)([^\s,;:]+)`,
  accountLabel: String.raw`("accountLabel"\s*:\s*")([^"]+)(")`,
} as const;

function replaceTextLine(search: string, replacement: string): string {
  return `${search}==>${replacement}`;
}

function regexReplaceTextLine(search: string, replacement: string): string {
  return `regex:${search}==>${replacement}`;
}

function pythonBytesLiteral(value: string): string {
  return `b${JSON.stringify(value)}`;
}

function isPathBoundary(char: string | undefined): boolean {
  return (
    char === undefined ||
    /\s/.test(char) ||
    [":", "=", "`", `"`, "'", "(", ")", "[", "]", "{", "}", "<", ">", ","].includes(char)
  );
}

function trimTrailingPunctuation(value: string): { core: string; trailing: string } {
  const match = value.match(/^(.*?)([.,;:!?)}\]]*)$/);
  if (!match) {
    return { core: value, trailing: "" };
  }
  return { core: match[1], trailing: match[2] };
}

function replaceFileUris(text: string): string {
  return text.replace(
    new RegExp(ABSOLUTE_PATH_REGEX_PATTERNS.fileUri, "g"),
    FILE_URI_PLACEHOLDER
  );
}

function replaceQuotedAbsolutePaths(text: string): string {
  return text
    .replace(
      new RegExp(ABSOLUTE_PATH_REGEX_PATTERNS.quotedPosix, "g"),
      `$1${PATH_PLACEHOLDER}$1`
    )
    .replace(
      new RegExp(ABSOLUTE_PATH_REGEX_PATTERNS.quotedWindows, "g"),
      `$1${PATH_PLACEHOLDER}$1`
    );
}

function replaceWindowsAbsolutePaths(text: string): string {
  return text.replace(
    new RegExp(ABSOLUTE_PATH_REGEX_PATTERNS.windows, "g"),
    (match, prefix: string, candidate: string) => {
      const { core, trailing } = trimTrailingPunctuation(candidate);
      if (!core) {
        return match;
      }
      return `${prefix}${PATH_PLACEHOLDER}${trailing}`;
    }
  );
}

function replacePosixAbsolutePaths(text: string): string {
  let out = "";

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const prev = i > 0 ? text[i - 1] : undefined;
    if (char !== "/" || !isPathBoundary(prev)) {
      out += char;
      continue;
    }

    let j = i;
    while (j < text.length) {
      const current = text[j];
      if (
        /\s/.test(current) ||
        current === `"` ||
        current === "'" ||
        current === "<" ||
        current === ">"
      ) {
        break;
      }
      j += 1;
    }

    const candidate = text.slice(i, j);
    const { core, trailing } = trimTrailingPunctuation(candidate);
    if (core.length <= 1) {
      out += char;
      continue;
    }

    out += `${PATH_PLACEHOLDER}${trailing}`;
    i = j - 1;
  }

  return out;
}

function replaceCopilotUserIdentifiers(text: string): string {
  return text
    .replace(
      new RegExp(COPILOT_USER_REGEX_PATTERNS.loggedInAs, "g"),
      `$1${COPILOT_USER_PLACEHOLDER}`
    )
    .replace(
      new RegExp(COPILOT_USER_REGEX_PATTERNS.gotTokenFor, "g"),
      `$1${COPILOT_USER_PLACEHOLDER}`
    )
    .replace(
      new RegExp(COPILOT_USER_REGEX_PATTERNS.accountLabel, "g"),
      `$1${COPILOT_USER_PLACEHOLDER}$3`
    );
}

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

function replaceRepoRootPrefixes(text: string, repoRoot: string): string {
  let result = text;
  for (const [pattern, replacement] of repoRootReplacementPairs(repoRoot)) {
    result = result.split(pattern).join(replacement);
  }
  return result;
}

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

export function sanitizeAbsolutePaths(text: string): string {
  return replacePosixAbsolutePaths(
    replaceWindowsAbsolutePaths(replaceQuotedAbsolutePaths(replaceFileUris(text)))
  );
}

export function sanitizeGeneratedLogContent(text: string, repoRoot: string): string {
  return replaceCopilotUserIdentifiers(
    sanitizeAbsolutePaths(replaceRepoRootPrefixes(text, repoRoot))
  );
}

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
