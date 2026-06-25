/**
 * parser.ts — tree-sitter based C source parser.
 *
 * Extracts, from a single C translation unit:
 *   - function definitions (name + position)
 *   - global / static variable definitions
 *   - call relationships (which function calls which callee name)
 *   - variable references (which function references which identifier)
 *
 * Cross-file resolution is name-based and handled in the store/query layer.
 * For variable references we record every non-local identifier used inside a
 * function (excluding call targets and the function's own params/locals). The
 * query layer then resolves a *name* against the project-wide variables table,
 * which is what makes cross-file global references work: tree-sitter never
 * expands #include, so a .c that uses a header-declared global has no local
 * declaration of it — recording the bare identifier and resolving later is the
 * only way to attribute the reference. Local params/locals are excluded so a
 * local variable that happens to share a global's name is not a false match.
 */
import * as path from 'path';

// web-tree-sitter 0.22.x is CommonJS: default export is the Parser class and
// Parser.Language becomes available only after Parser.init().
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Parser = require('web-tree-sitter');

export interface FuncDef {
  name: string;
  line: number; // 1-based
  col: number; // 0-based
  startByte: number;
  endByte: number;
}

export interface VarDef {
  name: string;
  line: number;
  col: number;
  scope: 'global' | 'static';
}

export interface CallEdge {
  callerName: string; // enclosing function name, or '' if at file scope
  calleeName: string;
  line: number;
}

export interface VarRefEdge {
  funcName: string; // enclosing function name
  varName: string; // candidate variable name (resolved to a global at query time)
  line: number;
}

export interface ParseResult {
  functions: FuncDef[];
  variables: VarDef[];
  calls: CallEdge[];
  varRefs: VarRefEdge[];
}

interface FuncRange {
  name: string;
  start: number;
  end: number;
  locals: Set<string>; // params + locally-declared names (excluded from var refs)
}

let _parser: any | null = null;
let _cLang: any | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Initialise web-tree-sitter and load the C grammar.
 * @param wasmDir directory containing tree-sitter.wasm and wasm/tree-sitter-c.wasm
 */
export async function initParser(wasmDir: string): Promise<void> {
  if (_parser && _cLang) {
    return;
  }
  if (_initPromise) {
    return _initPromise;
  }
  _initPromise = (async () => {
    await Parser.init({
      locateFile(scriptName: string) {
        return path.join(wasmDir, scriptName);
      }
    });
    _parser = new Parser();
    const cWasmPath = path.join(wasmDir, 'wasm', 'tree-sitter-c.wasm');
    _cLang = await Parser.Language.load(cWasmPath);
    _parser.setLanguage(_cLang);
  })();
  return _initPromise;
}

/** True once initParser has completed. */
export function isReady(): boolean {
  return !!(_parser && _cLang);
}

/**
 * Descend through a declarator to find the innermost identifier.
 * Handles pointer_declarator, function_declarator, array_declarator,
 * parenthesized_declarator, init_declarator wrappers.
 */
function declaratorIdentifier(node: any): any | null {
  if (!node) {
    return null;
  }
  if (node.type === 'identifier' || node.type === 'field_identifier') {
    return node;
  }
  const inner = node.childForFieldName ? node.childForFieldName('declarator') : null;
  if (inner) {
    return declaratorIdentifier(inner);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const found = declaratorIdentifier(node.namedChild(i));
    if (found) {
      return found;
    }
  }
  return null;
}

/** Find the function name identifier within a function_definition. */
function functionName(funcDefNode: any): any | null {
  const decl = funcDefNode.childForFieldName('declarator');
  if (!decl) {
    return null;
  }
  return declaratorIdentifier(decl);
}

/** Does this declaration carry a `static` storage-class specifier? */
function hasStaticStorage(declNode: any): boolean {
  for (let i = 0; i < declNode.childCount; i++) {
    const c = declNode.child(i);
    if (c.type === 'storage_class_specifier' && c.text === 'static') {
      return true;
    }
  }
  return false;
}

function containsFunctionDeclarator(node: any): boolean {
  if (!node) {
    return false;
  }
  if (node.type === 'function_declarator') {
    return true;
  }
  const inner = node.childForFieldName ? node.childForFieldName('declarator') : null;
  if (inner) {
    return containsFunctionDeclarator(inner);
  }
  return false;
}

/**
 * Collect locally-bound names of a function: parameters + names declared in
 * any declaration within the function body. Over-inclusive on purpose — if a
 * name is declared locally anywhere in the function, references to it are
 * ambiguous w.r.t. a same-named global and are best excluded.
 */
function collectLocalNames(funcDefNode: any): Set<string> {
  const locals = new Set<string>();

  // Parameters: walk the declarator for parameter_declaration nodes.
  const collectParams = (node: any) => {
    if (!node) {
      return;
    }
    if (node.type === 'parameter_declaration') {
      const id = declaratorIdentifier(node.childForFieldName('declarator') || node);
      if (id) {
        locals.add(id.text);
      }
      return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      collectParams(node.namedChild(i));
    }
  };
  collectParams(funcDefNode.childForFieldName('declarator'));

  // Local declarations inside the body (any nesting depth).
  const body = funcDefNode.childForFieldName('body');
  const collectDecls = (node: any) => {
    if (!node) {
      return;
    }
    if (node.type === 'declaration') {
      for (let j = 0; j < node.namedChildCount; j++) {
        const d = node.namedChild(j);
        if (
          d.type === 'init_declarator' ||
          d.type === 'identifier' ||
          d.type === 'pointer_declarator' ||
          d.type === 'array_declarator'
        ) {
          const id = declaratorIdentifier(d);
          if (id) {
            locals.add(id.text);
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      collectDecls(node.namedChild(i));
    }
  };
  collectDecls(body);

  return locals;
}

/**
 * Parse a C source string into structured symbols and edges.
 */
export function parseSource(source: string): ParseResult {
  if (!_parser) {
    throw new Error('parser not initialised — call initParser() first');
  }
  const tree = _parser.parse(source);
  const root = tree.rootNode;

  const result: ParseResult = { functions: [], variables: [], calls: [], varRefs: [] };
  const funcRanges: FuncRange[] = [];

  walkTopLevel(root, result, funcRanges);
  collectCallsAndRefs(root, funcRanges, result);

  tree.delete();
  return result;
}

/** Collect top-level function defs and global/static variable defs. */
function walkTopLevel(root: any, result: ParseResult, funcRanges: FuncRange[]): void {
  const visit = (node: any, atFileScope: boolean) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child.type === 'function_definition') {
        const id = functionName(child);
        if (id) {
          result.functions.push({
            name: id.text,
            line: id.startPosition.row + 1,
            col: id.startPosition.column,
            startByte: child.startIndex,
            endByte: child.endIndex
          });
          funcRanges.push({
            name: id.text,
            start: child.startIndex,
            end: child.endIndex,
            locals: collectLocalNames(child)
          });
        }
      } else if (child.type === 'declaration' && atFileScope) {
        const isStatic = hasStaticStorage(child);
        for (let j = 0; j < child.namedChildCount; j++) {
          const d = child.namedChild(j);
          if (
            d.type === 'init_declarator' ||
            d.type === 'identifier' ||
            d.type === 'pointer_declarator' ||
            d.type === 'array_declarator'
          ) {
            // Exclude function prototypes (declarator is a function_declarator).
            if (containsFunctionDeclarator(d)) {
              continue;
            }
            const id = declaratorIdentifier(d);
            if (id) {
              result.variables.push({
                name: id.text,
                line: id.startPosition.row + 1,
                col: id.startPosition.column,
                scope: isStatic ? 'static' : 'global'
              });
            }
          }
        }
      } else if (child.type === 'preproc_def' && atFileScope) {
        // #define MACRO_NAME value — index as a 'global' variable so
        // "Show Variable References" can find functions that use it.
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          result.variables.push({
            name: nameNode.text,
            line: nameNode.startPosition.row + 1,
            col: nameNode.startPosition.column,
            scope: 'global'
          });
        }
      } else if (
        child.type === 'preproc_if' ||
        child.type === 'preproc_ifdef' ||
        child.type === 'preproc_else' ||
        child.type === 'preproc_elif' ||
        child.type === 'linkage_specification' ||
        child.type === 'declaration_list' ||
        child.type === 'translation_unit'
      ) {
        visit(child, true);
      }
    }
  };
  visit(root, true);
}

/** Map a byte offset to the enclosing function range (or null for file scope). */
function enclosingRange(byte: number, funcRanges: FuncRange[]): FuncRange | null {
  for (const r of funcRanges) {
    if (byte >= r.start && byte < r.end) {
      return r;
    }
  }
  return null;
}

/** Walk full tree collecting call edges and variable reference edges. */
function collectCallsAndRefs(root: any, funcRanges: FuncRange[], result: ParseResult): void {
  // Dedup variable refs per (function, name) — keep the first occurrence line.
  const seenRefs = new Set<string>();

  // Build a set of all function names defined in this file so we can detect
  // function-pointer / callback usage: when a known function name appears as
  // an argument to a call (not as the call target), it is being passed as a
  // callback and we record a call edge to it.
  const funcNames = new Set(result.functions.map((f) => f.name));

  const recurse = (node: any) => {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn && fn.type === 'identifier') {
        const r = enclosingRange(node.startIndex, funcRanges);
        result.calls.push({
          callerName: r ? r.name : '',
          calleeName: fn.text,
          line: node.startPosition.row + 1
        });
      }
    } else if (node.type === 'identifier') {
      const parent = node.parent;
      // NOTE: web-tree-sitter returns a fresh wrapper object on every node
      // access, so `=== node` identity checks never match. Compare by byte
      // span instead.
      const sameNode = (a: any) =>
        a && a.startIndex === node.startIndex && a.endIndex === node.endIndex;
      const isCallTarget =
        parent &&
        parent.type === 'call_expression' &&
        sameNode(parent.childForFieldName('function'));
      const isDeclName =
        parent &&
        (parent.type === 'init_declarator' || parent.type === 'declaration') &&
        sameNode(parent.childForFieldName('declarator'));
      if (!isCallTarget && !isDeclName) {
        const r = enclosingRange(node.startIndex, funcRanges);
        // Callback / function-pointer detection: if this identifier is a known
        // function name passed as an argument (or assigned), record a call edge.
        if (r && funcNames.has(node.text) && node.text !== r.name) {
          result.calls.push({
            callerName: r.name,
            calleeName: node.text,
            line: node.startPosition.row + 1
          });
        } else if (r && !r.locals.has(node.text) && node.text !== r.name && !funcNames.has(node.text)) {
          const key = `${r.name}\u0000${node.text}`;
          if (!seenRefs.has(key)) {
            seenRefs.add(key);
            result.varRefs.push({
              funcName: r.name,
              varName: node.text,
              line: node.startPosition.row + 1
            });
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      recurse(node.namedChild(i));
    }
  };
  recurse(root);
}
