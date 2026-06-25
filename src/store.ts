/**
 * store.ts — SQLite persistence via sql.js (pure WebAssembly).
 *
 * Using sql.js (not better-sqlite3) means there is NO native module and NO
 * Node/Electron ABI coupling — the same .vsix runs on any platform and any
 * VS Code version. The trade-off: the database lives in memory and must be
 * exported to disk explicitly (save()); the indexer calls save() after each
 * indexing pass.
 *
 * Schema (all rows scoped to one project DB at .vscode/cbm.db):
 *   functions(name, file_path, line, col)
 *   variables(name, file_path, line, col, scope)
 *   calls(caller_name, callee_name, file_path, line)   -- name-based, both dirs
 *   var_refs(function_name, var_name, file_path, line)
 *   file_hashes(file_path, mtime, size)                -- incremental detection
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Database as SqlDatabase, SqlJsStatic } from 'sql.js';
import type { ParseResult } from './parser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js');

export interface FuncRow {
  name: string;
  file_path: string;
  line: number;
  col: number;
}

export interface CallerRow {
  name: string;
  file_path: string;
  line: number;
}

export interface CalleeRow {
  name: string;
  file_path: string;
  line: number;
  resolved: boolean;
}

export interface VarRefFuncRow {
  name: string;
  file_path: string;
  line: number;
}

let _SQL: SqlJsStatic | null = null;

async function getSql(wasmDir: string): Promise<SqlJsStatic> {
  if (_SQL) {
    return _SQL;
  }
  _SQL = await initSqlJs({
    locateFile: (file: string) => path.join(wasmDir, file)
  });
  return _SQL!;
}

export class Store {
  private db: SqlDatabase;
  private dbPath: string;
  private dirty = false;

  private constructor(db: SqlDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.init();
  }

  /** Async factory: initialise sql.js, load existing DB bytes if present. */
  static async open(wasmDir: string, dbPath: string): Promise<Store> {
    const SQL = await getSql(wasmDir);
    let db: SqlDatabase;
    if (fs.existsSync(dbPath)) {
      try {
        const bytes = fs.readFileSync(dbPath);
        db = new SQL.Database(bytes);
      } catch {
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }
    return new Store(db, dbPath);
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS functions (
        name      TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line      INTEGER NOT NULL,
        col       INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS variables (
        name      TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line      INTEGER NOT NULL,
        col       INTEGER NOT NULL,
        scope     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calls (
        caller_name TEXT NOT NULL,
        callee_name TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        line        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS var_refs (
        function_name TEXT NOT NULL,
        var_name    TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        line        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path TEXT PRIMARY KEY,
        mtime     INTEGER NOT NULL,
        size      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_func_name ON functions(name);
      CREATE INDEX IF NOT EXISTS idx_func_file ON functions(file_path);
      CREATE INDEX IF NOT EXISTS idx_var_name ON variables(name);
      CREATE INDEX IF NOT EXISTS idx_var_file ON variables(file_path);
      CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);
      CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_name);
      CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(file_path);
      CREATE INDEX IF NOT EXISTS idx_vrefs_var ON var_refs(var_name);
      CREATE INDEX IF NOT EXISTS idx_vrefs_func ON var_refs(function_name);
      CREATE INDEX IF NOT EXISTS idx_vrefs_file ON var_refs(file_path);
    `);
  }

  // ── Low-level helpers ─────────────────────────────────────────────

  private run(sql: string, params: (string | number)[] = []): void {
    this.db.run(sql, params);
    this.dirty = true;
  }

  private allRows<T>(sql: string, params: (string | number)[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as T);
    }
    stmt.free();
    return rows;
  }

  private getRow<T>(sql: string, params: (string | number)[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? (stmt.getAsObject() as unknown as T) : undefined;
    stmt.free();
    return row;
  }

  /** Persist the in-memory DB to disk (atomic via temp file + rename). */
  save(): void {
    if (!this.dirty) {
      return;
    }
    const data = this.db.export();
    const tmp = this.dbPath + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.dbPath);
    this.dirty = false;
  }

  close(): void {
    try {
      this.save();
    } catch {
      /* ignore */
    }
    this.db.close();
  }

  // ── Mutations ─────────────────────────────────────────────────────

  reset(): void {
    this.run(
      'DELETE FROM calls; DELETE FROM var_refs; DELETE FROM functions; ' +
        'DELETE FROM variables; DELETE FROM file_hashes;'
    );
  }

  deleteFile(filePath: string): void {
    this.run('DELETE FROM calls WHERE file_path = ?', [filePath]);
    this.run('DELETE FROM var_refs WHERE file_path = ?', [filePath]);
    this.run('DELETE FROM functions WHERE file_path = ?', [filePath]);
    this.run('DELETE FROM variables WHERE file_path = ?', [filePath]);
  }

  insertFile(filePath: string, parsed: ParseResult): void {
    this.db.run('BEGIN');
    try {
      for (const f of parsed.functions) {
        this.db.run('INSERT INTO functions(name, file_path, line, col) VALUES (?,?,?,?)', [
          f.name,
          filePath,
          f.line,
          f.col
        ]);
      }
      for (const v of parsed.variables) {
        this.db.run('INSERT INTO variables(name, file_path, line, col, scope) VALUES (?,?,?,?,?)', [
          v.name,
          filePath,
          v.line,
          v.col,
          v.scope
        ]);
      }
      for (const c of parsed.calls) {
        if (c.callerName) {
          this.db.run('INSERT INTO calls(caller_name, callee_name, file_path, line) VALUES (?,?,?,?)', [
            c.callerName,
            c.calleeName,
            filePath,
            c.line
          ]);
        }
      }
      for (const r of parsed.varRefs) {
        this.db.run(
          'INSERT INTO var_refs(function_name, var_name, file_path, line) VALUES (?,?,?,?)',
          [r.funcName, r.varName, filePath, r.line]
        );
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.dirty = true;
  }

  // ── Incremental detection ─────────────────────────────────────────

  getFileHash(filePath: string): { mtime: number; size: number } | undefined {
    return this.getRow('SELECT mtime, size FROM file_hashes WHERE file_path = ?', [filePath]);
  }

  setFileHash(filePath: string, mtime: number, size: number): void {
    this.run(
      'INSERT INTO file_hashes(file_path, mtime, size) VALUES (?,?,?) ' +
        'ON CONFLICT(file_path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size',
      [filePath, mtime, size]
    );
  }

  allIndexedFiles(): string[] {
    return this.allRows<{ file_path: string }>('SELECT file_path FROM file_hashes').map(
      (r) => r.file_path
    );
  }

  removeFileHash(filePath: string): void {
    this.run('DELETE FROM file_hashes WHERE file_path = ?', [filePath]);
  }

  // ── Queries ───────────────────────────────────────────────────────

  findFunctions(name: string): FuncRow[] {
    return this.allRows<FuncRow>(
      'SELECT name, file_path, line, col FROM functions WHERE name = ?',
      [name]
    );
  }

  functionExists(name: string): boolean {
    return !!this.getRow('SELECT 1 AS x FROM functions WHERE name = ? LIMIT 1', [name]);
  }

  variableExists(name: string): boolean {
    return !!this.getRow('SELECT 1 AS x FROM variables WHERE name = ? LIMIT 1', [name]);
  }

  hasCallers(name: string): boolean {
    return !!this.getRow('SELECT 1 AS x FROM calls WHERE callee_name = ? LIMIT 1', [name]);
  }

  hasCallees(name: string): boolean {
    return !!this.getRow('SELECT 1 AS x FROM calls WHERE caller_name = ? LIMIT 1', [name]);
  }

  getCallers(funcName: string): CallerRow[] {
    return this.allRows<CallerRow>(
      `SELECT caller_name AS name, file_path, line
       FROM calls WHERE callee_name = ?
       ORDER BY caller_name, line`,
      [funcName]
    );
  }

  getCallees(funcName: string): CalleeRow[] {
    const rows = this.allRows<{ name: string; file_path: string; line: number }>(
      `SELECT callee_name AS name, file_path, line
       FROM calls WHERE caller_name = ?
       ORDER BY line`,
      [funcName]
    );
    return rows.map((r) => {
      const def = this.getRow<{ file_path: string }>(
        'SELECT file_path FROM functions WHERE name = ? LIMIT 1',
        [r.name]
      );
      return {
        name: r.name,
        file_path: def ? def.file_path : r.file_path,
        line: r.line,
        resolved: !!def
      };
    });
  }

  getVarRefFunctions(varName: string): VarRefFuncRow[] {
    return this.allRows<VarRefFuncRow>(
      `SELECT function_name AS name, file_path, line
       FROM var_refs WHERE var_name = ?
       ORDER BY function_name, line`,
      [varName]
    );
  }

  getFunctionLocation(name: string): FuncRow | undefined {
    return this.getRow<FuncRow>(
      'SELECT name, file_path, line, col FROM functions WHERE name = ? LIMIT 1',
      [name]
    );
  }

  counts(): { functions: number; variables: number; calls: number } {
    const f = this.getRow<{ n: number }>('SELECT COUNT(*) AS n FROM functions')!.n;
    const v = this.getRow<{ n: number }>('SELECT COUNT(*) AS n FROM variables')!.n;
    const c = this.getRow<{ n: number }>('SELECT COUNT(*) AS n FROM calls')!.n;
    return { functions: f, variables: v, calls: c };
  }
}
