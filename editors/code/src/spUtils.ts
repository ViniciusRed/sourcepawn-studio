import * as vscode from "vscode";
import path from "path";
import { existsSync } from "fs";
import { getCtxFromUri, lastActiveEditor } from "./spIndex";
import { ProjectMainPathParams, projectMainPath } from "./lsp_ext";
import { URI } from "vscode-uri";
import { Section, getConfig } from "./configUtils";

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSPFile(filePath: string): boolean {
  return /\.(sp|inc)$/.test(filePath);
}

export function getPluginName(filePath: string): string {
  const fileName = path.basename(filePath);
  const pluginName = fileName.split('.')[0];
  return pluginName;
}

/**
 * Resolve the path of the compiled `.smx` for a given source file, mirroring the
 * output-directory resolution used by the Compile command. Read-only: it does not
 * create directories. Returns `undefined` if a plausible output directory can't be
 * determined.
 */
export function resolveCompiledPluginPath(
  fileToCompilePath: string,
  workspaceFolder: vscode.WorkspaceFolder
): string | undefined {
  const scriptingFolderPath = path.dirname(fileToCompilePath);
  const pluginFileName = path.basename(fileToCompilePath, ".sp") + ".smx";
  const useAlternativeOutputPath = getConfig(
    Section.SourcePawn,
    "useAlternativeOutputPath",
    workspaceFolder
  );

  if (!useAlternativeOutputPath) {
    const possiblePluginsPaths = [
      path.join(workspaceFolder.uri.fsPath, "plugins/"),
      path.join(workspaceFolder.uri.fsPath, "addons", "sourcemod", "plugins/"),
      path.join(scriptingFolderPath, "../", "plugins/"),
    ];
    const outputDir =
      possiblePluginsPaths.find((p) => existsSync(p)) ??
      path.join(workspaceFolder.uri.fsPath, "plugins/");
    return path.join(outputDir, pluginFileName);
  }

  const pluginsFolderPath = path.join(scriptingFolderPath, "../", "plugins/");
  let outputDir: string =
    getConfig(Section.SourcePawn, "outputDirectoryPath", workspaceFolder) || pluginsFolderPath;
  if (!existsSync(outputDir)) {
    // `outputDirectoryPath` may be relative to the workspace root.
    const candidate = path.join(workspaceFolder.uri.fsPath, outputDir);
    if (existsSync(candidate)) {
      outputDir = candidate;
    }
  }
  return path.join(outputDir, pluginFileName);
}

export async function getMainCompilationFile(): Promise<string> {
  const uri = lastActiveEditor.document.uri;
  const params: ProjectMainPathParams = {
    uri: uri.toString(),
  };
  const mainUri = await getCtxFromUri(uri)?.client.sendRequest(
    projectMainPath,
    params
  );
  return URI.parse(mainUri).fsPath;
}

export class LazyOutputChannel implements vscode.OutputChannel {
  constructor(name: string) {
    this.name = name;
  }

  name: string;
  _channel: vscode.OutputChannel | undefined;

  get channel(): vscode.OutputChannel {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel(this.name);
    }
    return this._channel;
  }

  append(value: string): void {
    this.channel.append(value);
  }
  appendLine(value: string): void {
    this.channel.appendLine(value);
  }
  replace(value: string): void {
    this.channel.replace(value);
  }
  clear(): void {
    if (this._channel) {
      this._channel.clear();
    }
  }
  show(preserveFocus?: boolean): void;
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(column?: any, preserveFocus?: any): void {
    this.channel.show(column, preserveFocus);
  }
  hide(): void {
    if (this._channel) {
      this._channel.hide();
    }
  }
  dispose(): void {
    if (this._channel) {
      this._channel.dispose();
    }
  }
}
