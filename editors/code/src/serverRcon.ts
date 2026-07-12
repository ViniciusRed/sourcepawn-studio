import { window } from "vscode";
import Rcon from "rcon-srcds";
import { EncodingOptions } from "rcon-srcds/dist/packet";
import { ServerConfig } from "./uploadConfig";
import { getPluginName } from "./spUtils";

const DEFAULT_COMMANDS = ["sm plugins refresh"];

/**
 * Run the per-server RCON commands (e.g. `sm plugins refresh`) after a successful
 * upload, so the updated plugin is reloaded on the server it was uploaded to.
 *
 * No-op when the server has no `rcon` block configured. Failures are surfaced as a
 * warning and never bubble up, so a flaky RCON connection doesn't fail the upload.
 */
export async function runRconForServer(
  serverConfig: ServerConfig,
  pluginFilePath?: string
): Promise<void> {
  const rcon = serverConfig.rcon;
  if (!rcon || !rcon.port || !rcon.password) {
    return;
  }

  const host = rcon.host || serverConfig.host;
  const commands =
    rcon.commands && rcon.commands.length > 0 ? rcon.commands : DEFAULT_COMMANDS;

  const server = new Rcon({
    host,
    port: rcon.port,
    encoding: (rcon.encoding as EncodingOptions) ?? "ascii",
    timeout: rcon.timeout ?? 1000,
  });

  try {
    await server.authenticate(rcon.password);

    for (let command of commands) {
      if (pluginFilePath) {
        command = command.replace("${plugin}", getPluginName(pluginFilePath));
      }
      await server.execute(command);
    }

    window.showInformationMessage(`Reloaded plugins on ${serverConfig.name}.`);
  } catch (error) {
    window.showWarningMessage(
      `Upload succeeded, but the RCON refresh on ${serverConfig.name} failed: ${error}`
    );
  } finally {
    try {
      await server.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
}
