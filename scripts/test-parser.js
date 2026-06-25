/* Standalone smoke test for the C parser (no VS Code dependency).
 * Compiles parser.ts on the fly via ts-node-less approach: we require the
 * transpiled JS. Instead, to keep it dependency-free, we re-implement the
 * init using the same logic against the source TS through tsc output.
 *
 * Simpler: compile src/parser.ts with tsc to a temp dir is heavy. We just
 * exercise web-tree-sitter directly mirroring parser.ts to validate the
 * grammar + extraction queries end-to-end.
 */
const path = require('path');
const Parser = require('web-tree-sitter');

const SAMPLE = `
#include <stdio.h>

static int g_counter = 0;
int g_total;

static int helper(int x) {
    g_counter += x;
    return x * 2;
}

void process(int n) {
    int local = helper(n);
    g_total = g_total + local;
    printf("%d\\n", local);
}

int main(void) {
    process(5);
    process(10);
    return g_counter;
}
`;

async function main() {
  await Parser.init();
  const parser = new Parser();
  const Lang = Parser.Language;
  const c = await Lang.load(path.join(__dirname, '..', 'wasm', 'tree-sitter-c.wasm'));
  parser.setLanguage(c);

  const tree = parser.parse(SAMPLE);
  const root = tree.rootNode;

  // Collect function definitions.
  const funcs = [];
  const funcRanges = [];
  const vars = [];

  function declId(node) {
    if (!node) return null;
    if (node.type === 'identifier' || node.type === 'field_identifier') return node;
    const inner = node.childForFieldName ? node.childForFieldName('declarator') : null;
    if (inner) return declId(inner);
    for (let i = 0; i < node.namedChildCount; i++) {
      const f = declId(node.namedChild(i));
      if (f) return f;
    }
    return null;
  }
  function hasStatic(decl) {
    for (let i = 0; i < decl.childCount; i++) {
      const ch = decl.child(i);
      if (ch.type === 'storage_class_specifier' && ch.text === 'static') return true;
    }
    return false;
  }
  function containsFuncDecl(node) {
    if (!node) return false;
    if (node.type === 'function_declarator') return true;
    const inner = node.childForFieldName ? node.childForFieldName('declarator') : null;
    return inner ? containsFuncDecl(inner) : false;
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    const ch = root.namedChild(i);
    if (ch.type === 'function_definition') {
      const id = declId(ch.childForFieldName('declarator'));
      if (id) {
        funcs.push(id.text);
        funcRanges.push({ name: id.text, start: ch.startIndex, end: ch.endIndex });
      }
    } else if (ch.type === 'declaration') {
      const isStatic = hasStatic(ch);
      for (let j = 0; j < ch.namedChildCount; j++) {
        const d = ch.namedChild(j);
        if (['init_declarator', 'identifier', 'pointer_declarator', 'array_declarator'].includes(d.type)) {
          if (containsFuncDecl(d)) continue;
          const id = declId(d);
          if (id) vars.push({ name: id.text, scope: isStatic ? 'static' : 'global' });
        }
      }
    }
  }

  function enclosing(byte) {
    for (const r of funcRanges) if (byte >= r.start && byte < r.end) return r.name;
    return '';
  }

  const calls = [];
  const refs = [];
  const globalNames = new Set(vars.map((v) => v.name));
  function recurse(node) {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn && fn.type === 'identifier') {
        calls.push({ caller: enclosing(node.startIndex), callee: fn.text });
      }
    }
    if (node.type === 'identifier' && globalNames.has(node.text)) {
      const p = node.parent;
      const isCallTarget = p && p.type === 'call_expression' && p.childForFieldName('function') === node;
      if (!isCallTarget) {
        const fn = enclosing(node.startIndex);
        if (fn) refs.push({ fn, var: node.text });
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) recurse(node.namedChild(i));
  }
  recurse(root);

  console.log('functions:', funcs);
  console.log('variables:', vars);
  console.log('calls:', calls);
  console.log('varRefs:', refs);

  // Assertions
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
  assert(funcs.includes('helper') && funcs.includes('process') && funcs.includes('main'), 'all functions found');
  assert(vars.find((v) => v.name === 'g_counter' && v.scope === 'static'), 'g_counter static');
  assert(vars.find((v) => v.name === 'g_total' && v.scope === 'global'), 'g_total global');
  assert(calls.find((c) => c.caller === 'main' && c.callee === 'process'), 'main calls process');
  assert(calls.find((c) => c.caller === 'process' && c.callee === 'helper'), 'process calls helper');
  assert(refs.find((r) => r.fn === 'helper' && r.var === 'g_counter'), 'helper refs g_counter');
  assert(refs.find((r) => r.fn === 'process' && r.var === 'g_total'), 'process refs g_total');
  console.log('\nALL PARSER ASSERTIONS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
