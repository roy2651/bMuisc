// Run: node scripts/verify-images.cjs. No network, account, or user data access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, mocks) {
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, URL, require: (id) => {
    if (!(id in mocks)) throw Error(`Unexpected dependency: ${id}`);
    return mocks[id];
  } });
  return exports;
}
const util = load('src/util.ts', {});
let count = 0;
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
test('all known image paths and protocol-relative sources upgrade to HTTPS', () => {
  assert.equal(util.imageUrl('http://i0.hdslb.com/bfs/face/avatar.jpg'), 'https://i0.hdslb.com/bfs/face/avatar.jpg');
  assert.equal(util.imageUrl('//i1.hdslb.com/other/avatar.png'), 'https://i1.hdslb.com/other/avatar.png');
  assert.equal(util.thumbUrl('http://i0.hdslb.com/bfs/face/avatar.gif', 'lg'), 'https://i0.hdslb.com/bfs/face/avatar.gif');
  assert.equal(util.imageUrl('https://example.com/a?hdslb.com'), 'https://example.com/a?hdslb.com');
  assert.equal(util.thumbUrl('https://evilhdslb.com/bfs/a.jpg', 'sm'), 'https://evilhdslb.com/bfs/a.jpg');
});
test('thumbnail suffix applies to pathname and preserves query/hash', () => {
  const u = new URL(util.thumbUrl('http://i0.hdslb.com/bfs/face/a.jpg@old?x=1#tag', 'sm'));
  assert.equal(u.pathname, '/bfs/face/a.jpg@256w_256h_1c.webp');
  assert.equal(u.search, '?x=1'); assert.equal(u.hash, '#tag');
});
function widget() {
  let state = null;
  const m = load('src/components/ThumbImg.tsx', {
    react: { useState: () => [state, (next) => { state = typeof next === 'function' ? next(state) : next; }] },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    '../util': util, './icons': { IconMusic: 'music' },
  });
  return (props) => m.default({ className: 'avatar', ...props });
}
test('thumbnail failure falls back to HTTPS original then user placeholder', () => {
  const render = widget(), props = { cover: 'http://i0.hdslb.com/bfs/face/a.jpg', size: 'sm', fallback: 'user' };
  let el = render(props); assert.equal(el.type, 'img');
  assert.equal(el.props.referrerPolicy, 'no-referrer');
  assert.equal(el.props.src, 'https://i0.hdslb.com/bfs/face/a.jpg@256w_256h_1c.webp');
  el.props.onError(); el = render(props);
  assert.equal(el.props.src, 'https://i0.hdslb.com/bfs/face/a.jpg');
  el.props.onError(); el = render(props);
  assert.equal(el.type, 'span'); assert.equal(el.props.children, 'user');
  assert.equal(el.props.role, 'img');
});
test('new source retries normally after previous source failed', () => {
  const render = widget(); let el = render({ cover: 'https://example.com/broken.jpg' });
  el.props.onError(); assert.equal(render({ cover: 'https://example.com/broken.jpg' }).type, 'span');
  el = render({ cover: 'https://i0.hdslb.com/bfs/face/new.jpg' });
  assert.equal(el.type, 'img'); assert(el.props.src.includes('new.jpg'));
});
test('missing image shows placeholder without empty src request and retains drag region', () => {
  const render = widget(), el = render({ cover: null, dragRegion: true });
  assert.equal(el.type, 'span'); assert.equal(el.props['data-tauri-drag-region'], '');
  assert.equal(el.props.src, undefined);
});
console.log(`${count} image regression cases passed`);

