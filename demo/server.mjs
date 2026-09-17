// bMuisc M0 音频解析演示服务（零依赖，Node >= 18）
//
// 用法：node demo/server.mjs
// 然后浏览器打开 http://127.0.0.1:8787 ，粘贴 B 站视频链接或 BV 号。
//
// 架构对应 docs/m0-findings.md：
//   1) API 匿名直调（仅需 UA，概率性 -400 内置重试）
//   2) 本地媒体代理采用「注册表模式」：只有解析流程登记过的流 URL 才会被
//      代理转发，不提供任意 URL 代理；统一补 UA/Referer、透传 Range。
//   3) 实测修正（PCDN 节点不稳定）：
//      - mcdn 节点对开放式 Range（bytes=0-）返回 200 且中途断流 → 代理把
//        开放式 Range 切成有界分块（保证 206）；
//      - 每条流注册 baseUrl + backupUrl 多个候选，官方镜像（bilivideo.com /
//        akamaized.net）优先，失败自动轮替；
//      - 客户端断开用 res.on('close') + writableEnded 检测并中止上游。
//   4) 请求日志只记录 host + Range + 状态码 + 字节数，不记录带签名的完整地址。

import http from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PORT = Number(process.env.PORT || 8787);
const CHUNK = 1024 * 1024; // 开放式 Range 切块大小：1MB
const INDEX_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'));

// ---------- 注册表与请求日志 ----------

const registry = new Map(); // key -> { urls: string[], kind }
let keySeq = 0;
const requestLog = []; // { time, kind, host, range, status, bytes }

function isOfficialCdn(url) {
  const h = new URL(url).host;
  return h.endsWith('bilivideo.com') || h.includes('akamaized.net');
}

function register(urls, kind) {
  const key = 's' + (++keySeq);
  // 官方 CDN 候选优先，其余（mcdn/PCDN）排后作回退
  const unique = [...new Set(urls)];
  unique.sort((a, b) => Number(isOfficialCdn(b)) - Number(isOfficialCdn(a)));
  registry.set(key, { urls: unique, kind });
  return key;
}

function log(kind, url, range, status, bytes) {
  const host = new URL(url).host;
  requestLog.push({ time: new Date().toLocaleTimeString(), kind, host, range: range || '-', status: String(status), bytes });
  if (requestLog.length > 200) requestLog.shift();
  console.log(`[${requestLog.at(-1).time}] ${kind} ${host} range=${requestLog.at(-1).range} -> ${requestLog.at(-1).status} ${bytes}B`);
}

// ---------- B 站接口（匿名 + 有限重试） ----------

async function biliJson(url, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j.code === 0) return j;
    last = j;
    console.log(`  [bili] 第${i}次尝试 code=${j.code} ${j.message}`);
    if (i < tries) await new Promise(ok => setTimeout(ok, 800));
  }
  throw new Error(`接口返回 ${last.code} ${last.message}（已重试 ${tries} 次）`);
}

function extractBv(input) {
  const m = String(input).match(/BV[0-9A-Za-z]{10}/);
  if (!m) throw new Error('输入中没有找到合法的 BV 号');
  return m[0];
}

async function resolveView(bv) {
  const { data } = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
  const season = data.ugc_season ? {
    title: data.ugc_season.title,
    episodes: data.ugc_season.sections.flatMap(s => s.episodes ?? [])
      .map(e => ({ bvid: e.bvid, cid: e.cid, title: e.title, duration: e.duration }))
      .filter(e => e.bvid && e.cid),
  } : null;
  return {
    bvid: data.bvid,
    title: data.title,
    owner: data.owner.name,
    cover: data.pic.replace(/^http:/, 'https:'),
    duration: data.duration,
    pages: (data.pages ?? [{ page: 1, part: data.title, cid: data.cid, duration: data.duration }])
      .map(p => ({ page: p.page, part: p.part, cid: p.cid, duration: p.duration })),
    season,
  };
}

async function resolveStreams(bv, cid) {
  const { data } = await biliJson(`https://api.bilibili.com/x/player/playurl?bvid=${bv}&cid=${cid}&qn=64&fnval=16`);
  const dash = data.dash;
  if (!dash) throw new Error('该内容未返回 DASH 分轨');
  const audio = (dash.audio ?? [])
    .map(s => ({ key: register([s.baseUrl, ...(s.backupUrl ?? [])], 'audio'), id: s.id, codecs: s.codecs, bandwidth: s.bandwidth }))
    .sort((a, b) => b.bandwidth - a.bandwidth);
  const video = (dash.video ?? [])
    .map(s => ({ codecs: s.codecs, width: s.width, height: s.height, bandwidth: s.bandwidth }))
    .sort((a, b) => b.bandwidth - a.bandwidth); // 仅作展示，音频模式下不注册、不传输任何视频流
  return { audio, video };
}

// ---------- 媒体代理（注册表放行 + 分块 Range + 候选轮替） ----------

// 开放式 Range（bytes=N-）切成有界请求；有界/后缀 Range 原样透传
function normalizeRange(range) {
  if (!range) return undefined;
  const m = /^bytes=(\d+)-(\d*)\s*$/.exec(range);
  if (!m || m[2] !== '') return range;
  const start = Number(m[1]);
  return `bytes=${start}-${start + CHUNK - 1}`;
}

async function proxyStream(key, clientReq, clientRes) {
  const entry = registry.get(key);
  if (!entry) {
    clientRes.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    clientRes.end('未注册的流（请先解析）');
    return;
  }
  const ac = new AbortController();
  clientRes.on('close', () => { if (!clientRes.writableEnded) ac.abort(); }); // 客户端提前断开才中止上游
  const range = clientReq.headers.range;
  const headers = { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' };
  const upstreamRange = normalizeRange(range);
  if (upstreamRange) headers.Range = upstreamRange;

  for (const url of entry.urls) {
    try {
      const up = await fetch(url, { headers, signal: ac.signal });
      if (up.status >= 400 && up.status !== 416) throw new Error('上游状态 ' + up.status);

      let bytes = 0;
      const out = { 'Content-Type': up.headers.get('content-type') || 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      for (const h of ['Content-Length', 'Content-Range']) if (up.headers.get(h)) out[h] = up.headers.get(h);
      clientRes.writeHead(up.status, out);
      if (up.body) {
        const stream = Readable.fromWeb(up.body);
        stream.on('data', chunk => { bytes += chunk.length; });
        stream.pipe(clientRes);
        await new Promise(ok => {
          stream.on('end', ok); stream.on('error', ok);
          if (!clientRes.writableEnded) clientRes.on('close', ok);
        });
      } else {
        clientRes.end();
      }
      log(entry.kind, url, range, up.status, bytes);
      return;
    } catch (err) {
      log(entry.kind, url, range, 'ERR', 0);
      if (clientRes.headersSent) { clientRes.destroy(); return; } // 流中失败无法换源，交给客户端重试
      if (ac.signal.aborted) return;
      // 未发出响应头 → 尝试下一个候选地址
    }
  }
  clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  clientRes.end('所有候选地址拉流失败（地址可能已过期，请重新获取音频流）');
}

// ---------- HTTP 服务 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
    } else if (url.pathname === '/api/resolve') {
      const bv = extractBv(url.searchParams.get('input'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(await resolveView(bv)));
    } else if (url.pathname === '/api/streams') {
      const bv = extractBv(url.searchParams.get('bv'));
      const cid = url.searchParams.get('cid');
      if (!/^\d+$/.test(cid ?? '')) throw new Error('cid 无效');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(await resolveStreams(bv, cid)));
    } else if (url.pathname === '/log') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(requestLog.slice(-50).reverse()));
    } else if (url.pathname.startsWith('/audio/')) {
      await proxyStream(url.pathname.slice('/audio/'.length), req, res);
    } else {
      res.writeHead(404); res.end();
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`bMuisc M0 demo 已启动: http://127.0.0.1:${PORT}`);
  console.log('仅监听 127.0.0.1；代理只放行解析得到的流地址（官方 CDN 候选优先）。');
});
