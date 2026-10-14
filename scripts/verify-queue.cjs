// Run with: node scripts/verify-queue.cjs
// Real store/engine, isolated snapshots and fake media/network. No user data or Bilibili requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const key = (t) => `${t.bvid}:${t.cid}`;
const song = (name, cid = 1) => ({ bvid: `BV-${name}`, cid, title: name, up: 'fixture', cover: '', duration: 300 });
const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map((name) => song(name));

function load(file, mocks, globals = {}) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: (id) => {
    if (id in mocks) return mocks[id];
    throw Error(`Unexpected dependency: ${id}`);
  }, console: { log() {}, error() {} }, Error, ...globals }, { filename: file });
  return exports;
}

async function setup(snapshot, version = 3) {
  const storage = new Map(), audios = [], pending = new Map(), requests = [], plays = [];
  if (snapshot) storage.set(`bmuisc.snapshot.v${version}`, JSON.stringify(snapshot));
  class FakeAudio {
    constructor() {
      this.paused = true; this.error = null; this.currentTime = 0; this.duration = 300;
      this.readyState = 1; this.volume = 0.8; this.listeners = new Map(); this.value = '';
      this.silentPause = false; audios.push(this);
    }
    set src(value) { this.value = value; this.error = null; this.currentTime = 0; }
    get src() { return this.value; }
    addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
    emit(name) { for (const fn of this.listeners.get(name) ?? []) fn(); }
    play() {
      assert.ok(this.src, 'must not play without a source');
      plays.push(this.src); this.paused = false;
      this.emit('loadedmetadata'); this.emit('play'); this.emit('playing');
      return Promise.resolve();
    }
    pause() { if (!this.paused) { this.paused = true; if (!this.silentPause) this.emit('pause'); } }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
  }
  const stream = (bvid) => ({ audio: [{ key: bvid }] });
  const engine = load('src/engine.ts', {
    '@tauri-apps/plugin-log': { info: async () => {}, error: async () => {} },
    './api': { proxyPort: async () => 12345, resolveStreams: async (bvid) => {
      requests.push(bvid);
      return pending.get(bvid)?.promise ?? stream(bvid);
    } },
  }, { Audio: FakeAudio });
  const { usePlayer } = load('src/store.ts', { zustand: require('zustand'), './engine': engine }, {
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    setTimeout: () => 1, clearTimeout() {},
  });
  await engine.initEngine();
  usePlayer.getState().restore();
  if (!snapshot) usePlayer.setState({ mode: 'one' }); // avoid unrelated background prefetch in these cases
  return {
    state: usePlayer.getState, set: usePlayer.setState, engine, audios, storage, requests, plays,
    queue: () => Array.from(usePlayer.getState().tracks, (t) => t.title),
    current: () => usePlayer.getState().tracks.find((t) => t.uid === usePlayer.getState().currentId),
    hold(item) {
      let resolve;
      const promise = new Promise((yes) => { resolve = yes; });
      pending.set(item.bvid, { promise });
      return () => { pending.delete(item.bvid); resolve(stream(item.bvid)); };
    },
  };
}

function snapshot(tracks, libItems, currentId, position = 73) {
  return { v: 3, tracks, currentId, position, mode: 'one',
    lib: Object.fromEntries(libItems.map((t) => [key(t), t])), libOrder: libItems.map(key),
    playlists: [], favs: [], recent: [] };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('23 songs remain 23 queue entries after repeated add-and-play', async () => {
  const h = await setup(), items = Array.from({ length: 23 }, (_, i) => song(String(i)));
  h.state().addTracks(items, true, 'all'); await drain();
  const firstUid = h.state().currentId;
  for (let i = 0; i < 6; i++) { h.state().addTracks(items, true, 'all'); await drain(); }
  assert.equal(h.state().libOrder.length, 23);
  assert.equal(h.state().tracks.length, 23);
  assert.equal(h.state().currentId, firstUid);
});

test('batch duplicates are removed in library, favorites, playlists and whole-list playback', async () => {
  const h = await setup();
  h.state().addTracks([a, a, b], false, 'favs');
  assert.equal(h.state().favs.length, 2);
  const id = h.state().createPlaylist('test');
  assert.equal(h.state().addToPlaylist(id, [a, a, b, b]), 2);
  h.state().playFrom(id, key(a)); await drain();
  assert.deepEqual(h.queue(), ['A', 'B']);
  h.state().playFrom('favs', key(b)); await drain();
  assert.deepEqual(h.queue(), ['A', 'B']);
});

test('enqueue is idempotent; distinct parts of the same video remain separate', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  h.state().seekTo(42); h.audios[0].emit('timeupdate');
  const uid = h.state().currentId, playCount = h.plays.length;
  h.state().enqueue(a); h.state().enqueue(song('A', 2));
  assert.equal(h.state().tracks.length, 3);
  assert.equal(h.state().currentId, uid);
  assert.equal(h.state().position, 42);
  assert.equal(h.plays.length, playCount);
});

test('Play Next moves existing entries and inserts new ones without interrupting current audio', async () => {
  const h = await setup();
  h.state().addTracks([a, b, c, d], false);
  h.state().playFrom('all', key(b)); await drain();
  h.state().seekTo(42); h.audios[0].emit('timeupdate');
  const ids = new Map(h.state().tracks.map((t) => [key(t), t.uid])), playCount = h.plays.length;
  h.state().playNext([d, a, e, d, b]);
  assert.deepEqual(h.queue(), ['B', 'D', 'A', 'E', 'C']);
  for (const t of h.state().tracks) if (ids.has(key(t))) assert.equal(t.uid, ids.get(key(t)));
  assert.equal(h.state().currentId, ids.get(key(b)));
  assert.equal(h.state().position, 42);
  assert.equal(h.plays.length, playCount);
  h.state().playNext([b]);
  assert.deepEqual(h.queue(), ['B', 'D', 'A', 'E', 'C']);
  assert.equal(h.plays.length, playCount);
});

test('Play Next with no current item reuses an existing queue entry and starts it', async () => {
  const h = await setup();
  h.state().enqueue(a); h.state().enqueue(b);
  h.state().playNext([b, b, c]); await drain();
  assert.deepEqual(h.queue(), ['A', 'B', 'C']);
  assert.equal(h.current().title, 'B');
  assert.equal(h.state().playing, true);
});

test('removing a non-current library song preserves current audio and cleans all references', async () => {
  const h = await setup();
  const id = h.state().createPlaylist('test');
  h.state().addTracks([a, b, c], true, id); await drain();
  h.state().toggleFav(b); h.set({ recent: [key(b)] });
  h.state().seekTo(42); h.audios[0].emit('timeupdate');
  const playCount = h.plays.length;
  h.state().removeFromLib([key(b)]);
  assert.deepEqual(h.queue(), ['A', 'C']);
  assert.equal(h.state().lib[key(b)], undefined);
  assert.equal(h.state().favs.length, 0);
  assert.equal(h.state().recent.length, 0);
  assert.ok(!h.state().playlists[0].keys.includes(key(b)));
  assert.equal(h.state().position, 42);
  assert.equal(h.plays.length, playCount);
});

test('batch deletion selects the first surviving successor and continues active playback', async () => {
  const h = await setup();
  h.state().addTracks([a, b, c, d], false);
  h.state().playFrom('all', key(b)); await drain();
  h.state().removeFromLib([key(a), key(b), key(c)]); await drain();
  assert.deepEqual(h.queue(), ['D']);
  assert.equal(h.current().title, 'D');
  assert.equal(h.state().playing, true);
  assert.equal(h.state().position, 0);
});

test('deleting the current item while paused remains paused and clears old error/seek state', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  h.state().pause(); h.set({ error: 'old source failure', savedSeek: 91 });
  const playCount = h.plays.length;
  h.state().removeFromLib([key(a)]); await drain();
  assert.equal(h.current().title, 'B');
  assert.equal(h.state().playing, false);
  assert.equal(h.state().savedSeek, 0);
  assert.equal(h.state().error, null);
  assert.equal(h.plays.length, playCount);
  h.state().play(); await drain();
  assert.equal(h.state().position, 0);
});

test('deletion during source resolution continues the requested playback and ignores the late old result', async () => {
  const h = await setup(), release = h.hold(a);
  h.state().addTracks([a, b], true); await drain();
  assert.equal(h.state().playing, false);
  assert.equal(h.state().loading, true);
  h.state().removeFromLib([key(a)]); await drain();
  assert.equal(h.current().title, 'B');
  assert.equal(h.state().playing, true);
  release(); await drain();
  assert.ok(h.plays.every((src) => src.endsWith('/BV-B')));
});

test('pause during resolution then delete does not autoplay the successor', async () => {
  const h = await setup(), release = h.hold(a);
  h.state().addTracks([a, b], true); await drain();
  h.state().pause(); h.state().removeFromLib([key(a)]);
  release(); await drain();
  assert.equal(h.current().title, 'B');
  assert.equal(h.state().playing, false);
  assert.equal(h.plays.length, 0);
});

test('latest pause intent wins even before its media event reaches the store', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  h.audios[0].silentPause = true;
  h.state().pause();
  assert.equal(h.state().playing, true, 'simulate a delayed pause event');
  const playCount = h.plays.length;
  h.state().removeFromLib([key(a)]); await drain();
  assert.equal(h.state().playing, false);
  assert.equal(h.plays.length, playCount);
});

test('queue Clear undo cannot restore a song subsequently removed from the library', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  h.state().clear();
  assert.ok(h.state().clearedBackup);
  h.state().removeFromLib([key(a)]);
  h.state().undoClear();
  assert.deepEqual(h.queue(), []);
  assert.equal(h.state().clearedBackup, null);
  assert.ok(h.state().lib[key(b)]);
});

test('playlist removal alone keeps queue; deleting a playlist removes only unshared songs', async () => {
  const h = await setup(), first = h.state().createPlaylist('first'), second = h.state().createPlaylist('second');
  h.state().addTracks([a, b, c], true, first); await drain();
  h.state().addToPlaylist(second, [b]); h.state().toggleFav(c);
  h.state().removeFromPlaylist(first, key(a));
  assert.deepEqual(h.queue(), ['A', 'B', 'C']);
  h.state().addToPlaylist(first, [a]); h.state().deletePlaylist(first); await drain();
  assert.deepEqual(h.queue(), ['B', 'C']);
  assert.equal(h.state().lib[key(a)], undefined);
  assert.ok(h.state().lib[key(b)] && h.state().lib[key(c)]);
});

test('clearing imported playlists cleans queue orphans and preserves local/shared songs', async () => {
  const h = await setup(), imported = h.state().createPlaylist('imported'), local = h.state().createPlaylist('local');
  h.state().bindPlaylistBili(imported, 'fixture-folder', 'import');
  h.state().addTracks([a, b], true, imported); await drain();
  h.state().addToPlaylist(local, [b, c]); h.state().enqueue(c);
  h.state().clearPlaylists('synced'); await drain();
  assert.deepEqual(h.queue(), ['B', 'C']);
  assert.equal(h.state().playlists.length, 1);
  assert.equal(h.state().playlists[0].id, local);
});

test('clear all music cancels pending audio, clears undo/error state and persists an empty queue', async () => {
  // 直接清库分别覆盖正在出声和解析在途，不能只依赖先清队列已经停播的场景。
  for (const resolving of [false, true]) {
    const direct = await setup(), finish = resolving ? direct.hold(a) : () => {};
    direct.state().addTracks([a, b], true); await drain();
    const playCount = direct.plays.length;
    direct.state().clearLibrary(); finish(); await drain();
    assert.deepEqual(direct.queue(), []);
    assert.equal(direct.state().libOrder.length, 0);
    assert.equal(direct.state().currentId, null);
    assert.equal(direct.state().playing, false);
    assert.equal(direct.state().loading, false);
    assert.equal(direct.audios[0].paused, true);
    assert.equal(direct.audios[0].src, '');
    assert.equal(direct.plays.length, playCount, 'late resolve must not restart cleared music');
  }
  const h = await setup(), release = h.hold(a);
  h.state().addTracks([a, b], true); await drain();
  h.state().clear();
  h.set({ error: 'old error', savedSeek: 73 });
  h.state().clearLibrary(); h.state().undoClear(); release(); await drain();
  assert.deepEqual(h.queue(), []);
  assert.equal(h.state().currentId, null);
  assert.equal(h.state().libOrder.length, 0);
  assert.equal(h.state().error, null);
  assert.equal(h.state().savedSeek, null);
  assert.equal(h.state().playing, false);
  assert.equal(h.state().loading, false);
  assert.equal(h.engine.hasPlayIntent(), false);
  assert.equal(h.plays.length, 0);
  const restored = await setup(JSON.parse(h.storage.get('bmuisc.snapshot.v3')));
  assert.deepEqual(restored.queue(), []);
  assert.equal(restored.state().libOrder.length, 0);
});

test('old 143-entry snapshot becomes 23 unique tracks and preserves merged current progress', async () => {
  const items = Array.from({ length: 23 }, (_, i) => song(String(i)));
  const tracks = Array.from({ length: 143 }, (_, i) => ({ ...items[i % 23], uid: `old-${i}` }));
  const h = await setup(snapshot(tracks, items, 'old-142'));
  assert.equal(h.state().tracks.length, 23);
  assert.equal(h.state().currentId, 'old-4');
  assert.equal(h.state().position, 73);
  assert.equal(h.state().savedSeek, 73);
  assert.equal(h.state().playing, false);
  assert.equal(h.plays.length, 0);
  h.state().play(); await drain();
  assert.equal(h.audios[0].currentTime, 73);
});

test('modern snapshots discard library orphans and duplicate collection keys without resurrecting music', async () => {
  const raw = snapshot([{ ...a, uid: 'a' }, { ...b, uid: 'b' }, { ...c, uid: 'c' }], [a, c], 'b');
  raw.favs = [key(a), key(a), key(b)];
  raw.playlists = [{ id: 'p', name: 'p', keys: [key(c), key(c), key(b)] }];
  const h = await setup(raw);
  assert.deepEqual(h.queue(), ['A', 'C']);
  assert.equal(h.current().title, 'C');
  assert.equal(h.state().position, 0);
  assert.equal(h.state().favs.length, 1);
  assert.equal(h.state().playlists[0].keys.length, 1);
  const empty = await setup(snapshot(raw.tracks, [], 'b'));
  assert.deepEqual(empty.queue(), []);
  assert.equal(empty.state().currentId, null);
  assert.equal(empty.state().libOrder.length, 0);
});

test('v1/v2 restoration keeps valid songs and stays paused after deduplication', async () => {
  const tracks = [{ ...a, uid: 'a' }, { ...a, uid: 'copy' }, { ...b, uid: 'b' }];
  const v1 = await setup({ tracks, currentId: 'copy', position: 27, mode: 'one' }, 1);
  assert.deepEqual(v1.queue(), ['A', 'B']);
  assert.equal(v1.state().libOrder.length, 2);
  assert.equal(v1.state().position, 27);
  const v2 = await setup(snapshot(tracks, [b], 'copy'), 2);
  assert.deepEqual(v2.queue(), ['B']);
  assert.equal(v2.state().position, 0);
  assert.equal(v1.plays.length + v2.plays.length, 0);
});

test('queue-only remove shares paused/empty cleanup behavior and preserves the library', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain(); h.state().pause();
  h.state().remove(h.state().currentId); await drain();
  assert.deepEqual(h.queue(), ['B']);
  assert.equal(h.state().playing, false);
  assert.equal(h.state().libOrder.length, 2);
  h.state().remove(h.state().currentId);
  assert.deepEqual(h.queue(), []);
  assert.equal(h.state().savedSeek, null);
  assert.equal(h.state().currentId, null);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
  }
  console.log(`${tests.length - failed}/${tests.length} queue behavior checks passed`);
  if (failed) process.exitCode = 1;
})();
