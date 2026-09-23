// 媒体引擎：统一管理 <audio> 元素与解析命令的调用。
// 每次加载曲目使用操作编号（token）隔离异步竞争，旧请求的结果一律丢弃。
//
// 秒切设计：双 <audio> 元素轮换。当前曲目开播后，播放控制器按循环模式调
// prefetchTrack 预解析下一首并让备胎元素预缓冲头部；切歌命中预取时直接换元素
// 开播（毫秒级出声），未命中走常规解析兜底。签名地址实测约 25 分钟有效，
// 预取超过 TTL 视为过期丢弃（docs/m0-findings.md §2）。

import { error as logError, info as logInfo } from '@tauri-apps/plugin-log';
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
let wantPlay = true; // 用户最新播放意图：解析完成时是否自动开播（解析期间暂停不被覆盖）
let resolving = false; // 常规解析窗口标记：仅当前会话可置位/清除（新会话入口重置、旧会话完成被 token 门控拦下）
const PREFETCH_TTL = 15 * 60 * 1000; // 预取有效期（地址实测约 25 分钟，取一半留裕量）

type Reporter = (patch: MediaStatePatch) => void;
let reporter: Reporter = () => {};
export const hooks: { ended?: () => void } = {};

// 诊断日志：事件时间线落文件（tauri-plugin-log），复现「暂停了声音还在」等疑难后
// 回头看事件顺序。只记状态 / token / 进度，绝不记媒体 URL（签名后媒体 URL 不落日志）。
function elog(msg: string): void {
  const line = `[engine] ${msg}`;
  console.log(line);
  void logInfo(line).catch(() => {});
}
function elogErr(msg: string): void {
  const line = `[engine] ${msg}`;
  console.error(line);
  void logError(line).catch(() => {});
}

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

  // 事件只对当前生效元素 + 当前加载会话上报：切歌后旧曲目的 ended/进度/暂停
  // 一律作废（旧 ended 会按新曲目的位置跳过队列，旧 timeupdate 会污染新曲目进度）
  // 日志打在会话门控之前：非当前元素（备胎/旧元素）的事件也要留痕，排查「谁在出声」时缺不得
  const role = () => (el === audio ? 'main' : 'spare');
  el.addEventListener('timeupdate', () => {
    if (el === audio && loadedToken === token) report({ position: el.currentTime });
  });
  el.addEventListener('durationchange', () => {
    if (el === audio && loadedToken === token && isFinite(el.duration)) report({ duration: el.duration });
  });
  el.addEventListener('loadedmetadata', () => {
    if (el === audio && loadedToken === token && pendingSeek != null && isFinite(pendingSeek)) {
      el.currentTime = pendingSeek;
      pendingSeek = null;
    }
  });
  // play 事件在请求播放时立即触发（此刻往往还在缓冲）；真正出声是 playing 事件。
  // loading 的清除和置回都挂在缓冲状态上，切歌/拖进度时加载提示才能覆盖到出声前。
  el.addEventListener('play', () => {
    elog(`play ev el=${role()} t=${el.currentTime.toFixed(1)} tok=${token} loaded=${loadedToken}`);
    if (el === audio && loadedToken === token) report({ playing: true });
  });
  el.addEventListener('playing', () => {
    elog(`playing ev el=${role()} t=${el.currentTime.toFixed(1)} tok=${token} loaded=${loadedToken}`);
    // 真正出声：此前的过渡性播放错误（重试已成功）不再有意义，一并清除
    if (el === audio && loadedToken === token) report({ playing: true, loading: false, error: null });
  });
  el.addEventListener('waiting', () => {
    elog(`waiting ev el=${role()} t=${el.currentTime.toFixed(1)}`);
    if (el === audio && loadedToken === token) report({ loading: true });
  });
  el.addEventListener('pause', () => {
    elog(`pause ev el=${role()} t=${el.currentTime.toFixed(1)} tok=${token} loaded=${loadedToken}`);
    if (el === audio && loadedToken === token) report({ playing: false, loading: false });
  });
  el.addEventListener('ended', () => {
    elog(`ended ev el=${role()} t=${el.currentTime.toFixed(1)}`);
    if (el === audio && loadedToken === token) hooks.ended?.();
  });
  el.addEventListener('error', () => {
    if (!el.error) return; // 主动清空 src 的中断不算错误
    elogErr(`error ev el=${role()} code=${el.error.code} t=${el.currentTime.toFixed(1)}`);
    if (el !== audio || loadedToken !== token) return; // 主动清空 src 的中断不算错误
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
  // 上下文没真正跑起来（如系统媒体键触发开播，无用户手势）就不接分析图：
  // 媒体元素一旦接入挂起的音频图会整路静音——宁可频谱降级为合成波浪，不能无声播放
  if (audioCtx.state !== 'running') return;
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

// 统一的开播收尾：遵循最新播放意图；play 被拒绝也要落到明确状态（绝不永远停在「加载中」）。
// 返回 false = 本次源不可用，调用方可回退常规解析。
async function startPlayback(my: number): Promise<boolean> {
  ensureAnalyser();
  if (!wantPlay) {
    // 用户在解析期间按了暂停：停在定位点，不自动开播
    if (audio && pendingSeek != null && isFinite(pendingSeek)) {
      audio.currentTime = pendingSeek;
      pendingSeek = null;
    }
    report({ playing: false, loading: false });
    return true;
  }
  try {
    await audio!.play();
    // WebKit（mac WKWebView）的已知差异：pause() 不总能取消在途的 play()——
    // 缓冲/解析完成瞬间按暂停，排队中的 play 仍可能把元素播起来（Windows 的
    // Chromium 会按规范以 AbortError 取消，走不到这里）。play() 落定后复核
    // 最新播放意图，已暂停就补停，防止「点了暂停声音还在」。
    elog(
      `play() 落定 wantPlay=${wantPlay} mine=${my === token} paused=${audio!.paused} t=${audio!.currentTime.toFixed(1)}`,
    );
    if (!wantPlay && my === token) {
      audio!.pause();
      report({ playing: false, loading: false });
    }
    return true;
  } catch (e) {
    elogErr(`play() 拒绝 name=${e instanceof Error ? e.name : '?'} msg=${e instanceof Error ? e.message : String(e)}`);
    if (my !== token) return true; // 已被更新的加载会话取代：旧拒绝静默作废
    if (!wantPlay) return true; // play() 被 pause() 中断 = 用户暂停意图的预期结果：不报错也不回落重解析
    const msg = e instanceof Error ? e.message : String(e);
    report({ playing: false, loading: false, error: `播放失败：${msg}` });
    return false;
  }
}

// 返回 false = 当前加载会话最终失败（错误已上报）；被更新的会话取代或成功一律 true，
// 调用方据此决定是否回写待定位进度（重试续播）。
export async function loadTrack(bvid: string, cid: number, seekTo?: number): Promise<boolean> {
  if (!audio) throw new Error('引擎未就绪');
  const my = ++token;
  elog(`load bvid=${bvid} cid=${cid} seek=${seekTo ?? '-'} my=${my}`);
  resolving = false; // 新会话接管解析标记：旧会话的在途解析完成时将被 token 门控拦下，无法自行清理
  wantPlay = true; // 主动加载 = 想播；解析期间用户仍可按暂停改写此意图
  report({ loading: true, error: null });

  // 同曲重播（单曲循环 / 重复点播当前曲目）：无需解析，直接定位开播。
  // 媒体已有错误（源失效/节点失败）则不快捷复用，落入常规路径重新解析换源。
  if (loadedBvid === bvid && loadedCid === cid && audio.src && !audio.error) {
    loadedToken = my;
    audio.currentTime = seekTo ?? 0;
    pendingSeek = null; // 已显式定位：清掉可能遗留的待定位（如恢复会话的旧进度），防 loadedmetadata 迟到时覆盖
    if (await startPlayback(my)) return true;
  }

  // 命中预取：备胎元素已缓冲好头部，直接换元素开播（毫秒级出声）。
  // 备胎媒体已有错误（预取阶段网络失败）则弃用，落入常规路径重新解析。
  if (spare && spare.bvid === bvid && spare.cid === cid && Date.now() - spare.at < PREFETCH_TTL && !spare.el.error) {
    elog('load 命中预取，换备胎开播');
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
    if (await startPlayback(my)) return true;
    // 预取元素播放失败：audio 已是备胎，常规路径会在其上重设 src 重新解析
  }

  // 常规路径：解析 → 挂 src → 播放
  try {
    resolving = true; // 标记解析窗口：此间旧元素仍挂着旧源、loadedToken 落后于 token
    const info = await resolveStreams(bvid, cid);
    if (my !== token) return true; // 旧结果丢弃：会话已被取代，不算失败；resolving 已归新会话所有，不得代为清除
    resolving = false;
    const best: StreamItem | undefined = info.audio[0];
    if (!best) throw new Error('没有可用音轨');
    pendingSeek = seekTo ?? null;
    loadedToken = my;
    loadedBvid = bvid;
    loadedCid = cid;
    audio.src = `http://127.0.0.1:${port}/audio/${best.key}`;
    return await startPlayback(my);
  } catch (e) {
    if (my !== token) return true; // 会话已被取代：错误交给新会话的状态，resolving 同样不得代为清除
    resolving = false;
    // 失败终态必须真正静音旧元素：UI 随后显示「已暂停+错误」，若旧源仍在出声，
    // 用户点「播放」会被引擎按暂停分支处理（wantPlay=false），取消重试的自动开播
    audio!.pause();
    const msg = e instanceof Error ? e.message : String(e);
    elogErr(`load 失败 ${msg}`);
    report({ loading: false, playing: false, error: `加载失败：${msg}` });
    return false;
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

// 系统媒体键等外部指令的明确入口：直接设置意图，不是状态翻转。界面按钮读得到
// 完整界面状态，用 toggle 翻转即可；系统指令只有「想播/想停」一个语义，且指令
// 到达与媒体事件回写之间存在异步窗口（store 的 playing 是滞后的）——用状态守卫
// toggle 会错向（暂停指令连到第二次会把刚暂停的元素又播起来）。显式 set 意图
// 天然幂等，并覆盖解析/缓冲窗口：解析完成后 startPlayback 按最新意图决定开播与否。

/// 明确播放：已在播/在途 play 是幂等 no-op；解析窗口只改写意图；终败会话不动
/// 旧源（重试由 store 层 startTrack 承接）。
export function play() {
  if (!audio || !audio.src) return;
  elog(`play 意图 paused=${audio.paused} resolving=${resolving} tok=${token} loaded=${loadedToken}`);
  wantPlay = true;
  // 媒体键场景无用户手势：ensureAnalyser 在上下文未运行时不接分析图（防静音），频谱降级可接受
  ensureAnalyser();
  if (resolving) return; // 解析在途：意图已记录，新源就绪后 startPlayback 自动开播
  if (loadedToken !== token || audio.error) return; // 兜底防线：终败会话/报错媒体的旧源绝不恢复出声（会播错歌或再拒一次）
  if (!audio.paused) return; // 已在播（或 play 已在途）：幂等
  void startPlayback(token);
}

/// 明确暂停：播放/缓冲/解析在途各阶段都安全；连按不会反向恢复播放。
export function pause() {
  if (!audio) return;
  elog(`pause 意图 paused=${audio.paused} resolving=${resolving} tok=${token} loaded=${loadedToken}`);
  wantPlay = false; // 记录暂停意图：进行中的解析完成后不得自动开播
  if (!audio.paused) audio.pause();
  // 解析窗口/失败会话内旧元素的 pause 事件被会话门控丢弃：手动补报，避免界面停留在播放态
  if (loadedToken !== token) report({ playing: false });
}

export function togglePlay() {
  if (!audio || !audio.src) return;
  elog(`toggle paused=${audio.paused} resolving=${resolving} tok=${token} loaded=${loadedToken} err=${audio.error?.code ?? '-'}`);
  if (audio.paused) play();
  else pause();
}

export function hasSource(): boolean {
  return !!(audio && audio.src); // 重启恢复后 audio 尚未加载，播放前需据此判断
}

// 主播放入口专用：src 还挂着，但当前加载会话已终败（解析失败）或媒体已报错——
// 旧源不可直接恢复出声（会播错歌/对坏源再拒一次），调用方应重试当前曲目而非 togglePlay。
// 解析在途（resolving）不算终败：那只需改写播放意图，等新源就绪自动开播。
export function needsReload(): boolean {
  return !!(audio && audio.src && !resolving && (loadedToken !== token || audio.error));
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
  elog(`stopAndRelease my=${token}`);
  resolving = false; // 会话终止：在途解析完成时将被 token 门控拦下，此处代为清理
  if (spare) {
    clearElement(spare.el); // 真正停掉备胎的媒体加载：丢引用不等于停止拉流
    spare = null;
  }
  recycledEl = null;
  if (!audio) return;
  clearElement(audio);
  report({ playing: false, loading: false, position: 0, duration: 0 });
}
