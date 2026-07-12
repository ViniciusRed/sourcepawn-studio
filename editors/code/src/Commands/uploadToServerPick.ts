import { workspace as Workspace, window } from "vscode";

import { uploadToServerWithConfig } from "./uploadToServer";
import { lastActiveEditor } from "../spIndex";
import { loadUploadServers } from "../uploadConfig";
import { pickServer } from "../serverPicker";

/**
 * Pick a server and upload (no compilation).
 */
export async function run(): Promise<boolean> {
  const workspaceFolder = Workspace.getWorkspaceFolder(lastActiveEditor.document.uri);
  const servers = loadUploadServers(workspaceFolder);
  if (!servers || servers.length === 0) {
    window.showErrorMessage(
      "No upload servers configured.",
      "Generate Config"
    ).then((choice) => {
      if (choice === "Generate Config") {
        import("./generateUploadConfig").then((m) => m.run());
      }
    });
    return false;
  }

  let server = servers.length === 1 ? servers[0] : await pickServer(servers);
  if (!server) {
    return false;
  }

  return uploadToServerWithConfig(workspaceFolder, server);
}
