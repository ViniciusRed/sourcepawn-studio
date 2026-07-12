import { workspace as Workspace, window } from "vscode";
import { existsSync } from "fs";
import { URI } from "vscode-uri";

import { lastActiveEditor } from "../spIndex";
import { getConfigFilePath } from "../uploadConfig";
import { run as generateUploadConfig } from "./generateUploadConfig";

/**
 * Open the file-based upload config (`.vscode/sourcepawn-sftp.json`) in the editor,
 * generating it from a template first if it doesn't exist yet.
 */
export async function run(rootpath?: string): Promise<void> {
  const workspaceFolders = Workspace.workspaceFolders;
  if (!workspaceFolders) {
    window.showErrorMessage("No workspaces are opened.");
    return;
  }

  let workspaceFolder = rootpath
    ? Workspace.getWorkspaceFolder(URI.file(rootpath))
    : lastActiveEditor
      ? Workspace.getWorkspaceFolder(lastActiveEditor.document.uri)
      : undefined;
  workspaceFolder = workspaceFolder ?? workspaceFolders[0];

  const configPath = getConfigFilePath(workspaceFolder);

  // `generateUploadConfig` creates and opens the file when it's missing.
  if (!existsSync(configPath)) {
    generateUploadConfig(workspaceFolder.uri.fsPath);
    return;
  }

  const doc = await Workspace.openTextDocument(URI.file(configPath));
  await window.showTextDocument(doc);
}
