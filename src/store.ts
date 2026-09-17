// 播放控制器：播放行为的唯一入口（切歌、定位、模式、队列修改、失败恢复）。
// 队列规则见 docs/project-plan.md §6：单曲循环仅影响自然结束、随机不与当前重复、
// 删除当前项选后继、清空即停止释放。

import { create } from 'zustand';
import { hooks, bindReporter, loadTrack, togglePlay, seek, setVolume, stopAndRelease } from './engine';

export type LoopMode = 'order' | 'loop' | 'one' | 'random';

export interface Track {
  uid: string; // 队列条目 ID，与视频标识分离，重复添加仍可独立排序删除
  bvid: string;
  cid: number;
  title: string;
  up: string;
  cover: string;
  duration: number;
  pageLabel?: string; // 分 P 标注（合集集数 / P 序号）
}

const MODES: LoopMode[] = ['order', 'loop', 'one', 'random'];
const MODE_LABEL: Record<LoopMode, string> = { order: '顺序播放', loop: '列表循环', one: '单曲循环', random: '随机播放' };
const SAVE_KEY = 'bmuisc.snapshot.v1';

let uidSeq = 0;
const newUid = () => `t${Date.now().toString(36)}-${(uidSeq++).toString(36)}`;

function saveSnapshot(s: PlayerState) {
  const data = {
    tracks: s.tracks,
    currentId: s.currentId,
    volume: s.volume,
    mode: s.mode,
    position: s.position,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    /* 存储失败不影响播放 */
  }
}

export interface PlayerState {
  tracks: Track[];
  currentId: string | null;
  playing: boolean;
  loading: boolean;
  position: number;
  duration: number;
  volume: number;
  mode: LoopMode;
  error: string | null;
  savedSeek: number | null; // 重启恢复：当前曲目首次加载时定位到此进度

  addTracks(tracks: Omit<Track, 'uid'>[], playNow: boolean): void;
  playAt(uid: string): void;
  toggle(): void;
  next(auto: boolean): void;
  prev(): void;
  seekTo(t: number): void;
  setVolume(v: number): void;
  cycleMode(): void;
  remove(uid: string): void;
  reorder(uid: string, dir: -1 | 1): void;
  clear(): void;
  restore(): void;
  patchMedia(patch: { playing?: boolean; loading?: boolean; position?: number; duration?: number; error?: string | null }): void;
  dismissError(): void;
}

export const usePlayer = create<PlayerState>((set, get) => {
  function startTrack(index: number, seekTo?: number) {
    const { tracks } = get();
    const track = tracks[index];
    if (!track) return;
    set({ currentId: track.uid, error: null, position: seekTo ?? 0 });
    loadTrack(track.bvid, track.cid, seekTo).catch(() => {
      /* 错误已由引擎上报到 error 状态 */
    });
  }

  return {
    tracks: [],
    currentId: null,
    playing: false,
    loading: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    mode: 'order',
    error: null,
    savedSeek: null,

    addTracks(items, playNow) {
      const tracks = items.map((t) => ({ ...t, uid: newUid() }));
      const { tracks: old } = get();
      set({ tracks: [...old, ...tracks] });
      if (playNow && tracks.length > 0) {
        startTrack(get().tracks.length - tracks.length);
      }
      saveSnapshot(get());
    },

    playAt(uid) {
      const index = get().tracks.findIndex((t) => t.uid === uid);
      if (index >= 0) startTrack(index);
    },

    toggle() {
      const { currentId, tracks, playing } = get();
      if (!currentId && tracks.length > 0) {
        startTrack(0);
        return;
      }
      if (playing) saveSnapshot(get());
      togglePlay();
    },

    next(auto) {
      const { tracks, mode, currentId } = get();
      if (tracks.length === 0) return;
      const index = tracks.findIndex((t) => t.uid === currentId);
      if (auto && mode === 'one' && index >= 0) {
        startTrack(index, 0); // 单曲循环仅影响自然结束
        return;
      }
      if (mode === 'random') {
        const candidates = tracks.map((_, i) => i).filter((i) => tracks[i].uid !== currentId);
        if (candidates.length === 0) {
          startTrack(0, 0);
          return;
        }
        startTrack(candidates[Math.floor(Math.random() * candidates.length)]);
        return;
      }
      let next = index + 1;
      if (next >= tracks.length) {
        if (auto && mode === 'order') {
          stopAndRelease(); // 顺序播放到队尾：停止并释放
          set({ currentId: null });
          saveSnapshot(get());
          return;
        }
        next = 0; // 列表循环回到第一项；用户手动切歌也回绕
      }
      startTrack(next);
    },

    prev() {
      const { tracks, currentId } = get();
      if (tracks.length === 0) return;
      const index = tracks.findIndex((t) => t.uid === currentId);
      const prev = index <= 0 ? tracks.length - 1 : index - 1;
      startTrack(prev);
    },

    seekTo(t) {
      set({ position: t });
      seek(t);
    },

    setVolume(v) {
      set({ volume: v });
      setVolume(v);
      saveSnapshot(get());
    },

    cycleMode() {
      const { mode } = get();
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      set({ mode: next });
      saveSnapshot(get());
    },

    remove(uid) {
      const { tracks, currentId, playing } = get();
      const index = tracks.findIndex((t) => t.uid === uid);
      if (index < 0) return;
      const remaining = tracks.filter((t) => t.uid !== uid);
      if (uid !== currentId) {
        set({ tracks: remaining });
        saveSnapshot(get());
        return;
      }
      // 删除当前播放项：选其后继；没有后继则选剩余第一项。此前暂停则保持暂停。
      stopAndRelease();
      if (remaining.length === 0) {
        set({ tracks: remaining, currentId: null, position: 0, duration: 0 });
        saveSnapshot(get());
        return;
      }
      const nextIndex = Math.min(index, remaining.length - 1);
      const target = remaining[nextIndex];
      set({ tracks: remaining, currentId: target.uid, position: 0, duration: 0 });
      if (playing) {
        startTrack(nextIndex);
      } else {
        // 保持暂停：仅记录新当前项，加载留到用户点播放（savedSeek=0 从头）
        set({ savedSeek: 0 });
      }
      saveSnapshot(get());
    },

    reorder(uid, dir) {
      const { tracks } = get();
      const i = tracks.findIndex((t) => t.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= tracks.length) return;
      const next = [...tracks];
      [next[i], next[j]] = [next[j], next[i]];
      set({ tracks: next }); // 排序不改变当前播放项
      saveSnapshot(get());
    },

    clear() {
      stopAndRelease();
      set({ tracks: [], currentId: null, position: 0, duration: 0 });
      saveSnapshot(get());
    },

    restore() {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw) as Partial<PlayerState>;
        const tracks = Array.isArray(data.tracks) ? data.tracks : [];
        const volume = typeof data.volume === 'number' ? data.volume : 0.8;
        const mode = MODES.includes(data.mode as LoopMode) ? (data.mode as LoopMode) : 'order';
        setVolume(volume);
        if (tracks.length === 0) {
          set({ volume, mode });
          return;
        }
        const currentId = tracks.some((t) => t.uid === data.currentId) ? data.currentId! : null;
        set({ tracks, volume, mode, currentId, savedSeek: currentId ? data.position ?? 0 : null });
      } catch {
        /* 记录损坏不阻止启动 */
      }
    },

    patchMedia(patch) {
      const s = get();
      set(patch as Partial<PlayerState>);
      if (patch.error != null) return; // 出错状态不覆盖快照
      if (
        patch.position !== undefined ||
        patch.playing !== undefined ||
        patch.duration !== undefined
      ) {
        saveSnapshot({ ...s, ...patch } as PlayerState);
      }
    },

    dismissError() {
      set({ error: null });
    },
  };
});

// 引擎事件接入：自然结束推进、媒体状态上报
hooks.ended = () => usePlayer.getState().next(true);
bindReporter((patch) => usePlayer.getState().patchMedia(patch));

export const MODE_TEXT = MODE_LABEL;
