import { window } from "vscode";
import { ServerConfig } from "./uploadConfig";

/**
 * Show a QuickPick to let the user choose a server.
 * Returns the chosen `ServerConfig`, or `undefined` if cancelled.
 */
export async function pickServer(servers: ServerConfig[]): Promise<ServerConfig | undefined> {
  const items = servers.map((server) => ({
    label: server.name,
    description: `${server.sftp ? "SFTP" : "FTP"}${server.privateKey ? " (key)" : ""} - ${server.host}:${server.port}`,
    detail: server.remoteRoot,
    server,
  }));

  const picked = await window.showQuickPick(items, {
    placeHolder: "Select a server to upload to",
  });

  return picked?.server;
}
