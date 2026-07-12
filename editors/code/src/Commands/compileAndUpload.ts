import { workspace as Workspace, window } from "vscode";
import { URI } from "vscode-uri";

import { run as compileSM } from "./compileSM";
import { uploadToServerWithConfig } from "./uploadToServer";
import { lastActiveEditor } from "../spIndex";
import { loadUploadServers } from "../uploadConfig";
import { pickServer } from "../serverPicker";

/**
 * Compile the current file, then pick a server and upload.
 */
export async function run(args: URI): Promise<number> {
  const result = await compileSM(args);
  if (result !== 0) {
    return result;
  }

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
    return 1;
  }

  let server = servers.length === 1 ? servers[0] : await pickServer(servers);
  if (!server) {
    return 1;
  }

  const success = await uploadToServerWithConfig(workspaceFolder, server);
  return success ? 0 : 1;
}
