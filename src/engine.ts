// 媒体引擎：统一管理 <audio> 元素与解析命令的调用。
// 每次加载曲目使用操作编号（token）隔离异步竞争，旧请求的结果一律丢弃。
//
// 秒切设计：双 <audio> 元素轮换。当前曲目开播后，播放控制器按循环模式调
// prefetchTrack 预解析下一首并让备胎元素预缓冲头部；切歌命中预取时直接换元素
// 开播（毫秒级出声），未命中走常规解析兜底。签名地址实测约 25 分钟有效，
// 预取超过 TTL 视为过期丢弃（docs/m0-findings.md §2）。

import { proxyPort, resolveStreams, type StreamItem } from './api';

export interface MediaStatePatch {
  playing?: boolean;
  loading?: boolean;
  position?: number;
  duration?: number;
  error?: string | null;
}

let audio: HTMLAudioElement | null = null;
let spare: { el: HTMLAudioElement; bvid: string; cid: number; at: number } | null = null;
let recycledEl: HTMLAudioElement | null = null; // 切换后腾出的旧元素，留给下次预取复用
let port = 0;
let token = 0; // 操作编号：每次 load/stop 递增
let preToken = 0; // 预取操作编号：与主加载互不干扰，仅防旧预取覆盖新预取
let loadedToken = -1; // 当前 audio.src 对应的编号
let loadedBvid = '';
let loadedCid = -1;
let pendingSeek: number | null = null;
const PREFETCH_TTL = 15 * 60 * 1000; // 预取有效期（地址实测约 25 分钟，取一半留裕量）

type Reporter = (patch: MediaStatePatch) => void;
let reporter: Reporter = () => {};
export const hooks: { ended?: () => void } = {};

function report(patch: MediaStatePatch) {
  reporter(patch);
}

export function bindReporter(fn: Reporter) {
  reporter = fn;
}

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
const srcNodes = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

function makeAudio(): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'auto';
  // 频谱分析要求音频以 CORS 模式加载（本地代理已允许），必须在首次设 src 前声明
  el.crossOrigin = 'anonymous';

  // 事件只对当前生效元素上报：预取备胎的缓冲事件不影响界面状态
  el.addEventListener('timeupdate', () => {
    if (el === audio) report({ position: el.currentTime });
  });
  el.addEventListener('durationchange', () => {
    if (el === audio && isFinite(el.duration)) report({ duration: el.duration });
  });
  el.addEventListener('loadedmetadata', () => {
    if (el === audio && pendingSeek != null && isFinite(pendingSeek)) {
      el.currentTime = pendingSeek;
      pendingSeek = null;
    }
  });
  // play 事件在请求播放时立即触发（此刻往往还在缓冲）；真正出声是 playing 事件。
  // loading 的清除和置回都挂在缓冲状态上，切歌/拖进度时加载提示才能覆盖到出声前。
  el.addEventListener('play', () => {
    if (el === audio) report({ playing: true });
  });
  el.addEventListener('playing', () => {
    if (el === audio) report({ playing: true, loading: false });
  });
  el.addEventListener('waiting', () => {
    if (el === audio) report({ loading: true });
  });
  el.addEventListener('pause', () => {
    if (el === audio) report({ playing: false, loading: false });
  });
  el.addEventListener('ended', () => {
    if (el === audio) hooks.ended?.();
  });
  el.addEventListener('error', () => {
    if (el !== audio || loadedToken !== token || !el.error) return; // 主动清空 src 的中断不算错误
    report({
      playing: false,
      loading: false,
      error: `播放出错（代码 ${el.error.code}）：节点不稳定或地址过期，可重试或切换曲目`,
    });
  });
  return el;
}

export async function initEngine(): Promise<void> {
  port = await proxyPort();
  audio = makeAudio();
}

// 建立 WebAudio 分析链路：媒体输出接入 AnalyserNode。任何失败只降级频谱，不影响播放；
// 一旦 createMediaElementSource 成功，输出已进入音频图，异常路径必须保证仍连回 destination。
function ensureAnalyser(): void {
  if (!audio) return;
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      analyser.connect(audioCtx.destination);
    } catch {
      audioCtx = null; // AudioContext 不可用：保持普通播放，频谱走合成模式
      analyser = null;
      return;
    }
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
  if (srcNodes.has(audio)) return;
  try {
    const src = audioCtx.createMediaElementSource(audio);
    try {
      src.connect(analyser!);
    } catch {
      try {
        src.connect(audioCtx.destination); // 分析链路失败：直连保住出声
      } catch {
        /* 音频图异常，无法回退 */
      }
      analyser = null;
    }
    srcNodes.set(audio, src);
  } catch {
    /* 媒体源创建失败：保持普通播放 */
  }
}

function clearElement(el: HTMLAudioElement) {
  el.pause();
  el.removeAttribute('src');
  el.load();
}

export async function loadTrack(bvid: string, cid: number, seekTo?: number): Promise<void> {
  if (!audio) throw new Error('引擎未就绪');
  const my = ++token;
  report({ loading: true, error: null });

  // 同曲重播（单曲循环 / 重复点播当前曲目）：无需解析，直接定位开播
  if (loadedBvid === bvid && loadedCid === cid && audio.src) {
    loadedToken = my;
    audio.currentTime = seekTo ?? 0;
    ensureAnalyser();
    await audio.play();
    return;
  }

  // 命中预取：备胎元素已缓冲好头部，直接换元素开播（毫秒级出声）
  if (spare && spare.bvid === bvid && spare.cid === cid && Date.now() - spare.at < PREFETCH_TTL) {
    const prev = audio;
    audio = spare.el;
    spare = null;
    clearElement(prev);
    recycledEl = prev; // 旧元素留给下次预取复用，避免长期泄漏
    loadedToken = my;
    loadedBvid = bvid;
    loadedCid = cid;
    pendingSeek = seekTo ?? null;
    // 备胎预取阶段元数据已就绪（loadedmetadata 已在非激活状态被忽略），这里手动补：
    if (audio.readyState >= 1 && pendingSeek != null) {
      audio.currentTime = pendingSeek;
      pendingSeek = null;
    }
    if (isFinite(audio.duration)) report({ duration: audio.duration }); // 同理补时长
    ensureAnalyser();
    await audio.play();
    return;
  }

  // 常规路径：解析 → 挂 src → 播放
  try {
    const info = await resolveStreams(bvid, cid);
    if (my !== token) return; // 旧结果丢弃
    const best: StreamItem | undefined = info.audio[0];
    if (!best) throw new Error('没有可用音轨');
    pendingSeek = seekTo ?? null;
    loadedToken = my;
    loadedBvid = bvid;
    loadedCid = cid;
    audio.src = `http://127.0.0.1:${port}/audio/${best.key}`;
    ensureAnalyser();
    await audio.play();
  } catch (e) {
    if (my !== token) return;
    const msg = e instanceof Error ? e.message : String(e);
    report({ loading: false, playing: false, error: `加载失败：${msg}` });
    throw e;
  }
}

/// 预解析并预缓冲下一首：失败静默（切歌时自然回退到常规解析路径）
export async function prefetchTrack(bvid: string, cid: number): Promise<void> {
  if (spare && spare.bvid === bvid && spare.cid === cid) return; // 已是目标
  const my = ++preToken;
  try {
    const info = await resolveStreams(bvid, cid);
    if (my !== preToken) return;
    const best: StreamItem | undefined = info.audio[0];
    if (!best) return;
    if (spare && spare.bvid === bvid && spare.cid === cid) return;
    let el = spare?.el ?? recycledEl;
    recycledEl = null;
    if (!el || el === audio) el = makeAudio();
    el.volume = audio?.volume ?? 0.8;
    spare = { el, bvid, cid, at: Date.now() };
    clearElement(el);
    el.src = `http://127.0.0.1:${port}/audio/${best.key}`;
    el.load(); // preload=auto：只预取头部数据
  } catch {
    /* 预取失败不影响当前播放 */
  }
}

/// 播放控制器查询当前预取目标（随机模式自动切歌时复用预取时定好的选择）
export function getPrefetched(): { bvid: string; cid: number } | null {
  if (!spare || Date.now() - spare.at >= PREFETCH_TTL) return null;
  return { bvid: spare.bvid, cid: spare.cid };
}

export function togglePlay() {
  if (!audio || !audio.src) return;
  if (audio.paused) {
    ensureAnalyser(); // 用户手势内恢复上下文，频谱随播放可用
    void audio.play();
  } else {
    audio.pause();
  }
}

export function hasSource(): boolean {
  return !!(audio && audio.src); // 重启恢复后 audio 尚未加载，播放前需据此判断
}

// 播放器可视化取数：真实 FFT 可用时返回频谱，否则 null（组件用时间驱动波浪兜底）
export function getVizData(): Uint8Array | null {
  if (!analyser || !audioCtx || audioCtx.state !== 'running') return null;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  if (!data.some((v) => v > 0)) return null; // 上下文未真正出声
  return data;
}

export function seek(t: number) {
  if (audio && audio.src && isFinite(t)) audio.currentTime = t;
}

export function setVolume(v: number) {
  const vol = Math.min(1, Math.max(0, v));
  if (audio) audio.volume = vol;
  if (spare) spare.el.volume = vol; // 备胎同步，切歌瞬间音量无缝
}

export function stopAndRelease() {
  token++;
  preToken++;
  spare = null;
  recycledEl = null;
  if (!audio) return;
  clearElement(audio);
  report({ playing: false, loading: false, position: 0, duration: 0 });
}
