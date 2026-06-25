/* relation.js — Bidirectional call tree with a single shared root block.
 *
 * Layout:
 *   RIGHT side  = callers (who calls root), expanding rightward
 *   LEFT side   = callees (what root calls), expanding leftward
 *   The root is drawn ONCE in the centre; both subtrees align to it vertically.
 *
 * Navigation: drag to pan, scroll/⌘-scroll to zoom (d3.zoom).
 * Double-click a node → jump to its call-site (file:line).
 * Click ▸/◂ to expand/collapse.
 */
/* global d3, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  let mode = 'both'; // 'both' | 'variables'
  let rootData = null;
  let uid = 0;
  let reqId = 0;
  const pending = new Map();
  let needInitialFit = false;

  const COL_WIDTH = 195;
  const ROW_HEIGHT = 30;
  const PAD_X = 11;
  const ROOT_GAP = 26;
  const NODE_H = 22;

  const svg = d3.select('#tree');
  const defs = svg.append('defs');
  defs
    .append('marker')
    .attr('id', 'rl-arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 9)
    .attr('refY', 0)
    .attr('markerWidth', 7)
    .attr('markerHeight', 7)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L9,0L0,4')
    .attr('class', 'rl-arrowhead');

  // Single zoomable/pannable root group containing links + nodes.
  const gRoot = svg.append('g');
  const gLinks = gRoot.append('g').attr('class', 'links');
  const gNodes = gRoot.append('g').attr('class', 'nodes');

  const emptyEl = document.getElementById('empty');
  const rootNameEl = document.getElementById('rootName');

  const zoom = d3
    .zoom()
    .scaleExtent([0.3, 2.5])
    .on('zoom', (event) => gRoot.attr('transform', event.transform));
  svg.call(zoom);
  svg.on('dblclick.zoom', null); // keep dblclick for jump-to-source

  function makeNode(name, file, line, hasChildren, ancestors, side) {
    return {
      _id: ++uid,
      name,
      file: file || '',
      line: line || 0,
      hasChildren: !!hasChildren,
      ancestors: ancestors || [],
      children: null,
      expanded: false,
      side
    };
  }

  function setRoot(name, m) {
    mode = m;
    uid = 0;
    rootData = {
      name,
      callers: makeNode(name, '', 0, true, [], 'right'),
      callees: makeNode(name, '', 0, true, [], 'left')
    };
    rootNameEl.textContent = name;
    emptyEl.style.display = 'none';
    needInitialFit = true;
    syncToolbar();
    if (m === 'variables') {
      requestChildren(rootData.callers, 'right');
      rootData.callees.children = [];
    } else {
      requestChildren(rootData.callers, 'right');
      requestChildren(rootData.callees, 'left');
    }
  }

  function requestChildren(node, side) {
    if (node.children !== null) {
      node.expanded = !node.expanded;
      render();
      return;
    }
    const id = ++reqId;
    pending.set(id, { node, side });
    const queryMode =
      side === 'right' ? (mode === 'variables' ? 'variables' : 'callers') : 'callees';
    vscode.postMessage({ type: 'expand', reqId: id, name: node.name, mode: queryMode, ancestors: node.ancestors });
  }

  function onExpanded(id, children) {
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    const { node, side } = p;
    const childAnc = node.ancestors.concat(node.name);
    node.children = children.map((c) => makeNode(c.name, c.file, c.line, c.hasChildren, childAnc, side));
    node.expanded = true;
    render();
  }

  function layoutSide(treeRoot) {
    const hierarchy = d3.hierarchy(treeRoot, (d) => (d.expanded && d.children ? d.children : null));
    d3.tree().nodeSize([ROW_HEIGHT, COL_WIDTH])(hierarchy);
    return hierarchy;
  }

  function render() {
    if (!rootData) return;
    gLinks.selectAll('*').remove();
    gNodes.selectAll('*').remove();

    const right = layoutSide(rootData.callers);
    const left = layoutSide(rootData.callees);
    const rNodes = right.descendants();
    const lNodes = left.descendants();

    const maxDepthR = d3.max(rNodes, (d) => d.depth) || 0;
    const maxDepthL = d3.max(lNodes, (d) => d.depth) || 0;

    const ROOT_W = nodeWidth(rootData.callers);
    const CENTER_X = maxDepthL * COL_WIDTH + 50;

    const rRootX = rNodes[0].x;
    const lRootX = lNodes[0].x;
    const upR = rRootX - d3.min(rNodes, (d) => d.x);
    const upL = lRootX - d3.min(lNodes, (d) => d.x);
    const downR = d3.max(rNodes, (d) => d.x) - rRootX;
    const downL = d3.max(lNodes, (d) => d.x) - lRootX;
    const centerY = Math.max(upR, upL) + 36;

    const rGeom = (n) => {
      if (n.depth === 0) return { x0: CENTER_X, x1: CENTER_X + ROOT_W, y: centerY };
      const x0 = CENTER_X + ROOT_W + ROOT_GAP + (n.depth - 1) * COL_WIDTH;
      return { x0, x1: x0 + nodeWidth(n.data), y: n.x - rRootX + centerY };
    };
    const lGeom = (n) => {
      if (n.depth === 0) return { x0: CENTER_X, x1: CENTER_X + ROOT_W, y: centerY };
      const x1 = CENTER_X - ROOT_GAP - (n.depth - 1) * COL_WIDTH;
      return { x0: x1 - nodeWidth(n.data), x1, y: n.x - lRootX + centerY };
    };

    right.links().forEach((lk) => {
      const c = rGeom(lk.target);
      const p = rGeom(lk.source);
      drawLink(c.x0, c.y, p.x1, p.y);
    });
    left.links().forEach((lk) => {
      const p = lGeom(lk.source);
      const c = lGeom(lk.target);
      drawLink(p.x0, p.y, c.x1, c.y);
    });

    drawNode(rootData.callers, rGeom(rNodes[0]), true, 'root');
    rNodes.forEach((n) => { if (n.depth !== 0) drawNode(n.data, rGeom(n), false, 'right'); });
    lNodes.forEach((n) => { if (n.depth !== 0) drawNode(n.data, lGeom(n), false, 'left'); });

    // SVG fills the canvas; navigation is via zoom/pan.
    const canvas = document.getElementById('canvas');
    svg.attr('width', canvas.clientWidth).attr('height', canvas.clientHeight);

    if (needInitialFit) {
      needInitialFit = false;
      const ty = canvas.clientHeight / 2 - centerY;
      svg.call(zoom.transform, d3.zoomIdentity.translate(30, ty));
    }
  }

  function drawLink(x1, y1, x2, y2) {
    const mx = (x1 + x2) / 2;
    gLinks.append('path').attr('class', 'rl-link').attr('marker-end', 'url(#rl-arrow)')
      .attr('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
  }

  function drawNode(data, geom, isRoot, side) {
    const w = geom.x1 - geom.x0;
    const ng = gNodes.append('g')
      .attr('class', 'rl-node' + (isRoot ? ' root' : ''))
      .attr('transform', `translate(${geom.x0},${geom.y})`);

    ng.append('rect').attr('x', 0).attr('y', -NODE_H / 2).attr('width', w).attr('height', NODE_H);
    ng.append('text').attr('class', 'rl-name').attr('x', PAD_X).attr('y', 1).text(data.name);
    ng.append('text').attr('class', 'rl-line')
      .attr('x', PAD_X + data.name.length * 7 + 4).attr('y', 1)
      .text(data.line ? ':' + data.line : '');

    if (!isRoot && data.hasChildren) {
      let tx, glyph;
      if (side === 'right') { tx = w + 6; glyph = data.expanded ? '◂' : '▸'; }
      else { tx = -14; glyph = data.expanded ? '▸' : '◂'; }
      ng.append('text').attr('class', 'rl-toggle').attr('x', tx).attr('y', 1).text(glyph)
        .on('click', (event) => { event.stopPropagation(); requestChildren(data, side); });
    }

    // Double click → jump to call-site.
    ng.on('dblclick', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'open', name: data.name, file: data.file, line: data.line });
    });
  }

  function nodeWidth(data) {
    const lineStr = data.line ? ':' + data.line : '';
    return Math.max(64, (data.name.length + lineStr.length) * 7 + PAD_X * 2 + 6);
  }

  function syncToolbar() {
    document.getElementById('btnBoth').classList.toggle('active', mode === 'both');
    document.getElementById('btnVars').classList.toggle('active', mode === 'variables');
  }

  document.getElementById('btnBoth').addEventListener('click', () => {
    if (mode !== 'both') { mode = 'both'; vscode.postMessage({ type: 'mode', mode }); syncToolbar(); }
  });
  document.getElementById('btnVars').addEventListener('click', () => {
    if (mode !== 'variables') { mode = 'variables'; vscode.postMessage({ type: 'mode', mode }); syncToolbar(); }
  });
  document.getElementById('follow').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'follow', on: e.target.checked });
  });

  window.addEventListener('resize', () => {
    if (!rootData) return;
    const canvas = document.getElementById('canvas');
    svg.attr('width', canvas.clientWidth).attr('height', canvas.clientHeight);
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'root') setRoot(msg.name, msg.mode);
    else if (msg.type === 'expanded') onExpanded(msg.reqId, msg.children || []);
  });

  vscode.postMessage({ type: 'ready' });
})();
