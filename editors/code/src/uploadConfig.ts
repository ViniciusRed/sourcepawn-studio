import path from "path";
import { WorkspaceFolder } from "vscode";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import { Section, getConfig } from "./configUtils";

export interface RconConfig {
  /** RCON host. Defaults to the server's `host` if omitted. */
  host?: string;
  port: number;
  password: string;
  /** Packet encoding. Defaults to "ascii". */
  encoding?: string;
  /** Connection timeout in ms. Defaults to 1000. */
  timeout?: number;
  /** Commands to run after a successful upload. Supports `${plugin}`. Defaults to `["sm plugins refresh"]`. */
  commands?: string[];
}

export interface ServerConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sftp: boolean;
  remoteRoot: string;
  /**
   * Optional override for where plugin-only uploads place the compiled `.smx`.
   * Absolute (starts with `/`) is used as-is; otherwise it's resolved relative to
   * `remoteRoot`. When omitted, the SourceMod `addons/sourcemod/plugins` layout is
   * derived from `remoteRoot` automatically.
   */
  remotePluginsPath?: string;
  /** Optional RCON details to reload plugins after a successful upload. */
  rcon?: RconConfig;
}

/**
 * Resolve the remote directory that plugin-only uploads should write the compiled
 * `.smx` into. Honors `remotePluginsPath` when set; otherwise derives the standard
 * SourceMod `addons/sourcemod/plugins` location, supporting both `remoteRoot`
 * conventions (the mod dir, e.g. `/cstrike`, or the sourcemod dir, e.g.
 * `/cstrike/addons/sourcemod`).
 */
export function getRemotePluginsDir(serverConfig: ServerConfig): string {
  if (serverConfig.remotePluginsPath) {
    const custom = serverConfig.remotePluginsPath;
    return custom.startsWith("/")
      ? custom
      : path.posix.join(serverConfig.remoteRoot, custom);
  }

  const root = serverConfig.remoteRoot.replace(/[/\\]+$/, "");
  if (/addons[/\\]sourcemod$/i.test(root)) {
    // remoteRoot already points at the sourcemod dir.
    return path.posix.join(root, "plugins");
  }
  // remoteRoot points at the mod dir (e.g. cstrike/tf).
  return path.posix.join(root, "addons", "sourcemod", "plugins");
}

interface UploadConfigFile {
  servers: ServerConfig[];
}

const CONFIG_FILENAME = "sourcepawn-sftp.json";
const IGNORE_FILENAME = ".sourcepawnignore";

const DEFAULT_IGNORE_PATTERNS = [
  "scripting/",
  ".vscode/",
  ".github/",
  ".git/",
  ".gitignore",
  "*.md",
];

const DEFAULT_IGNORE_CONTENT = `# Directories
scripting/
.vscode/
.github/
.git/

# Files
.gitignore
*.md
`;

export function getConfigFilePath(workspaceFolder: WorkspaceFolder): string {
  return path.join(workspaceFolder.uri.fsPath, ".vscode", CONFIG_FILENAME);
}

export function getIgnoreFilePath(workspaceFolder: WorkspaceFolder): string {
  return path.join(workspaceFolder.uri.fsPath, IGNORE_FILENAME);
}

/**
 * Load upload servers from `.vscode/sourcepawn-sftp.json`, falling back to
 * the legacy `sourcepawn.UploadOptions` VS Code setting.
 * Returns `null` if no configuration is available.
 */
export function loadUploadServers(workspaceFolder: WorkspaceFolder): ServerConfig[] | null {
  const configPath = getConfigFilePath(workspaceFolder);

  // Try the new config file first
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const config: UploadConfigFile = JSON.parse(raw);
      if (config.servers && config.servers.length > 0) {
        return config.servers;
      }
    } catch {
      // Fall through to legacy
    }
  }

  // Fall back to legacy UploadOptions
  const legacy = getConfig(Section.SourcePawn, "UploadOptions", workspaceFolder);
  if (legacy && legacy.host) {
    const server: ServerConfig = {
      name: "Default Server",
      host: legacy.host,
      port: legacy.port ?? 21,
      username: legacy.username ?? "",
      password: legacy.password ?? "",
      sftp: legacy.sftp ?? false,
      remoteRoot: legacy.remoteRoot ?? "/",
    };
    return [server];
  }

  return null;
}

/**
 * Load ignore patterns from `.sourcepawnignore` and return a filter function.
 * If the file doesn't exist, uses built-in defaults.
 * The filter returns `true` for paths that should be **included** (not ignored).
 */
export function loadIgnorePatterns(workspaceFolder: WorkspaceFolder): (itemPath: string) => boolean {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const ignorePath = getIgnoreFilePath(workspaceFolder);

  let patterns: string[];

  if (existsSync(ignorePath)) {
    const raw = readFileSync(ignorePath, "utf8");
    patterns = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } else {
    // Create .sourcepawnignore with defaults so the user can edit it
    writeFileSync(ignorePath, DEFAULT_IGNORE_CONTENT, "utf8");
    patterns = DEFAULT_IGNORE_PATTERNS;
  }

  return (itemPath: string): boolean => {
    const relativePath = path.relative(workspaceRoot, itemPath);
    for (const pattern of patterns) {
      const globPattern = pattern.endsWith("/") ? `${pattern}**` : pattern;
      const matches = glob.sync(globPattern, { cwd: workspaceRoot, dot: true });
      if (matches.includes(relativePath)) {
        return false;
      }
    }
    return true;
  };
}
