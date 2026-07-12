import {
  workspace as Workspace,
  window,
  OutputChannel,
} from "vscode";
import { URI } from "vscode-uri";
import { basename, join, dirname, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import { execFile } from "child_process";

import { uploadToServerWithConfig } from "./uploadToServer";
import { getCtxFromUri, lastActiveEditor } from "../spIndex";
import { getMainCompilationFile, isSPFile } from "../spUtils";
import { Section as Section, editConfig, getConfig } from "../configUtils";
import { loadUploadServers } from "../uploadConfig";
import { pickServer } from "../serverPicker";

// Create an OutputChannel variable here but do not initialize yet.
let output: OutputChannel;

/**
 * Callback for the Compile file command.
 * @param  {URI} args URI of the document to be compiled. This will be overrided if MainPathCompilation is set to true.
 * @returns Promise
 */
export async function run(args: URI): Promise<number> {
  let fileToCompilePath: string;

  // If we always compile the main path, we always ignore the path of the current editor
  const workspaceFolder = Workspace.getWorkspaceFolder(lastActiveEditor.document.uri);
  const compileMainPath: boolean = getConfig(Section.SourcePawn, "MainPathCompilation", workspaceFolder);
  if (compileMainPath) {
    fileToCompilePath = await getMainCompilationFile()
  }
  // Else, we take the arguments, or we take the last active editor's path
  else {
    if (args) {
      fileToCompilePath = args.fsPath;
    }
    else {
      fileToCompilePath = lastActiveEditor.document.uri.fsPath;
    }
  }

  // Don't compile if it's not a .sp file.
  if (!isSPFile(fileToCompilePath)) {
    window.showErrorMessage(`The compile target (\`${fileToCompilePath}\`) is not a SourcePawn file.`);
    return 1;
  }

  // Return if compiler not found
  const spcomp: string = getConfig(Section.LSP, "compiler.path", workspaceFolder);
  if (!spcomp) {
    window
      .showErrorMessage(
        "Sourcemod compiler not found in the project. You need to set the 'compiler.path' setting to be able to compile a plugin.",
        "Open Settings"
      )
      .then((choice) => {
        if (choice === "Open Settings") {
          editConfig(Section.LSP, "compiler.path")
        }
      });
    return 1;
  }

  // Decide where to output the compiled file.

  const scriptingFolderPath = dirname(fileToCompilePath);
  const useAlternativeOutputPath = getConfig(Section.SourcePawn, "useAlternativeOutputPath", workspaceFolder);

  let outputDir: string;

  if (!useAlternativeOutputPath) {

    const possiblePluginsPaths = [
      join(workspaceFolder.uri.fsPath, "plugins/"),
      join(workspaceFolder.uri.fsPath, "addons", "sourcemod", "plugins/"),
      join(scriptingFolderPath, "../", "plugins/")
    ];

    outputDir = possiblePluginsPaths.find(path => existsSync(path));

    if (!outputDir) {
      // If no plugins folder found, create one in the default location
      outputDir = join(workspaceFolder.uri.fsPath, "plugins/");
      mkdirSync(outputDir, { recursive: true });
    }
    outputDir += basename(fileToCompilePath, ".sp") + ".smx";
  } else {
    const pluginsFolderPath = join(scriptingFolderPath, "../", "plugins/");
    outputDir = getConfig(Section.SourcePawn, "outputDirectoryPath", workspaceFolder) || pluginsFolderPath;
    if (outputDir === pluginsFolderPath && !existsSync(outputDir)) {
      mkdirSync(outputDir);
    } else {
      // If the outputDirectoryPath setting is not empty, make sure it exists before trying to write to it.
      if (!existsSync(outputDir)) {
        const workspaceFolder = Workspace.workspaceFolders[0];
        outputDir = join(workspaceFolder.uri.fsPath, outputDir);
        if (!existsSync(outputDir)) {
          window.showErrorMessage(
            "The output directory does not exist.",
            "Open Settings"
          )
            .then((choice) => {
              if (choice === "Open Settings") {
                editConfig(Section.SourcePawn, "outputDirectoryPath");
              }
            });
          return 1;
        }
      }
    }
  }

  // Add the compiler options from the settings.
  const compilerArguments: string[] = getConfig(Section.LSP, "compiler.arguments", workspaceFolder);
  const includePaths: string[] = [
    join(scriptingFolderPath, "include"),
    scriptingFolderPath,
  ];

  const includeDirs: string[] = getConfig(Section.LSP, "includeDirectories", workspaceFolder);
  includeDirs.map((e) =>
    resolve(
      workspaceFolder === undefined ? "" : workspaceFolder.uri.fsPath,
      e
    )
  )
    .forEach((e) => includePaths.push(e));

  let compilerArgs = [fileToCompilePath, `-o${outputDir}`];

  // Add include paths and compiler options to compiler args.
  includePaths.forEach((path) => compilerArgs.push(`-i${path}`));
  compilerArgs = compilerArgs.concat(compilerArguments);

  // Create Output Channel if it does not exist.
  if (!output) {
    output = window.createOutputChannel("SourcePawn Compiler");
  }

  // Clear previous data in Output Channel and show it.
  output.clear();
  output.show();

  try {
    // Set spcomp status
    const ctx = getCtxFromUri(URI.file(fileToCompilePath));
    ctx?.setSpcompStatus({ quiescent: false });

    // Set up compiler command and args
    let spcompCommand = spcomp;
    if (process.platform === "darwin" && process.arch === "arm64") {
      spcompCommand = "arch";
      compilerArgs.unshift("-x86_64", spcomp);
    }
    let command = spcompCommand;
    compilerArgs.forEach((e) => {
      command += e + " ";
      if (e.length > 10) {
        command += "\n";
      }
    });
    output.appendLine(`${command}\n`);

    // Execute compilation wrapped in a Promise
    const compilationResult = await new Promise<number>((resolvePromise) => {
      execFile(spcompCommand, compilerArgs, async (error, stdout) => {
        ctx?.setSpcompStatus({ quiescent: true });
        output.appendLine(stdout.toString().trim() + '\n');

        window.showTextDocument(lastActiveEditor.document);

        if (error) {
          window.showErrorMessage("Compilation failed.");
          resolvePromise(1);
          return;
        }

        output.appendLine("Compilation successful.");
        resolvePromise(0);
      });
    });

    if (compilationResult !== 0) {
      return compilationResult;
    }

    // Upload after compile. The per-server RCON refresh (e.g. `sm plugins refresh`)
    // is handled inside `uploadToServerWithConfig` for the server that was uploaded to.
    const uploadFtp: boolean = getConfig(Section.SourcePawn, "uploadToServerAfterCompile", workspaceFolder);

    if (uploadFtp) {
      const servers = loadUploadServers(workspaceFolder);
      if (!servers || servers.length === 0) {
        window.showErrorMessage(
          "Upload after compile is enabled but no servers are configured.",
          "Generate Config"
        ).then((choice) => {
          if (choice === "Generate Config") {
            import("./generateUploadConfig").then((m) => m.run());
          }
        });
      } else {
        let server = servers.length === 1 ? servers[0] : await pickServer(servers);
        if (server) {
          await uploadToServerWithConfig(workspaceFolder, server, fileToCompilePath);
        }
      }
    }

    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}
