/* Integration test: parser → store → queries, against a temp SQLite DB.
 * Run after `npx tsc --outDir out` so out/parser.js and out/store.js exist.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initParser, parseSource } = require('../out/parser');
const { Store } = require('../out/store');

const FILE_A = `
static int g_state = 0;
int g_shared;

static int compute(int x) {
    g_state += x;
    return x + 1;
}

void run(int n) {
    int r = compute(n);
    g_shared = r;
}
`;

const FILE_B = `
void run(int);

void driver(void) {
    run(3);
    run(4);
}

int main(void) {
    int local_shadow = 7;
    driver();
    return g_shared + local_shadow;
}
`;

async function main() {
  await initParser(path.join(__dirname, '..', 'dist'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-test-'));
  const dbPath = path.join(tmp, 'cbm.db');
  const store = await Store.open(path.join(__dirname, '..', 'dist'), dbPath);

  const pa = parseSource(FILE_A);
  store.deleteFile('/proj/a.c');
  store.insertFile('/proj/a.c', pa);
  store.setFileHash('/proj/a.c', 111, 222);

  const pb = parseSource(FILE_B);
  store.deleteFile('/proj/b.c');
  store.insertFile('/proj/b.c', pb);
  store.setFileHash('/proj/b.c', 333, 444);

  const assert = (cond, msg) => {
    if (!cond) {
      console.error('FAIL:', msg);
      process.exit(1);
    } else {
      console.log('ok  -', msg);
    }
  };

  // Cross-file callers: who calls run() → driver (in b.c)
  const runCallers = store.getCallers('run').map((r) => r.name);
  assert(runCallers.includes('driver'), 'run() callers include driver (cross-file)');

  // compute() callers → run (in a.c)
  const computeCallers = store.getCallers('compute').map((r) => r.name);
  assert(computeCallers.includes('run'), 'compute() callers include run');

  // callees of main → driver
  const mainCallees = store.getCallees('main').map((r) => r.name);
  assert(mainCallees.includes('driver'), 'main() callees include driver');

  // callees of driver → run (resolved, defined in a.c)
  const driverCallees = store.getCallees('driver');
  const runEdge = driverCallees.find((c) => c.name === 'run');
  assert(runEdge && runEdge.resolved, 'driver→run resolved to definition');

  // variable refs: g_shared referenced by run (a.c) and main (b.c)
  const sharedRefs = store.getVarRefFunctions('g_shared').map((r) => r.name);
  assert(sharedRefs.includes('run'), 'g_shared referenced by run');
  assert(sharedRefs.includes('main'), 'g_shared referenced by main (cross-file)');

  // g_state referenced by compute
  const stateRefs = store.getVarRefFunctions('g_state').map((r) => r.name);
  assert(stateRefs.includes('compute'), 'g_state referenced by compute');

  // existence checks
  assert(store.functionExists('main'), 'functionExists(main)');
  assert(!store.functionExists('nonexistent'), 'functionExists(nonexistent) false');
  assert(store.variableExists('g_shared'), 'variableExists(g_shared)');

  // incremental: hash round-trip
  const h = store.getFileHash('/proj/a.c');
  assert(h && h.mtime === 111 && h.size === 222, 'file hash round-trip');

  // function location for jump
  const loc = store.getFunctionLocation('compute');
  assert(loc && loc.file_path === '/proj/a.c' && loc.line > 0, 'getFunctionLocation(compute)');

  // re-index a.c (simulate edit): delete + reinsert should not duplicate
  store.deleteFile('/proj/a.c');
  store.insertFile('/proj/a.c', parseSource(FILE_A));
  const computeCallers2 = store.getCallers('compute').map((r) => r.name);
  assert(computeCallers2.filter((n) => n === 'run').length === 1, 're-index does not duplicate edges');

  const counts = store.counts();
  console.log('\ncounts:', counts);

  // ── False-positive guard: a local var sharing a global's name must NOT be
  //    attributed as a reference to the global. ──────────────────────────────
  const FILE_C = `
int shared_count;

void uses_global(void) {
    shared_count = shared_count + 1;
}

void has_local(void) {
    int shared_count = 0;   // shadows the global
    shared_count += 2;
}
`;
  store.deleteFile('/proj/c.c');
  store.insertFile('/proj/c.c', parseSource(FILE_C));
  const scRefs = store.getVarRefFunctions('shared_count').map((r) => r.name);
  assert(scRefs.includes('uses_global'), 'global ref attributed to uses_global');
  assert(!scRefs.includes('has_local'), 'local shadow NOT attributed (no false positive)');

  // ── Persistence round-trip: save to disk, reopen, data survives. ─────────
  store.save();
  assert(fs.existsSync(dbPath), 'db file written to disk');
  store.close();
  const reopened = await Store.open(path.join(__dirname, '..', 'dist'), dbPath);
  const persistedCallers = reopened.getCallers('compute').map((r) => r.name);
  assert(persistedCallers.includes('run'), 'data persists across reopen');
  assert(reopened.functionExists('main'), 'functions persist across reopen');
  reopened.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nALL STORE INTEGRATION ASSERTIONS PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
