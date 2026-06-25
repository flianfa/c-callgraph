/**
 * indexer.ts — orchestrates full and incremental indexing.
 *
 * On activation: open .vscode/cbm.db, discover all .c/.h files, and index
 * those whose (mtime,size) differ from the stored hash. On file save: re-index
 * just that file. Progress is surfaced via a status-bar item.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { initParser, parseSource } from './parser';

const C_EXTS = new Set(['.c', '.h']);

export class Indexer {
  private store: Store | undefined;
  private statusBar: vscode.StatusBarItem;
  private wasmDir: string;
  private dbPath: string | undefined;
  private workspaceRoot: string | undefined;

  constructor(wasmDir: string) {
    this.wasmDir = wasmDir;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.text = '$(database) C Graph: idle';
  }

  getStore(): Store | undefined {
    return this.store;
  }

  dispose(): void {
    this.statusBar.dispose();
    this.store?.close();
  }

  /** Initialise parser + store and run the startup index pass. */
  async activate(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }
    this.workspaceRoot = folders[0].uri.fsPath;
    const vscodeDir = path.join(this.workspaceRoot, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    this.dbPath = path.join(vscodeDir, 'cbm.db');

    await initParser(this.wasmDir);
    this.store = await Store.open(this.wasmDir, this.dbPath);

    this.statusBar.show();
    await this.indexWorkspace();
  }

  /** Discover and (incrementally) index all C files in the workspace. */
  async indexWorkspace(force = false): Promise<void> {
    if (!this.store) {
      return;
    }
    if (force) {
      this.store.reset();
    }
    const files = await vscode.workspace.findFiles('**/*.{c,h}', '**/{node_modules,.git,build,dist,out}/**');
    const total = files.length;
    let done = 0;
    let changed = 0;

    // Detect deletions: indexed files that no longer exist on disk.
    const onDisk = new Set(files.map((u) => u.fsPath));
    for (const indexed of this.store.allIndexedFiles()) {
      if (!onDisk.has(indexed)) {
        this.store.deleteFile(indexed);
        this.store.removeFileHash(indexed);
      }
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'C Call Graph indexing' },
      async () => {
        for (const uri of files) {
          done++;
          this.statusBar.text = `$(sync~spin) C Graph: indexing ${done}/${total}`;
          if (this.indexFileIfChanged(uri.fsPath)) {
            changed++;
          }
          // Yield periodically so the UI stays responsive on large repos.
          if (done % 50 === 0) {
            await new Promise((r) => setImmediate(r));
          }
        }
      }
    );

    const c = this.store.counts();
    this.statusBar.text = `$(database) C Graph: ${c.functions} fns, ${c.calls} calls`;
    this.statusBar.tooltip = `Indexed ${total} files (${changed} changed). ${c.variables} variables.`;

    // Persist the in-memory DB to disk.
    this.store.save();
  }

  /**
   * Index a single file if its (mtime,size) differs from the stored hash.
   * @returns true if the file was (re)parsed.
   */
  private indexFileIfChanged(filePath: string): boolean {
    if (!this.store) {
      return false;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      return false;
    }
    const mtime = Math.floor(st.mtimeMs);
    const size = st.size;
    const prev = this.store.getFileHash(filePath);
    if (prev && prev.mtime === mtime && prev.size === size) {
      return false; // unchanged
    }
    this.reindexFile(filePath, mtime, size);
    return true;
  }

  /** Force re-parse of a single file (used on save). */
  reindexFile(filePath: string, mtime?: number, size?: number): void {
    if (!this.store) {
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!C_EXTS.has(ext)) {
      return;
    }
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    if (mtime === undefined || size === undefined) {
      try {
        const st = fs.statSync(filePath);
        mtime = Math.floor(st.mtimeMs);
        size = st.size;
      } catch {
        return;
      }
    }
    try {
      const parsed = parseSource(source);
      this.store.deleteFile(filePath);
      this.store.insertFile(filePath, parsed);
      this.store.setFileHash(filePath, mtime, size);
    } catch (e) {
      console.error(`[c-callgraph] parse failed for ${filePath}:`, e);
    }
  }

  /** Handle a document save event. */
  onSave(doc: vscode.TextDocument): void {
    const ext = path.extname(doc.fileName).toLowerCase();
    if (!C_EXTS.has(ext)) {
      return;
    }
    this.reindexFile(doc.fileName);
    if (this.store) {
      this.store.save();
      const c = this.store.counts();
      this.statusBar.text = `$(database) C Graph: ${c.functions} fns, ${c.calls} calls`;
    }
  }
}
