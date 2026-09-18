// 媒体引擎：统一管理 <audio> 元素与解析命令的调用。
// 每次加载曲目使用操作编号（token）隔离异步竞争，旧请求的结果一律丢弃。

import { proxyPort, resolveStreams, type StreamItem } from './api';

export interface MediaStatePatch {
  playing?: boolean;
  loading?: boolean;
  position?: number;
  duration?: number;
  error?: string | null;
}

let audio: HTMLAudioElement | null = null;
let port = 0;
let token = 0; // 操作编号：每次 load/stop 递增
let loadedToken = -1; // 当前 audio.src 对应的编号
let pendingSeek: number | null = null;

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

export async function initEngine(): Promise<void> {
  port = await proxyPort();
  audio = new Audio();
  audio.preload = 'auto';
  // 频谱分析要求音频以 CORS 模式加载（本地代理已允许），必须在首次设 src 前声明
  audio.crossOrigin = 'anonymous';

  audio.addEventListener('timeupdate', () => report({ position: audio!.currentTime }));
  audio.addEventListener('durationchange', () => {
    if (isFinite(audio!.duration)) report({ duration: audio!.duration });
  });
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek != null && isFinite(pendingSeek)) {
      audio!.currentTime = pendingSeek;
      pendingSeek = null;
    }
  });
  audio.addEventListener('play', () => report({ playing: true, loading: false }));
  audio.addEventListener('pause', () => report({ playing: false }));
  audio.addEventListener('ended', () => hooks.ended?.());
  audio.addEventListener('error', () => {
    if (loadedToken !== token || !audio!.error) return; // 主动清空 src 的中断不算错误
    report({
      playing: false,
      loading: false,
      error: `播放出错（代码 ${audio!.error.code}）：节点不稳定或地址过期，可重试或切换曲目`,
    });
  });
}

export async function loadTrack(bvid: string, cid: number, seekTo?: number): Promise<void> {
  if (!audio) throw new Error('引擎未就绪');
  const my = ++token;
  report({ loading: true, error: null });
  try {
    const info = await resolveStreams(bvid, cid);
    if (my !== token) return; // 旧结果丢弃
    const best: StreamItem | undefined = info.audio[0];
    if (!best) throw new Error('没有可用音轨');
    pendingSeek = seekTo ?? null;
    loadedToken = my;
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

// 建立 WebAudio 分析链路：媒体输出接入 AnalyserNode。任何失败只降级频谱，不影响播放；
// 一旦 createMediaElementSource 成功，输出已进入音频图，异常路径必须保证仍连回 destination。
function ensureAnalyser(): void {
  if (!audio) return;
  if (audioCtx) {
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
    return;
  }
  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(audio);
    try {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch {
      try {
        source.connect(audioCtx.destination); // 分析链路失败：直连保住出声
      } catch {
        /* 音频图异常，无法回退 */
      }
      analyser = null;
    }
  } catch {
    audioCtx = null; // AudioContext 不可用：保持普通播放，频谱走合成模式
  }
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
  if (audio) audio.volume = Math.min(1, Math.max(0, v));
}

export function stopAndRelease() {
  token++;
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  report({ playing: false, loading: false, position: 0, duration: 0 });
}
