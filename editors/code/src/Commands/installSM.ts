import { window, ProgressLocation, CancellationToken, Progress, QuickPickItem } from "vscode";
import { join } from "path";
import { platform, homedir } from "os";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "fs";
import axios from "axios";
import decompress from "decompress";
import { getConfig, Section } from "../configUtils";

const outputDir = join(homedir(), ".sourcemodAPI/");
const Platform = platform();

export async function run(args: any): Promise<void> {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir);
  }
  await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: "Sourcemod Download",
      cancellable: true,
    },
    async (progress, token) => {
      return getSourceModVersion(progress, token);
    }
  );
  const compilerPath: string = getConfig(Section.LSP, "compiler.path") || "";
  const smDir = join(outputDir, "addons/sourcemod/scripting/include");
  let spComp: string;
  if (Platform === "win32") {
    spComp = join(outputDir, "addons/sourcemod/scripting/spcomp.exe");
  } else {
    spComp = join(outputDir, "addons/sourcemod/scripting/spcomp");
  }
  if (compilerPath != "") {
    window
      .showInformationMessage("The setting for compiler.path is not empty, do you want to override it?", "Yes", "No")
      .then((choice) => {
        if (choice === "Yes") {
          updatePath(smDir, spComp);
        }
      });
    return;
  }
  updatePath(smDir, spComp);
  return;
}

function updatePath(smDir: string, spComp: string): void {
  const includeDirectories: string[] = getConfig(Section.LSP, "includeDirectories");
  includeDirectories.push(smDir);
  getConfig(Section.LSP).update(
    "includeDirectories",
    Array.from(new Set(includeDirectories)), // avoid duplicates
    true
  );
  getConfig(Section.LSP).update("compiler.path", spComp, true);
}

async function getSourceModVersion(
  progress: Progress<{ message?: string; increment?: number }>,
  token: CancellationToken
): Promise<void> {
  let oldStatus = 0;

  try {
    const versions = await buildQuickPickSMVersion();
    console.log("Available versions:", versions);

    const value = await window.showQuickPick(versions, {
      title: "Pick a version of Sourcemod to install",
      placeHolder: "Select SourceMod version",
      ignoreFocusOut: true,
    });

    if (!value) return;

    await downloadAndDecompressFile(
      await getSourcemodUrl(value.label),
      join(outputDir, "sm.gz"),
      (newStatus: number) => {
        if (newStatus === 100) {
          progress.report({ message: "Unzipping..." });
          return;
        }
        let inc = newStatus - oldStatus;
        oldStatus = newStatus;
        progress.report({
          message: "Downloading...",
          increment: inc,
        });
      }
    );
  } catch (error) {
    window.showErrorMessage(`Failed to fetch SourceMod versions: ${error}`);
  }
}
async function buildQuickPickSMVersion(): Promise<QuickPickItem[]> {
  const baseUrl = "https://sm.alliedmods.net/smdrop";
  const response = await axios.get(baseUrl);

  console.log("Raw response:", response.data);

  const versions =
    response.data
      .match(/href="\d+\.\d+/g)
      ?.map((v) => v.replace('href="', ""))
      ?.sort((a, b) => {
        const [majorA, minorA] = a.split(".").map(Number);
        const [majorB, minorB] = b.split(".").map(Number);
        return majorB !== majorA ? majorB - majorA : minorB - minorA;
      }) || [];

  console.log("Found versions:", versions);

  const devVersion = versions[0];
  const stableVersion = versions[1];

  console.log("Dev version:", devVersion);
  console.log("Stable version:", stableVersion);

  const items = versions.map((version) => ({
    label: version,
    description: version === devVersion ? "Dev" : version === stableVersion ? "Stable" : "Legacy",
    picked: version === stableVersion,
  }));

  console.log("Final QuickPick items:", items);

  return items;
}

async function getSourcemodUrl(smVersion: string) {
  let url = `https://sm.alliedmods.net/smdrop/${smVersion}/sourcemod-latest-`;
  switch (platform()) {
    case "win32":
      url += "windows";
      break;
    case "darwin":
      url += "mac";
      break;
    default:
      url += "linux";
      break;
  }
  const res = await axios.get(url);
  return `https://sm.alliedmods.net/smdrop/${smVersion}/${res.data}`;
}

async function downloadAndDecompressFile(
  url: string,
  outputFilePath: string,
  progressCallback: (progress: number) => void
) {
  try {
    const { data, headers } = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });

    return new Promise<void>((resolve, reject) => {
      const writer = createWriteStream(outputFilePath);

      if (progressCallback) {
        // Get the content length from the response headers for progress reporting
        const totalBytes = parseInt(headers["content-length"], 10);
        let downloadedBytes = 0;

        // Register the download progress event
        data.on("data", (chunk) => {
          downloadedBytes += chunk.length;
          const progress = (downloadedBytes / totalBytes) * 100;
          progressCallback(progress);
        });
      }
      data.pipe(writer);

      writer.on("finish", () => {
        if (progressCallback) {
          // Ensure the progress reaches 100% after download completion
          progressCallback(100.0);
          console.log("File downloaded.");
        }
        decompress(outputFilePath, outputDir).then(() => {
          console.log("File decompressed.");
          rmSync(outputFilePath, { force: true, recursive: true });
          console.log("Temporary files deleted.");
          resolve();
        });
      });
    });
  } catch (error) {
    window.showErrorMessage("Failed to download and decompress the SourceMod package! " + error);
  }
}
