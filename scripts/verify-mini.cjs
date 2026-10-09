// Run with: node scripts/verify-mini.cjs
// Loads actual TS modules with mocked IPC/window APIs; never touches a real account or snapshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function load(file, mocks, globals = {}, suffix = '') {
  const text = fs.readFileSync(path.join(root, file), 'utf8') + suffix;
  const js = ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: (id) => {
    if (id in mocks) return mocks[id];
    throw Error(`Unexpected dependency: ${id}`);
  }, ...globals }, { filename: file });
  return exports;
}
const bus = load('src/miniBus.ts', {});
const geometry = load('src/miniGeometry.ts', {});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function host({ early = false, fail = false, initGate, showGate, cancelGate, beginGate } = {}) {
  const listeners = new Map(), timers = new Map(), notices = [], calls = [], favorites = [];
  let timerId = 0, request = 0, pending = null;
  const windows = { main: true, mini: false };
  const tracks = [{ uid: 'a', bvid: 'BV-A', cid: 1 }, { uid: 'b', bvid: 'BV-B', cid: 2 }];
  const state = { tracks, currentId: 'b', favs: [], lib: {}, notify: (m) => notices.push(m),
    toggle: () => {}, next: () => {}, prev: () => {}, toggleFav: (t) => favorites.push(t.uid) };
  const dispatch = (event, payload) => { for (const cb of listeners.get(event) ?? []) cb({ payload }); };
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'mini_begin_enter') {
      pending = args.requestId;
      if (beginGate) await beginGate.promise;
      return;
    }
    if (name === 'mini_show') {
      if (pending !== args.requestId) return false;
      if (fail) throw Error('create failed');
      if (showGate) await showGate.promise;
      if (pending !== args.requestId) return false;
      if (early) dispatch(bus.EV_READY, pending);
      return true;
    }
    if (name === 'mini_commit_enter') {
      if (pending !== args.requestId) return false;
      pending = null; windows.main = false; windows.mini = true; return true;
    }
    if (name === 'mini_expand') {
      const old = pending; pending = null; windows.main = true; windows.mini = false;
      if (old) dispatch(bus.EV_CANCELLED, old);
    }
    if (name === 'mini_cancel_enter') {
      if (pending === args.requestId) pending = null;
      if (cancelGate) await cancelGate.promise;
    }
  };
  const mod = load('src/miniHost.ts', {
    '@tauri-apps/api/core': { invoke },
    '@tauri-apps/api/event': { emit: async () => {}, listen: async (event, cb) => {
      if (initGate && event === bus.EV_HELLO) await initGate.promise;
      listeners.set(event, [...listeners.get(event) ?? [], cb]); return () => {};
    } },
    './store': { keyOf: (t) => `${t.bvid}:${t.cid}`, usePlayer: { getState: () => state, subscribe: () => {} } },
    './miniBus': bus,
  }, { crypto: { randomUUID: () => `request-${++request}` }, window: {
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
  } });
  return { ...mod, dispatch, timers, notices, calls, windows, favorites,
    pending: () => pending,
    nativeRestore: () => invoke('mini_expand'),
    id: () => calls.filter((c) => c.name === 'mini_show').at(-1)?.args.requestId };
}

function widget() {
  let effect;
  const listeners = new Map(), emitted = [], timers = new Map(); let timer = 0;
  const event = {
    listen: async (name, cb) => {
      const set = listeners.get(name) ?? new Set(); set.add(cb); listeners.set(name, set);
      return () => set.delete(cb);
    },
    emit: async (name, payload) => { emitted.push({ name, payload }); },
  };
  const win = { setAlwaysOnTop: async () => {}, outerSize: async () => ({ width: 340, height: 90 }),
    setPosition: async () => {}, onMoved: (cb) => event.listen('moved', cb) };
  const monitor = { workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } };
  const m = load('src/MiniPlayer.tsx', {
    react: { useEffect: (fn) => { effect = fn; }, useRef: (v) => ({ current: v }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}] },
    'react/jsx-runtime': { jsx: () => ({}), jsxs: () => ({}), Fragment: 'fragment' },
    '@tauri-apps/api/core': {}, '@tauri-apps/api/event': event,
    '@tauri-apps/api/dpi': { PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } } },
    '@tauri-apps/api/window': { getCurrentWindow: () => win, availableMonitors: async () => [monitor], currentMonitor: async () => monitor },
    './components/ThumbImg': {}, './miniGeometry': geometry, './miniBus': bus, './components/icons': {},
  }, { localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id) => timers.delete(id) });
  m.default();
  return { mount: () => effect(), emitted, listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    dispatch: (name, payload) => { for (const cb of listeners.get(name) ?? []) cb({ payload }); } };
}

let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
(async () => {
  await test('early ready before mini_show reply is retained', async () => {
    const h = host({ early: true }); await h.enterMini();
    assert.deepEqual(h.windows, { main: false, mini: true }); assert.equal(h.notices.length, 0);
  });
  await test('restoring main cancels pending entry and late ready', async () => {
    const h = host(); const work = h.enterMini(); await drain(); const id = h.id();
    await h.restoreMain(); h.dispatch(bus.EV_READY, id); await work;
    assert.deepEqual(h.windows, { main: true, mini: false });
    assert(!h.calls.some((c) => c.name === 'mini_commit_enter'));
  });
  await test('stale ready cannot acknowledge the next request', async () => {
    const h = host(); const first = h.enterMini(); await drain(); const old = h.id();
    await h.restoreMain(); await first;
    const next = h.enterMini(); await drain(); h.dispatch(bus.EV_READY, old); await drain();
    assert(!h.calls.some((c) => c.name === 'mini_commit_enter'));
    h.dispatch(bus.EV_READY, h.id()); await next; assert.equal(h.windows.mini, true);
  });
  await test('timeout preserves original window and cancels request', async () => {
    const h = host(); const work = h.enterMini(); await drain();
    for (const fn of [...h.timers.values()]) fn(); await work;
    assert.deepEqual(h.windows, { main: true, mini: false }); assert.equal(h.notices.length, 1);
    assert(h.calls.some((c) => c.name === 'mini_cancel_enter'));
  });
  await test('creation failure clears waiter and leaves main visible', async () => {
    const h = host({ fail: true }); await h.enterMini();
    assert.equal(h.timers.size, 0); assert.equal(h.windows.main, true); assert.equal(h.notices.length, 1);
  });
  await test('duplicate entry click uses one request', async () => {
    const h = host(); const a = h.enterMini(); const b = h.enterMini(); await drain();
    h.dispatch(bus.EV_READY, h.id()); await Promise.all([a, b]);
    assert.equal(h.calls.filter((c) => c.name === 'mini_show').length, 1);
  });
  await test('restoring main during delayed initialization prevents activation', async () => {
    const initGate = deferred(); const h = host({ early: true, initGate });
    const work = h.enterMini(); await drain(); await h.restoreMain(); await work;
    initGate.resolve(); await drain();
    assert(!h.calls.some((c) => c.name === 'mini_show'));
    assert.deepEqual(h.windows, { main: true, mini: false });
  });
  await test('tray restore before listeners exist cancels registered native request', async () => {
    const initGate = deferred(); const h = host({ early: true, initGate });
    const work = h.enterMini(); await drain(); await h.nativeRestore();
    initGate.resolve(); await work;
    assert(!h.calls.some((c) => c.name === 'mini_commit_enter'));
    assert.deepEqual(h.windows, { main: true, mini: false });
  });
  await test('timeout includes initialization and does not wait for it', async () => {
    const initGate = deferred(); const h = host({ initGate });
    const work = h.enterMini(); await drain();
    for (const fn of [...h.timers.values()]) fn(); await work;
    assert.equal(h.pending(), null); assert.equal(h.notices.length, 1);
    initGate.resolve(); await drain();
    assert(!h.calls.some((c) => c.name === 'mini_show'));
  });
  await test('slow creation timeout allows retry before old response or cleanup returns', async () => {
    const showGate = deferred(), cancelGate = deferred(); const h = host({ showGate, cancelGate });
    const old = h.enterMini(); await drain(); const oldId = h.id();
    for (const fn of [...h.timers.values()]) fn(); await old;
    assert.equal(h.pending(), null); assert.equal(h.notices.length, 1);
    const retry = h.enterMini(); await drain(); const id = h.id();
    assert.notEqual(id, oldId);
    h.dispatch(bus.EV_READY, oldId); showGate.resolve(); await drain();
    assert(!h.calls.some((c) => c.name === 'mini_commit_enter'));
    h.dispatch(bus.EV_READY, id); await retry;
    assert.deepEqual(h.windows, { main: false, mini: true });
    cancelGate.resolve(); await drain();
  });
  await test('late creation rejection after timeout is handled without duplicate notice', async () => {
    const showGate = deferred(); const h = host({ showGate });
    const work = h.enterMini(); await drain();
    for (const fn of [...h.timers.values()]) fn(); await work;
    showGate.reject(Error('late creation failure')); await drain();
    assert.equal(h.notices.length, 1);
  });
  await test('late begin reply after cancellation cannot start creation', async () => {
    const beginGate = deferred(); const h = host({ beginGate });
    const work = h.enterMini(); await drain(); await h.restoreMain(); await work;
    beginGate.resolve(); await drain();
    assert.equal(h.pending(), null);
    assert(!h.calls.some((c) => c.name === 'mini_show'));
  });
  await test('favorite targets displayed track and repeated delivery is deduplicated', async () => {
    const h = host(); await h.initMiniHost();
    const cmd = { cmdId: 'favorite', op: 'fav', target: 'BV-A:1' };
    h.dispatch(bus.EV_CMD, cmd); h.dispatch(bus.EV_CMD, cmd);
    h.dispatch(bus.EV_CMD, { cmdId: 'gone', op: 'fav', target: 'missing' });
    assert.deepEqual(h.favorites, ['a']);
  });
  await test('update callback restores main through exclusive window switch', async () => {
    const h = host({ early: true }); await h.enterMini();
    const source = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
    const callback = source.match(/\.then\(\(u\) => \{([\s\S]*?)\n        \}\)/)[1];
    vm.runInNewContext(`(()=>{${callback}})()`, { u: {}, cancelled: false,
      restoreMain: h.restoreMain, setUpdate: () => {}, usePlayer: {} });
    await drain(); assert.deepEqual(h.windows, { main: true, mini: false });
  });
  await test('full window clamped at right and bottom edges, including 150% DPI', () => {
    const area = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } };
    for (const scale of [1, 1.25, 1.5]) {
      const size = { width: 340 * scale, height: 90 * scale };
      const p = geometry.clampMiniPosition({ x: 1840, y: 1000 }, size, area);
      assert(p.x + size.width <= 1920); assert(p.y + size.height <= 1040);
    }
  });
  await test('negative-coordinate monitor and corrupt position preferences', () => {
    const p = geometry.clampMiniPosition({ x: -2100, y: -50 }, { width: 340, height: 90 },
      { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1040 } });
    assert.equal(p.x, -1920); assert.equal(p.y, 0);
    for (const raw of [null, '{bad', '{"x":"10","y":20}', '{"x":1e400,"y":0}']) {
      assert.equal(geometry.parseMiniPosition(raw), null);
    }
  });
  await test('geometry reapplies actual size after cross-monitor DPI change', async () => {
    let placed, reads = 0;
    const monitor = { workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } };
    const m = load('src/MiniPlayer.tsx', {
      react: {}, 'react/jsx-runtime': {}, '@tauri-apps/api/core': {}, '@tauri-apps/api/event': {},
      '@tauri-apps/api/dpi': { PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } } },
      '@tauri-apps/api/window': { getCurrentWindow: () => ({ setAlwaysOnTop: async () => {},
        outerSize: async () => ++reads === 1 ? { width: 340, height: 90 } : { width: 510, height: 135 },
        setPosition: async (p) => { placed = p; } }), availableMonitors: async () => [monitor], currentMonitor: async () => monitor },
      './components/ThumbImg': {}, './miniGeometry': geometry, './miniBus': bus, './components/icons': {},
    }, { localStorage: { getItem: (k) => k.endsWith('geometry') ? '{"x":1840,"y":1000}' : null } },
    '\nexport { applyGeometry };');
    await m.applyGeometry(() => true);
    assert(placed.x + 510 <= 1920 && placed.y + 135 <= 1040);
  });

  await test('mini only acknowledges matching request after geometry and full state', async () => {
    const w = widget(); const cleanup = w.mount(); await drain();
    w.dispatch(bus.EV_STATE, { seq: 10 });
    assert(!w.emitted.some((e) => e.name === bus.EV_READY));
    w.dispatch(bus.EV_ACTIVATE, 'active'); await drain();
    assert(w.emitted.some((e) => e.name === bus.EV_HELLO && e.payload.requestId === 'active'));
    w.dispatch(bus.EV_STATE, { seq: 12, requestId: 'old' });
    assert(!w.emitted.some((e) => e.name === bus.EV_READY));
    w.dispatch(bus.EV_STATE, { seq: 11, requestId: 'active' });
    w.dispatch(bus.EV_STATE, { seq: 13, requestId: 'active' });
    assert.equal(w.emitted.filter((e) => e.name === bus.EV_READY && e.payload === 'active').length, 1);
    cleanup(); await drain(); assert.equal(w.listenerCount(), 0);
  });
  await test('StrictMode cleanup releases listeners registered after unmount', async () => {
    const w = widget(); const cleanup = w.mount(); cleanup(); await drain();
    assert.equal(w.listenerCount(), 0);
    assert(!w.emitted.some((e) => e.name === bus.EV_READY));
  });

  console.log(`${count} mini regression cases passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });