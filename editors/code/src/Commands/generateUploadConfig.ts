import { workspace as Workspace, window } from "vscode";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { URI } from "vscode-uri";
import { getConfigFilePath, getIgnoreFilePath } from "../uploadConfig";

const EXAMPLE_CONFIG = {
  servers: [
    {
      name: "My Server",
      host: "",
      port: 22,
      username: "",
      password: "",
      privateKey: "",
      passphrase: "",
      sftp: true,
      remoteRoot: "/tf/addons/sourcemod",
      rcon: {
        port: 27015,
        password: "",
        commands: ["sm plugins refresh"],
      },
    },
  ],
};

const DEFAULT_IGNORE_CONTENT = `# Directories
scripting/
.vscode/
.github/
.git/

# Files
.gitignore
*.md
`;

export function run(rootpath?: string): number {
  const workspaceFolders = Workspace.workspaceFolders;
  if (!workspaceFolders) {
    window.showErrorMessage("No workspaces are opened.");
    return 1;
  }

  if (!rootpath) {
    rootpath = workspaceFolders[0].uri.fsPath;
  }

  const workspaceFolder = Workspace.getWorkspaceFolder(URI.file(rootpath)) ?? workspaceFolders[0];
  const configPath = getConfigFilePath(workspaceFolder);
  const ignorePath = getIgnoreFilePath(workspaceFolder);

  // Create .vscode folder if it doesn't exist
  const vscodeDir = join(rootpath, ".vscode");
  if (!existsSync(vscodeDir)) {
    mkdirSync(vscodeDir);
  }

  // Check if config file already exists
  if (existsSync(configPath)) {
    window.showErrorMessage("sourcepawn-sftp.json already exists.");
    return 1;
  }

  try {
    // Write the config file
    writeFileSync(configPath, JSON.stringify(EXAMPLE_CONFIG, null, 2), "utf8");

    // Create .sourcepawnignore if it doesn't exist
    if (!existsSync(ignorePath)) {
      writeFileSync(ignorePath, DEFAULT_IGNORE_CONTENT, "utf8");
    }

    // Auto-add sourcepawn-sftp.json to .gitignore
    const gitignorePath = join(rootpath, ".gitignore");
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, "utf8");
      if (!gitignoreContent.includes("sourcepawn-sftp.json")) {
        const newline = gitignoreContent.endsWith("\n") ? "" : "\n";
        appendFileSync(gitignorePath, `${newline}sourcepawn-sftp.json\n`, "utf8");
      }
    }

    // Open the config file for editing
    Workspace.openTextDocument(URI.file(configPath)).then((doc) => {
      window.showTextDocument(doc);
    });

    window.showInformationMessage("Upload config created successfully!");
    return 0;
  } catch (error) {
    window.showErrorMessage(`Could not create upload config! ${error}`);
    return 1;
  }
}
