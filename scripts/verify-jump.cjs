// Run with: node scripts/verify-jump.cjs
// Real store/engine + real videoJump module, isolated snapshots and fake media/network/opener.
// Covers: videoUrl rules (p/t), open-then-pause ordering, failure notify, debounce, resolving-window jump,
// stale-callback guard (manual switch/replay during open), auto-advance still pausing,
// queue metadata sync after re-parse (page) and favorites not erasing it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const key = (t) => `${t.bvid}:${t.cid}`;
const song = (name, cid = 1, page) => ({ bvid: `BV-${name}`, cid, title: name, up: 'fixture', cover: '', duration: 300, page });
const [a, b] = [song('A'), song('B', 1, 3)];

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

// 每个用例独立 setup：videoJump 模块级防抖时钟与 lastJumpAt 都是全新实例
async function setup() {
  const storage = new Map(), audios = [], pending = new Map(), plays = [];
  let openerFail = false;
  let slowOpen = false; // 受控挂起：复现 openUrl 等待期间的用户操作
  let openGate = null;
  const opened = [];
  let fakeNow = 1000;
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
      return pending.get(bvid)?.promise ?? stream(bvid);
    } },
  }, { Audio: FakeAudio });
  const storeExports = load('src/store.ts', { zustand: require('zustand'), './engine': engine }, {
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    setTimeout: () => 1, clearTimeout() {},
  });
  const jumpExports = load('src/videoJump.ts', {
    '@tauri-apps/plugin-opener': { openUrl: async (url) => {
      if (openerFail) throw new Error('no handler');
      opened.push(url);
      if (slowOpen) await new Promise((resolve) => { openGate = resolve; });
    } },
    './store': storeExports,
  }, { Date: { now: () => fakeNow } }); // 防抖时钟可控：vm 内 Date 只有 Date.now 一个用途
  await engine.initEngine();
  storeExports.usePlayer.getState().restore();
  storeExports.usePlayer.setState({ mode: 'one' }); // 不让无关预取进来
  return {
    state: storeExports.usePlayer.getState, set: storeExports.usePlayer.setState,
    videoUrl: jumpExports.videoUrl, jumpToVideo: jumpExports.jumpToVideo,
    audios, opened, plays,
    fail: () => { openerFail = true; }, tick: (ms) => { fakeNow += ms; },
    delayOpens: () => { slowOpen = true; }, releaseOpen: () => { slowOpen = false; if (openGate) { const g = openGate; openGate = null; g(); } },
    current: () => storeExports.usePlayer.getState().tracks.find((t) => t.uid === storeExports.usePlayer.getState().currentId),
    hold(item) {
      let resolve;
      const promise = new Promise((yes) => { resolve = yes; });
      pending.set(item.bvid, { promise });
      return () => { pending.delete(item.bvid); resolve(stream(item.bvid)); };
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('videoUrl: single-P bare, page 1 omitted, multi-P p param, progress floored and gated at 5s', () => {
  const h = setupSync();
  assert.equal(h.videoUrl({ bvid: 'BV1', cid: 1 }), 'https://www.bilibili.com/video/BV1/');
  assert.equal(h.videoUrl({ bvid: 'BV1', cid: 1, page: 1 }, 42), 'https://www.bilibili.com/video/BV1/?t=42');
  assert.equal(h.videoUrl({ bvid: 'BV1', cid: 1, page: 8 }, 225.7), 'https://www.bilibili.com/video/BV1/?p=8&t=225');
  assert.equal(h.videoUrl({ bvid: 'BV1', cid: 1, page: 8 }, 4), 'https://www.bilibili.com/video/BV1/?p=8');
  assert.equal(h.videoUrl({ bvid: 'BV1', cid: 1, page: 8 }, 5), 'https://www.bilibili.com/video/BV1/?p=8&t=5');
});

test('jumping the current multi-P track opens with p+t and pauses, keeping progress', async () => {
  const h = await setup();
  h.state().addTracks([song('A', 1, 8), b], true); await drain();
  h.state().seekTo(42); h.audios[0].emit('timeupdate');
  await h.jumpToVideo(h.current());
  assert.deepEqual(h.opened, ['https://www.bilibili.com/video/BV-A/?p=8&t=42']);
  assert.equal(h.state().playing, false);
  assert.equal(h.audios[0].paused, true);
  assert.equal(h.state().position, 42, '暂停保留进度，不清零');
});

test('jumping a non-current row has no progress param but still pauses the playing track', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  const row = h.state().tracks.find((t) => t.bvid === b.bvid);
  await h.jumpToVideo(row);
  assert.deepEqual(h.opened, ['https://www.bilibili.com/video/BV-B/?p=3']);
  assert.equal(h.state().playing, false);
  assert.equal(h.state().currentId, h.state().tracks[0].uid, '跳转不改队列/当前曲');
});

test('opener failure notifies and never pauses the music', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  h.fail();
  await h.jumpToVideo(h.current());
  assert.deepEqual(h.opened, []);
  assert.equal(h.state().toast?.text, '打开浏览器失败，请重试');
  assert.equal(h.state().playing, true);
  assert.equal(h.audios[0].paused, false);
});

test('rapid double jump is debounced into one tab; later jumps go through', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  await Promise.all([h.jumpToVideo(h.current()), h.jumpToVideo(h.current())]);
  assert.equal(h.opened.length, 1);
  h.tick(800); // 刚好到防抖窗口边界外
  await h.jumpToVideo(h.current());
  assert.equal(h.opened.length, 2);
});

test('jump with an empty queue opens without side effects', async () => {
  const h = await setup();
  await h.jumpToVideo({ bvid: 'BV1', cid: 1, page: 2 });
  assert.deepEqual(h.opened, ['https://www.bilibili.com/video/BV1/?p=2']);
  assert.equal(h.state().currentId, null);
  assert.equal(h.plays.length, 0);
});

test('jump during source resolution pauses intent: late resolve must not autoplay', async () => {
  const h = await setup(), release = h.hold(a);
  h.state().addTracks([a, b], true); await drain();
  assert.equal(h.state().loading, true);
  await h.jumpToVideo(h.current());
  assert.deepEqual(h.opened, ['https://www.bilibili.com/video/BV-A/']);
  release(); await drain();
  assert.equal(h.plays.length, 0, '解析完成后不得自动出声');
  assert.equal(h.state().playing, false);
  assert.equal(h.state().loading, false);
  assert.equal(h.current().title, 'A');
});

// —— 过期回调守卫（intentSeq）：openUrl 等待期间出现更新的用户播放意图时，旧回调不得覆盖 ——

test('stale jump callback does not pause a manual switch made while opening', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  h.delayOpens();
  const jump = h.jumpToVideo(h.current()); // 不 await：openUrl 挂起在途
  await drain();
  h.state().playFrom('all', key(b)); await drain(); // 等待期用户切到 B
  assert.equal(h.state().playing, true);
  h.releaseOpen(); await jump; await drain();
  assert.equal(h.state().playing, true, '过期跳转回调不得暂停切换后的新播放');
  assert.equal(h.audios[0].paused, false);
  assert.deepEqual(h.opened, ['https://www.bilibili.com/video/BV-A/']);
});

test('stale jump callback does not pause a manual replay of the same track', async () => {
  const h = await setup();
  h.state().addTracks([a], true); await drain();
  h.state().pause();
  h.delayOpens();
  const jump = h.jumpToVideo(h.current());
  await drain();
  h.state().play(); await drain(); // 等待期重新播放当前曲
  assert.equal(h.state().playing, true);
  h.releaseOpen(); await jump; await drain();
  assert.equal(h.state().playing, true, '过期跳转回调不得暂停重播');
});

test('automatic advance during the jump window still yields to the pause', async () => {
  const h = await setup();
  h.state().addTracks([a, b], true); await drain();
  h.delayOpens();
  const jump = h.jumpToVideo(h.current());
  await drain();
  h.state().next(true); await drain(); // 自然结束的自动接续（one 模式重播），不是新的用户意图
  assert.equal(h.state().playing, true);
  h.releaseOpen(); await jump; await drain();
  assert.equal(h.state().playing, false, '自动接续不递增意图版本，跳转的暂停仍然生效');
});

// —— 队列元数据同步（P2-2）：重新解析补齐 page 后队列副本要跟上，红心重喂旧对象不得抹掉 ——

test('reparsing an old queue entry syncs page into the queue; jump carries p&t', async () => {
  const h = await setup();
  const bare = { bvid: 'BV-A', cid: 1, title: 'A', up: 'fixture', cover: '', duration: 300 };
  h.state().addTracks([bare], true); await drain();
  const uid = h.state().tracks[0].uid;
  assert.equal(h.state().tracks[0].page, undefined);
  h.state().addTracks([{ ...bare, page: 8 }], false, 'all'); await drain(); // 重新解析补上分 P 序号
  assert.equal(h.state().lib[key(bare)].page, 8);
  assert.equal(h.state().tracks[0].page, 8, '队列副本同步刷新（底栏「看视频」读的是队列对象）');
  assert.equal(h.state().tracks[0].uid, uid, '同步保留队列条目 ID 与位置');
  h.state().seekTo(42); h.audios[0].emit('timeupdate');
  await h.jumpToVideo(h.current());
  assert.deepEqual(h.opened, ['https://www.bilibili.com/video/BV-A/?p=8&t=42']);
  assert.equal(h.state().playing, false);
});

test('re-feeding a page-less object through favorites keeps the known page', async () => {
  const h = await setup();
  const bare = { bvid: 'BV-A', cid: 1, title: 'A', up: 'fixture', cover: '', duration: 300 };
  h.state().addTracks([bare], true); await drain();
  h.state().addTracks([{ ...bare, page: 8 }], false, 'all'); await drain();
  h.state().toggleFav(bare); // 红心把旧队列对象（无 page）重喂进 upsertLib
  assert.equal(h.state().favs.includes(key(bare)), true);
  assert.equal(h.state().lib[key(bare)].page, 8, '旧对象不得抹掉已补齐的分 P 序号');
  assert.equal(h.state().tracks[0].page, 8, '队列副本同样保持新元数据');
});

// —— 撤销清空与「库新队旧」自愈（复审 P2）：曲库提供最新元数据，队列保留 ID / 顺序 / 播放状态 ——

test('undoing a queue clear re-merges latest lib metadata; jump carries p&t', async () => {
  const h = await setup();
  const bare = { bvid: 'BV-A', cid: 1, title: 'A', up: 'fixture', cover: '', duration: 300 };
  h.state().addTracks([bare, b], true); await drain();
  const uids = h.state().tracks.map((t) => t.uid);
  h.state().clear(); // 清空队列（备份存的是旧副本；撤销窗口内重新解析补 page）
  h.state().addTracks([{ ...bare, page: 8 }], false, 'all'); await drain();
  assert.equal(h.state().lib[key(bare)].page, 8, '空队列时只更新曲库');
  h.state().undoClear(); await drain();
  assert.deepEqual(h.state().tracks.map((t) => t.uid), uids, '队列 ID 与顺序保留');
  assert.equal(h.state().tracks[0].page, 8, '撤销恢复合并最新曲库元数据，不带旧副本');
  assert.equal(h.state().currentId, uids[0], '当前项恢复');
  assert.equal(h.state().playing, false, '撤销不重播');
  h.state().seekTo(42); // 无源会话：seekTo 写待定位进度
  await h.jumpToVideo(h.current());
  assert.deepEqual(h.opened, ['https://www.bilibili.com/video/BV-A/?p=8&t=42']);
});

test('a stale queue copy is refreshed even when lib metadata is unchanged', async () => {
  const h = await setup();
  const bare = { bvid: 'BV-A', cid: 1, title: 'A', up: 'fixture', cover: '', duration: 300 };
  h.state().addTracks([bare], true); await drain();
  h.state().addTracks([{ ...bare, page: 8 }], false, 'all'); await drain(); // 正常同步路径
  assert.equal(h.state().tracks[0].page, 8);
  // 人为把队列副本拨回旧数据（模拟撤销恢复旧对象等「库新队旧」路径），再次解析相同
  // 内容：曲库无变化，但落后的队列副本必须被修正
  const uid = h.state().tracks[0].uid;
  h.set({ tracks: [{ ...h.state().tracks[0], page: undefined }] });
  h.state().addTracks([{ ...bare, page: 8 }], false, 'all'); await drain();
  assert.equal(h.state().tracks[0].page, 8, '库无变化时也要补齐落后的队列副本');
  assert.equal(h.state().tracks[0].uid, uid, '修正保留队列条目 ID');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
  }
  console.log(`${tests.length - failed}/${tests.length} video jump checks passed`);
  if (failed) process.exitCode = 1;
})();

// videoUrl 是纯函数，第一条用例不需要引擎/store 的 await 装配；'./store' 给哑实现即可
function setupSync() {
  return load('src/videoJump.ts', {
    '@tauri-apps/plugin-opener': { openUrl: async () => {} },
    './store': { usePlayer: { getState: () => ({}) } },
  }, { Date: { now: () => 0 } });
}
