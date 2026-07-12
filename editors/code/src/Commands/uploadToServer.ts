import path from "path";
import { getMainCompilationFile, resolveCompiledPluginPath } from "../spUtils";
import { ProgressLocation, WorkspaceFolder, window, workspace as Workspace } from "vscode";
import { lastActiveEditor } from "../spIndex";
import { URI } from "vscode-uri";
import { Section, getConfig } from "../configUtils";
import sftp from 'ssh2-sftp-client'
import { Client } from 'basic-ftp'
import * as fs from 'fs';
import { ServerConfig, loadUploadServers, loadIgnorePatterns, getRemotePluginsDir } from "../uploadConfig";
import { pickServer } from "../serverPicker";
import { runRconForServer } from "../serverRcon";
import { readFileSync } from "fs";

/**
 * Resolve the source file used to locate the compiled `.smx` and to name the
 * plugin for RCON commands. Falls back to the last active editor.
 */
async function resolveSourceFile(
  workspaceFolder: WorkspaceFolder,
  pluginFile?: string
): Promise<string | undefined> {
  if (pluginFile) {
    return pluginFile;
  }
  try {
    const compileMainPath: boolean = getConfig(Section.SourcePawn, "MainPathCompilation", workspaceFolder);
    if (compileMainPath) {
      return await getMainCompilationFile();
    }
  } catch {
    // Fall through to the active editor below.
  }
  return lastActiveEditor?.document?.uri?.fsPath;
}

/**
 * Upload the workspace to a specific server using the given config.
 * File filtering uses `.sourcepawnignore` patterns.
 */
export async function uploadToServerWithConfig(
  workspaceFolder: WorkspaceFolder,
  serverConfig: ServerConfig,
  pluginFile?: string
): Promise<boolean> {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const filter = loadIgnorePatterns(workspaceFolder);
  let success = false;

  // When plugin-only upload is enabled, only the compiled `.smx` is sent to the
  // remote `plugins/` folder instead of mirroring the whole workspace.
  const pluginOnly: boolean = getConfig(Section.SourcePawn, "uploadPluginOnly", workspaceFolder);
  const sourceFile = await resolveSourceFile(workspaceFolder, pluginFile);
  let smxPath: string | undefined;
  if (pluginOnly) {
    smxPath = sourceFile ? resolveCompiledPluginPath(sourceFile, workspaceFolder) : undefined;
    if (!smxPath || !fs.existsSync(smxPath)) {
      window.showErrorMessage(
        "Plugin-only upload is enabled but no compiled .smx was found. Compile the plugin first."
      );
      return false;
    }
  }

  const remotePluginsDir = getRemotePluginsDir(serverConfig);

  await window.withProgress(
    {
      location: ProgressLocation.Notification,
      cancellable: true,
      title: `Uploading ${smxPath ? path.basename(smxPath) : "files"} to ${serverConfig.name}...`
    },
    async (progress, token) => {
      const client: sftp = new sftp();

      token.onCancellationRequested(() => {
        window.showErrorMessage('The upload operation was cancelled.');
      });

      try {
        if (serverConfig.sftp) {
          const connectOptions: Record<string, unknown> = {
            host: serverConfig.host,
            port: serverConfig.port,
            username: serverConfig.username,
          };
          if (serverConfig.privateKey) {
            connectOptions.privateKey = readFileSync(serverConfig.privateKey);
            if (serverConfig.passphrase) {
              connectOptions.passphrase = serverConfig.passphrase;
            }
          } else {
            connectOptions.password = serverConfig.password;
          }
          await client.connect(connectOptions);

          client.on('upload', (info) => {
            const fileName = path.basename(info.source);
            progress.report({ message: ` ${fileName}` });
          });

          if (smxPath) {
            const remoteName = path.basename(smxPath);
            const remotePath = path.posix.join(remotePluginsDir, remoteName);
            await client.mkdir(remotePluginsDir, true);
            progress.report({ message: ` ${remoteName}` });
            await client.fastPut(smxPath, remotePath);
          } else {
            await client.uploadDir(workspaceRoot, serverConfig.remoteRoot, { filter });
          }

          window.showInformationMessage(`Files uploaded successfully to ${serverConfig.name}!`);
          success = true;
        }
        else {
          const ftp = new Client();

          await ftp.access({
            host: serverConfig.host,
            port: serverConfig.port,
            user: serverConfig.username,
            password: serverConfig.password,
          });

          if (smxPath) {
            const remoteName = path.basename(smxPath);
            await ftp.ensureDir(remotePluginsDir);
            progress.report({ message: ` ${remoteName}` });
            await ftp.uploadFrom(smxPath, path.posix.join(remotePluginsDir, remoteName));
          } else {
            const uploadFiles = async (dirPath: string) => {
              const files = await fs.promises.readdir(dirPath);
              for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stat = await fs.promises.stat(filePath);

                if (stat.isDirectory()) {
                  if (filter(filePath)) {
                    await ftp.ensureDir(path.join(serverConfig.remoteRoot, path.relative(workspaceRoot, filePath)));
                    await uploadFiles(filePath);
                  }
                }
                else if (stat.isFile()) {
                  if (filter(filePath)) {
                    const remoteFilePath = path.join(serverConfig.remoteRoot, path.relative(workspaceRoot, filePath));
                    progress.report({ message: ` ${file}` });
                    await ftp.uploadFrom(filePath, remoteFilePath);
                  }
                }
              }
            };

            await uploadFiles(workspaceRoot);
          }

          window.showInformationMessage(`Files uploaded successfully to ${serverConfig.name}!`);
          ftp.close();

          success = true;
        }
      }
      catch (error) {
        if (!token.isCancellationRequested) {
          window.showErrorMessage('Failed to upload files! ' + error);
        }
        success = false;
      }
      finally {
        client.end();
      }
    }
  );

  // Reload the plugin on the server we just uploaded to (if it has RCON configured).
  if (success && serverConfig.rcon) {
    await runRconForServer(serverConfig, smxPath ?? sourceFile);
  }

  return success;
}

export async function run(args?: string): Promise<boolean> {
  let workspaceFolder: WorkspaceFolder;

  if (!args) {
    workspaceFolder = Workspace.getWorkspaceFolder(lastActiveEditor.document.uri);
  }
  else {
    workspaceFolder = Workspace.getWorkspaceFolder(URI.file(args));
  }

  const servers = loadUploadServers(workspaceFolder);
  if (!servers || servers.length === 0) {
    window.showErrorMessage(
      "No upload servers configured. Generate a config file or set UploadOptions in settings.",
      "Generate Config"
    ).then((choice) => {
      if (choice === "Generate Config") {
        import("./generateUploadConfig").then((m) => m.run());
      }
    });
    return false;
  }

  let server: ServerConfig | undefined;
  if (servers.length === 1) {
    server = servers[0];
  } else {
    server = await pickServer(servers);
  }

  if (!server) {
    return false;
  }

  return uploadToServerWithConfig(workspaceFolder, server);
}
