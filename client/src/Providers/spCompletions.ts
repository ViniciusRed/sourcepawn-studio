import * as vscode from "vscode";
import {basename, join} from "path";
import { existsSync } from "fs";
import { URI } from "vscode-uri";
import { Completion, Include } from "./spCompletionsKinds";

export class FileCompletions {
  completions: Map<string, Completion>;
  includes: Include[];
  uri: string;

  constructor(uri: string) {
    this.completions = new Map();
    this.includes = [];
    this.uri = uri;
  }

  add(id: string, completion: Completion) {
    this.completions.set(id, completion);
  }

  get(id: string): Completion {
    return this.completions.get(id);
  }

  get_completions(repo: CompletionRepository): Completion[] {
    let completions = [];
    for (let completion of this.completions.values()) {
      completions.push(completion);
    }
    return completions;
  }

  to_completion_resolve(item: vscode.CompletionItem): vscode.CompletionItem {
    item.label = item.label;
    item.documentation = item.documentation;
    return item;
  }

  add_include(include: string, IsBuiltIn: boolean) {
    this.includes.push(new Include(include, IsBuiltIn));
  }

  resolve_import(
    file: string,
    documents: Map<string, URI>,
    IsBuiltIn: boolean = false
  ) {
    let inc_file: string;
    // If no extension is provided, it's a .inc file
    if (!/.sp\s*$/g.test(file) && !/.inc\s*$/g.test(file)) {
      file += ".inc";
    }

    let match = file.match(/include\/(.*)/);
    if (match) file = match[1];
    let uri: URI;
    if (!(uri = documents.get(basename(file)))) {
      let includes_dirs: string[] = vscode.workspace
        .getConfiguration("sourcepawn")
        .get("optionalIncludeDirsPaths");
      for (let includes_dir of includes_dirs) {
        inc_file = join(includes_dir, file);
        if (existsSync(inc_file)) {
          this.add_include(URI.file(inc_file).toString(), IsBuiltIn);
          return;
        }
      }
      this.add_include("file://__sourcemod_builtin/" + file, IsBuiltIn);
    } else {
      this.add_include(uri.toString(), IsBuiltIn);
    }
  }
}

export class CompletionRepository
  implements vscode.CompletionItemProvider, vscode.Disposable {
  public completions: Map<string, FileCompletions>;
  public documents: Map<string, vscode.Uri>;
  private globalState: vscode.Memento;

  constructor(globalState?: vscode.Memento) {
    this.completions = new Map();
    this.documents = new Map();
    this.globalState = globalState;
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.CompletionList {
    let completions: vscode.CompletionList = this.get_completions(
      document,
      position
    );
    return completions;
  }

  public dispose() {}

  get_completions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionList {
    let is_method = false;
    if (document) {
      let line = document.getText().split("\n")[position.line].trim();
      for (let i = line.length - 2; i >= 0; i--) {
        if (line[i].match(/[a-zA-Z0-9_]/)) {
          continue;
        }

        if (line[i] === ".") {
          is_method = true;
          break;
        }
        break;
      }
    }
    let all_completions: Completion[] = this.get_all_completions(
      document.uri.toString()
    );
    let all_completions_list: vscode.CompletionList = new vscode.CompletionList();
    if (all_completions != []) {
      all_completions_list.items = all_completions.map((completion) => {
        if (completion) {
          if (completion.to_completion_item) {
            return completion.to_completion_item(document.uri.fsPath);
          }
        }
      });
    }
    //return all_completions_list;
    if (is_method) {
      all_completions_list.items = all_completions_list.items.filter(
        (completion) =>
          completion.kind === vscode.CompletionItemKind.Method ||
          completion.kind === vscode.CompletionItemKind.Property
      );
      return all_completions_list;
    } else {
      all_completions_list.items = all_completions_list.items.filter(
        (completion) =>
          !(
            completion.kind === vscode.CompletionItemKind.Method ||
            completion.kind === vscode.CompletionItemKind.Property
          )
      );
      return all_completions_list;
    }
  }

  get_all_completions(file: string): Completion[] {
    let completion = this.completions.get(file);
    let includes = new Set<string>();
    if (completion) {
      this.get_included_files(completion, includes);
    }
    includes.add(file);
    let MainPath: string =
      vscode.workspace.getConfiguration("sourcepawn").get("MainPath") || "";
    if (MainPath != "") {
      if (!existsSync(MainPath)) {
        let workspace: vscode.WorkspaceFolder =
          vscode.workspace.workspaceFolders[0];
        MainPath = join(workspace.uri.fsPath, MainPath);
        if (!existsSync(MainPath)) {
          throw "MainPath is incorrect.";
        }
      }
			let MainCompletion = this.completions.get(URI.file(MainPath).toString());
			if(MainCompletion) {
				this.get_included_files(MainCompletion, includes);
			}
      let uri = URI.file(MainPath).toString();
      if (!includes.has(uri)) {
        includes.add(uri);
      }
    }
    return [...includes]
      .map((file) => {
        return this.get_file_completions(file);
      })
      .reduce(
        (completion, file_completions) => completion.concat(file_completions),
        []
      );
  }

  get_file_completions(file: string): Completion[] {
    let file_completions: FileCompletions = this.completions.get(file);
    let completion_list: Completion[] = [];
    if (file_completions) {
      return file_completions.get_completions(this);
    }
    return completion_list;
  }

  get_included_files(completions: FileCompletions, files: Set<string>) {
    for (let include of completions.includes) {
      if (!files.has(include.uri)) {
        files.add(include.uri);
        let include_completions = this.completions.get(include.uri);
        if (include_completions) {
          this.get_included_files(include_completions, files);
        }
      }
    }
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.Hover {
    let range = document.getWordRangeAtPosition(position);
    let word = document.getText(range);
    let completions = this.get_all_completions(document.uri.toString()).filter(
      (completion) => {
        return completion.name === word;
      }
    );

    if (completions.length > 0) {
      return completions[0].get_hover();
    }
  }

  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.SignatureHelp {
    if (document) {
      let { method, parameter_count } = (() => {
        let line = document.getText().split("\n")[position.line];

        if (line[position.character - 1] === ")") {
          // We've finished this call
          return { method: undefined, parameter_count: 0 };
        }

        let method = "";
        let end_parameters = false;
        let parameter_count = 0;

        for (let i = position.character; i >= 0; i--) {
          if (end_parameters) {
            if (line[i].match(/[A-Za-z0-9_]/)) {
              method = line[i] + method;
            } else {
              break;
            }
          } else {
            if (line[i] === "(") {
              end_parameters = true;
            } else if (line[i] === ",") {
              parameter_count++;
            }
          }
        }

        return { method, parameter_count };
      })();

      let completions = this.get_all_completions(
        document.uri.toString()
      ).filter((completion) => {
        return completion.name === method;
      });

      if (completions.length > 0) {
        return {
          signatures: [completions[0].get_signature()],
          activeParameter: parameter_count,
          activeSignature: 0,
        };
      }
    }

    return {
      signatures: [],
      activeSignature: 0,
      activeParameter: 0,
    };
  }
}