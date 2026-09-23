// 系统媒体控制：mac 媒体键 / 控制中心（Now Playing 面板）+ Windows SMTC，
// 走标准 MediaSession API（WKWebView、WebView2 均支持）。
// 关键设计：启动即注册 action handler，此后系统指令改经应用内 store 逻辑执行，
// 不再被 WebView 直接作用到 <audio> 元素——既补齐 mac 的播放/暂停/切歌/拖进度，
// 也封住「系统绕过 wantPlay 直接控制元素」的状态歧义（mac「暂停了声音还在」
// 的一类根因：WKWebView 会自动注册 Now Playing，媒体键不经应用逻辑直达元素）。
// 元数据（歌名/UP 主/封面）与播放状态、进度随 store 变化增量同步。
import { info as logInfo } from '@tauri-apps/plugin-log';
import { thumbUrl } from './util';

export interface MediaSessionMeta {
  key: string; // 曲目标识（bvid:cid），判断元数据是否需要重建
  title: string;
  artist: string;
  cover: string | null;
}

// play/pause 由 App 侧按 store 状态守卫（幂等）：若系统在调用 handler 前后
// 还直接动了元素，元素事件已同步写回 store，守卫让二次处理变成无害空转
export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seek(t: number): void;
}

let metaSig = ''; // 已同步的元数据签名（key+title+artist+cover，信息刷新也要跟着换封面）
let lastPosPush = -1; // 上次推送的进度：1 秒内的重复推送跳过（timeupdate 每秒多次）

function mlog(msg: string): void {
  const line = `[media] ${msg}`;
  console.log(line);
  void logInfo(line).catch(() => {});
}

export function initMediaSession(h: MediaSessionHandlers): void {
  if (!('mediaSession' in navigator)) {
    mlog('mediaSession 不可用，跳过注册');
    return;
  }
  // 单个动作注册失败（平台不支持）不应拖垮其余动作与应用启动
  const setHandler = (action: MediaSessionAction, run: (details: MediaSessionActionDetails) => void) => {
    try {
      navigator.mediaSession.setActionHandler(action, run);
    } catch {
      mlog(`动作 ${action} 不受支持，跳过`);
    }
  };
  const via = (name: string, run: () => void) => () => {
    mlog(`系统指令 ${name}`);
    run();
  };
  setHandler('play', via('play', h.play));
  setHandler('pause', via('pause', h.pause));
  setHandler('nexttrack', via('nexttrack', h.next));
  setHandler('previoustrack', via('previoustrack', h.prev));
  setHandler('seekto', (details) => {
    if (typeof details.seekTime === 'number' && isFinite(details.seekTime)) {
      mlog(`系统指令 seekto ${details.seekTime.toFixed(1)}`);
      h.seek(details.seekTime);
    }
  });
  mlog('已注册 play/pause/next/prev/seekto');
}

// store 变化后增量同步：元数据只在曲目/信息变化时重建，进度按 1s 节流推送
export function syncMediaSession(s: {
  track: MediaSessionMeta | null;
  playing: boolean;
  position: number;
  duration: number;
}): void {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.playbackState = s.track ? (s.playing ? 'playing' : 'paused') : 'none';

  const sig = s.track ? `${s.track.key}|${s.track.title}|${s.track.artist}|${s.track.cover ?? ''}` : '';
  if (sig !== metaSig) {
    metaSig = sig;
    if (s.track) {
      const cover = s.track.cover ? thumbUrl(s.track.cover, 'lg') : ''; // 540 方形 webp，够系统面板用
      const type = /\.webp(?:$|\?)/i.test(cover) ? 'image/webp' : /\.gif(?:$|\?)/i.test(cover) ? 'image/gif' : 'image/jpeg';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.track.title,
        artist: s.track.artist,
        artwork: cover ? [{ src: cover, sizes: '540x540', type }] : [],
      });
    } else {
      navigator.mediaSession.metadata = null;
    }
    lastPosPush = -1; // 换曲后强制推一次位置状态
  }

  if (
    s.track &&
    isFinite(s.duration) &&
    s.duration > 0 &&
    isFinite(s.position) &&
    Math.abs(s.position - lastPosPush) >= 1
  ) {
    lastPosPush = s.position;
    try {
      ms.setPositionState({ duration: s.duration, position: Math.min(s.position, s.duration), playbackRate: 1 });
    } catch {
      /* 非法位置状态忽略（WebKit 对越界/负值会抛错） */
    }
  }
}
