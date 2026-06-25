/* graph.js — D3 force-directed call graph rendered inside the webview.
 *
 * Receives { type:'graph', nodes, links, root, depth } from the extension and
 * draws nodes (functions) and directed links (caller → callee). Supports drag,
 * zoom/pan, hover highlight of incident edges, and click-to-focus (which jumps
 * to source and re-centres the subgraph on the clicked node).
 */
/* global d3, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const svg = d3.select('#graph');
  let width = window.innerWidth;
  let height = window.innerHeight - 32;

  // Arrow marker for directed edges.
  const defs = svg.append('defs');
  defs
    .append('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 18)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5');

  const container = svg.append('g');
  let linkSel = container.append('g').attr('class', 'links').selectAll('line');
  let nodeSel = container.append('g').attr('class', 'nodes').selectAll('g');

  // Zoom / pan.
  const zoom = d3
    .zoom()
    .scaleExtent([0.2, 4])
    .on('zoom', (event) => container.attr('transform', event.transform));
  svg.call(zoom);

  let simulation = d3
    .forceSimulation()
    .force('charge', d3.forceManyBody().strength(-300))
    .force('link', d3.forceLink().id((d) => d.id).distance(90))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(28));

  function render(data) {
    const nodes = data.nodes.map((n) => Object.assign({}, n));
    const links = data.links.map((l) => Object.assign({}, l));

    document.getElementById('info').textContent =
      `${nodes.length} functions · ${links.length} calls`;

    // Links
    linkSel = container
      .select('.links')
      .selectAll('line')
      .data(links, (d) => `${d.source.id || d.source}->${d.target.id || d.target}`);
    linkSel.exit().remove();
    linkSel = linkSel
      .enter()
      .append('line')
      .attr('class', 'link')
      .attr('marker-end', 'url(#arrow)')
      .merge(linkSel);

    // Nodes
    nodeSel = container
      .select('.nodes')
      .selectAll('g.node')
      .data(nodes, (d) => d.id);
    nodeSel.exit().remove();

    const nodeEnter = nodeSel
      .enter()
      .append('g')
      .attr('class', (d) =>
        'node ' + (d.root ? 'root' : d.resolved ? 'resolved' : 'unresolved')
      )
      .call(
        d3
          .drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended)
      );

    nodeEnter
      .append('circle')
      .attr('r', (d) => (d.root ? 11 : 7));

    nodeEnter
      .append('text')
      .attr('x', 12)
      .attr('y', 4)
      .text((d) => d.id);

    // Click → jump to source + refocus.
    nodeEnter.on('click', (event, d) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'open', name: d.id });
    });

    // Hover → highlight incident edges.
    nodeEnter
      .on('mouseenter', (event, d) => highlight(d.id, true))
      .on('mouseleave', (event, d) => highlight(d.id, false));

    nodeSel = nodeEnter.merge(nodeSel);
    nodeSel.attr('class', (d) =>
      'node ' + (d.root ? 'root' : d.resolved ? 'resolved' : 'unresolved')
    );

    simulation.nodes(nodes).on('tick', ticked);
    simulation.force('link').links(links);
    simulation.alpha(0.9).restart();
  }

  function ticked() {
    linkSel
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
  }

  function highlight(id, on) {
    linkSel.classed('highlight', (l) => {
      const s = l.source.id || l.source;
      const t = l.target.id || l.target;
      return on && (s === id || t === id);
    });
  }

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  // Depth slider.
  const depthInput = document.getElementById('depth');
  const depthVal = document.getElementById('depthVal');
  depthInput.addEventListener('input', () => {
    depthVal.textContent = depthInput.value;
  });
  depthInput.addEventListener('change', () => {
    vscode.postMessage({ type: 'depth', value: Number(depthInput.value) });
  });

  window.addEventListener('resize', () => {
    width = window.innerWidth;
    height = window.innerHeight - 32;
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.alpha(0.3).restart();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'graph') {
      depthInput.value = msg.depth;
      depthVal.textContent = msg.depth;
      render(msg);
    }
  });
})();
