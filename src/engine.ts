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

export async function initEngine(): Promise<void> {
  port = await proxyPort();
  audio = new Audio();
  audio.preload = 'auto';

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
  if (audio.paused) void audio.play();
  else audio.pause();
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
