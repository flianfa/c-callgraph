/**
 * extension.ts — entry point. Wires the indexer, the relation view (bottom
 * panel), and the D3 force-directed graph webview.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Indexer } from './indexer';
import { GraphPanel } from './graphPanel';
import { RelationViewProvider } from './relationView';

let indexer: Indexer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const wasmDir = path.join(context.extensionPath, 'dist');
  indexer = new Indexer(wasmDir);

  // Jump-to-source helper.
  const openLocation = async (filePath: string, line?: number) => {
    if (!filePath) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot open ${filePath}: ${e}`);
    }
  };

  // Bottom-panel Source Insight-style relation view.
  const relationProvider = new RelationViewProvider(
    context.extensionUri,
    () => indexer?.getStore(),
    openLocation
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RelationViewProvider.viewId, relationProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Follow the editor cursor (debounced).
  let cursorTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const editor = e.textEditor;
      if (editor.document.languageId !== 'c') {
        return;
      }
      if (cursorTimer) {
        clearTimeout(cursorTimer);
      }
      cursorTimer = setTimeout(() => {
        const range = editor.document.getWordRangeAtPosition(
          editor.selection.active,
          /[A-Za-z_][A-Za-z0-9_]*/
        );
        const word = range ? editor.document.getText(range) : undefined;
        relationProvider.onCursor(word);
      }, 250);
    })
  );

  // Symbol under cursor helper.
  const symbolUnderCursor = (): string | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const range = editor.document.getWordRangeAtPosition(
      editor.selection.active,
      /[A-Za-z_][A-Za-z0-9_]*/
    );
    return range ? editor.document.getText(range) : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('cCallgraph.showGraph', () => {
      const sym = symbolUnderCursor();
      if (!sym) {
        vscode.window.showInformationMessage('Place the cursor on a function name.');
        return;
      }
      const st = indexer?.getStore();
      if (st && !st.functionExists(sym)) {
        vscode.window.showInformationMessage(`'${sym}' is not an indexed function.`);
        return;
      }
      const openByName = (name: string) => {
        const loc = st?.getFunctionLocation(name);
        if (loc) {
          openLocation(loc.file_path, loc.line);
        }
      };
      GraphPanel.createOrShow(context.extensionUri, () => indexer?.getStore(), openByName, sym);
    }),
    vscode.commands.registerCommand('cCallgraph.openLocation', (filePath: string, line: number) =>
      openLocation(filePath, line)
    ),
    vscode.commands.registerCommand('cCallgraph.reindex', async () => {
      await indexer?.indexWorkspace(true);
      vscode.window.showInformationMessage('C Call Graph: full reindex complete.');
    })
  );

  // Re-index on save.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => indexer?.onSave(doc))
  );

  indexer.activate().catch((e) => {
    vscode.window.showErrorMessage(`C Call Graph init failed: ${e}`);
    console.error(e);
  });
}

export function deactivate(): void {
  indexer?.dispose();
  indexer = undefined;
}
