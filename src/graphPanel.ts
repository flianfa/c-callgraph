/**
 * graphPanel.ts — Webview hosting a D3 force-directed call graph.
 *
 * Builds an N-layer bidirectional subgraph around a root function (BFS over
 * both callers and callees) and renders it with D3. Messages:
 *   webview → ext: { type: 'open', name } jump to source + refocus
 *                  { type: 'refocus', name } recompute subgraph around name
 *                  { type: 'depth', value } change BFS depth
 *   ext → webview: { type: 'graph', nodes, links, root, depth }
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

interface GraphNode {
  id: string;
  root: boolean;
  resolved: boolean;
}
interface GraphLink {
  source: string;
  target: string; // direction: caller → callee
}

export class GraphPanel {
  public static current: GraphPanel | undefined;
  private static readonly viewType = 'cCallgraph.graph';

  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private depth = 2;
  private rootName = '';

  static createOrShow(
    extensionUri: vscode.Uri,
    store: () => Store | undefined,
    openLocation: (name: string) => void,
    rootName: string
  ): void {
    const column = vscode.ViewColumn.Beside;
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(column);
      GraphPanel.current.setRoot(rootName);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'C Call Graph',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]
      }
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri, store, openLocation);
    GraphPanel.current.setRoot(rootName);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
    private store: () => Store | undefined,
    private openLocation: (name: string) => void
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        switch (msg.type) {
          case 'open':
            this.openLocation(msg.name);
            this.setRoot(msg.name);
            break;
          case 'refocus':
            this.setRoot(msg.name);
            break;
          case 'depth':
            this.depth = Math.max(1, Math.min(5, Number(msg.value) || 2));
            this.setRoot(this.rootName);
            break;
        }
      },
      null,
      this.disposables
    );
  }

  setRoot(name: string): void {
    this.rootName = name;
    const graph = this.buildSubgraph(name, this.depth);
    this.panel.title = `C Call Graph: ${name}`;
    this.panel.webview.postMessage({
      type: 'graph',
      root: name,
      depth: this.depth,
      nodes: graph.nodes,
      links: graph.links
    });
  }

  /** BFS over both directions to `depth` layers from the root. */
  private buildSubgraph(root: string, depth: number): { nodes: GraphNode[]; links: GraphLink[] } {
    const st = this.store();
    const nodes = new Map<string, GraphNode>();
    const links: GraphLink[] = [];
    const linkKeys = new Set<string>();
    if (!st) {
      return { nodes: [], links: [] };
    }

    const addNode = (name: string, isRoot: boolean) => {
      if (!nodes.has(name)) {
        nodes.set(name, { id: name, root: isRoot, resolved: st.functionExists(name) });
      } else if (isRoot) {
        nodes.get(name)!.root = true;
      }
    };
    const addLink = (caller: string, callee: string) => {
      const key = `${caller}->${callee}`;
      if (!linkKeys.has(key)) {
        linkKeys.add(key);
        links.push({ source: caller, target: callee });
      }
    };

    addNode(root, true);
    let frontier = [root];
    const visited = new Set<string>([root]);

    for (let d = 0; d < depth; d++) {
      const nextFrontier: string[] = [];
      for (const name of frontier) {
        // Outgoing: callees
        for (const c of st.getCallees(name)) {
          addNode(c.name, false);
          addLink(name, c.name);
          if (!visited.has(c.name)) {
            visited.add(c.name);
            nextFrontier.push(c.name);
          }
        }
        // Incoming: callers
        for (const c of st.getCallers(name)) {
          addNode(c.name, false);
          addLink(c.name, name);
          if (!visited.has(c.name)) {
            visited.add(c.name);
            nextFrontier.push(c.name);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) {
        break;
      }
    }

    return { nodes: Array.from(nodes.values()), links };
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'graph.js'));
    const d3Uri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'd3.min.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'graph.css'));
    const nonce = getNonce();
    const csp =
      `default-src 'none'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}';`;

    // Load the html template and substitute placeholders.
    let template: string;
    try {
      template = fs.readFileSync(path.join(base.fsPath, 'graph.html'), 'utf8');
    } catch {
      template = FALLBACK_HTML;
    }
    return template
      .replace(/%CSP%/g, csp)
      .replace(/%CSS%/g, cssUri.toString())
      .replace(/%D3%/g, d3Uri.toString())
      .replace(/%SCRIPT%/g, scriptUri.toString())
      .replace(/%NONCE%/g, nonce);
  }

  dispose(): void {
    GraphPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
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

const FALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="%CSP%">
<link href="%CSS%" rel="stylesheet"></head>
<body><div id="toolbar"><label>Depth <input type="range" id="depth" min="1" max="5" value="2"><span id="depthVal">2</span></label><span id="info"></span></div>
<svg id="graph"></svg>
<script nonce="%NONCE%" src="%D3%"></script>
<script nonce="%NONCE%" src="%SCRIPT%"></script>
</body></html>`;
