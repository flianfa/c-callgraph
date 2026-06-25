/**
 * relationView.ts — Source Insight-style "Relation Window" in the bottom panel.
 *
 * Three modes: callers / callees / variables (who references a global/macro).
 * Children are fetched lazily from the extension on expand. The view follows
 * the editor cursor (debounced, toggleable).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

export type RelMode = 'callers' | 'callees' | 'variables' | 'both';

export class RelationViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cCallgraph.relation';

  private view: vscode.WebviewView | undefined;
  private mode: RelMode = 'both';
  private follow = true;
  private currentRoot = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: () => Store | undefined,
    private readonly openLocation: (file: string, line: number) => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'expand': {
          const children = this.childrenOf(msg.name, msg.mode, msg.ancestors || []);
          view.webview.postMessage({ type: 'expanded', reqId: msg.reqId, children });
          break;
        }
        case 'open':
          if (msg.file && msg.line) {
            this.openLocation(msg.file, msg.line);
          } else {
            // Fallback: jump to function definition.
            const st = this.store();
            const loc = st?.getFunctionLocation(msg.name);
            if (loc) {
              this.openLocation(loc.file_path, loc.line);
            }
          }
          break;
        case 'mode':
          this.mode = msg.mode as RelMode;
          if (this.currentRoot) {
            this.setRoot(this.currentRoot);
          }
          break;
        case 'follow':
          this.follow = !!msg.on;
          break;
        case 'ready':
          if (this.currentRoot) {
            this.setRoot(this.currentRoot);
          }
          break;
      }
    });
  }

  private childrenOf(
    name: string,
    mode: RelMode,
    ancestors: string[]
  ): { name: string; hasChildren: boolean; file: string; line: number }[] {
    const st = this.store();
    if (!st) {
      return [];
    }
    const anc = new Set(ancestors);
    const seen = new Set<string>();
    const out: { name: string; hasChildren: boolean; file: string; line: number }[] = [];

    if (mode === 'callers') {
      for (const c of st.getCallers(name)) {
        if (seen.has(c.name)) {
          continue;
        }
        seen.add(c.name);
        out.push({
          name: c.name,
          file: c.file_path,
          line: c.line, // call-site line
          hasChildren: !anc.has(c.name) && st.hasCallers(c.name)
        });
      }
    } else if (mode === 'callees') {
      for (const c of st.getCallees(name)) {
        if (seen.has(c.name)) {
          continue;
        }
        seen.add(c.name);
        out.push({
          name: c.name,
          file: c.file_path,
          line: c.line, // call-site line
          hasChildren: !anc.has(c.name) && c.resolved && st.hasCallees(c.name)
        });
      }
    } else {
      // variables: show functions that reference this variable/macro
      for (const r of st.getVarRefFunctions(name)) {
        const key = `${r.name}@${r.file_path}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({
          name: r.name,
          file: r.file_path,
          line: r.line,
          hasChildren: false
        });
      }
    }
    return out;
  }

  setRoot(name: string): void {
    this.currentRoot = name;
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'root', name, mode: this.mode });
  }

  /** Called on cursor movement. */
  onCursor(name: string | undefined): void {
    if (!this.follow || !name || !this.view) {
      return;
    }
    const st = this.store();
    if (!st) {
      return;
    }
    // Accept functions or variables/macros.
    if (!st.functionExists(name) && !st.variableExists(name)) {
      return;
    }
    if (name === this.currentRoot) {
      return;
    }
    // Auto-switch mode based on symbol type.
    if (st.variableExists(name) && !st.functionExists(name)) {
      this.mode = 'variables';
    } else if (this.mode === 'variables') {
      this.mode = 'both';
    }
    this.setRoot(name);
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const d3Uri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'd3.min.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'relation.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'relation.css'));
    const nonce = getNonce();
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}';`;

    let template: string;
    try {
      template = fs.readFileSync(path.join(base.fsPath, 'relation.html'), 'utf8');
    } catch {
      template = FALLBACK;
    }
    return template
      .replace(/%CSP%/g, csp)
      .replace(/%CSS%/g, cssUri.toString())
      .replace(/%D3%/g, d3Uri.toString())
      .replace(/%SCRIPT%/g, scriptUri.toString())
      .replace(/%NONCE%/g, nonce);
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

const FALLBACK = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="%CSP%">
<link href="%CSS%" rel="stylesheet"></head><body>
<div id="toolbar"></div><div id="canvas"><svg id="tree"></svg>
<div id="empty">Loading...</div></div>
<script nonce="%NONCE%" src="%D3%"></script>
<script nonce="%NONCE%" src="%SCRIPT%"></script></body></html>`;
