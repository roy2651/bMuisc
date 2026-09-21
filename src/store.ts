// 播放控制器：播放行为的唯一入口（切歌、定位、模式、队列修改、失败恢复）。
// 队列规则见 docs/project-plan.md §6：单曲循环仅影响自然结束、随机不与当前重复、
// 删除当前项选后继、清空即停止释放。
//
// 三个概念（对齐网易云 / Apple Music 的模型）：
// - 曲目库「全部音乐」（lib，按 bvid:cid 去重）：收集过的所有内容
// - 歌单 / 我的喜欢：只存 key 引用，同一首可进多个歌单；改歌单不动队列
// - 播放队列：独立于歌单，临时增删排序不影响收藏结构
// 保存（进歌单/喜欢/库）与播放严格分离：单纯保存不改队列、不打断播放。

import { create } from 'zustand';
import { hooks, bindReporter, hasSource, loadTrack, needsReload, prefetchTrack, getPrefetched, togglePlay, seek, setVolume, stopAndRelease } from './engine';

export type LoopMode = 'order' | 'loop' | 'one' | 'random';

export interface Track {
  uid: string; // 队列条目 ID，与视频标识分离，重复添加仍可独立排序删除
  bvid: string;
  cid: number;
  title: string; // 歌名优先：分 P 用 part 标题，合集用单集标题
  up: string;
  cover: string;
  duration: number;
  pageLabel?: string; // 短标注（P8 / 合集），完整来源放 source
  source?: string; // 所属视频 / 合集标题，次级信息用
}

export type TrackKey = string; // `${bvid}:${cid}`，曲目库去重键
export type LibTrack = Omit<Track, 'uid'>;
// 保存目标：'all' 仅收录音乐库 / 'favs' 我的喜欢 / 歌单 id / {new} 解析流程里顺带新建
export type AddTarget = 'all' | 'favs' | string | { new: string };

export interface Playlist {
  id: string;
  name: string;
  keys: TrackKey[];
}

// 导航视图：正在播放页 / 我的喜欢 / 全部音乐 / 最近播放 / 某个自建歌单。
// 队列不再是视图——它是独立抽屉（queueOpen），浏览哪里与播什么互不相干。
export type ViewSpec = { kind: 'nowplaying' } | { kind: 'favs' } | { kind: 'all' } | { kind: 'recent' } | { kind: 'playlist'; id: string };

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export const keyOf = (t: { bvid: string; cid: number }): TrackKey => `${t.bvid}:${t.cid}`;

const MODES: LoopMode[] = ['order', 'loop', 'one', 'random'];
const MODE_LABEL: Record<LoopMode, string> = { order: '顺序播放', loop: '列表循环', one: '单曲循环', random: '随机播放' };
const SAVE_KEY = 'bmuisc.snapshot.v3';
const SAVE_KEY_V2 = 'bmuisc.snapshot.v2';
const SAVE_KEY_V1 = 'bmuisc.snapshot.v1';
const TOAST_MS = 4500;
const RECENT_MAX = 50; // 最近播放封顶条数：按最后开播时间保留最新的

let uidSeq = 0;
const newUid = () => `t${Date.now().toString(36)}-${(uidSeq++).toString(36)}`;
let plSeq = 0;
const newPlId = () => `p${Date.now().toString(36)}-${plSeq++}`;
let toastSeq = 0;
// 快照恢复完成前禁止落盘：引擎初始化失败时界面仍可交互，
// 若无门控，任意操作或关窗会用空状态覆盖快照，曲库/歌单/喜欢全部丢失
let hydrated = false;
// 最近播放：本会话（当前加载的这一首）已记录过开播的 key。同一首的暂停恢复/卡顿
// 恢复都靠它跳过——不能假设当前曲目就在 recent[0]：用户可能已把它从最近播放里
// 显式移除，恢复播放不得悄悄撤销该移除（对抗复核确认的真实缺陷）。
// startTrack 默认重置标记：每个新的播放动作（点播/切歌/自动接续/重播当前曲）= 新会话；
// 仅错误重试路径（toggle 的 needsReload 分支）传 keepRecentSession 保留，见 startTrack 注释。
let recentRecordedFor: TrackKey | null = null;

function writeSnapshot(s: PlayerState) {
  if (!hydrated) return;
  const data = {
    v: 3,
    tracks: s.tracks,
    currentId: s.currentId,
    volume: s.volume,
    muted: s.muted,
    mode: s.mode,
    position: s.position,
    lib: s.lib,
    libOrder: s.libOrder,
    playlists: s.playlists,
    favs: s.favs,
    recent: s.recent,
    view: s.view,
    lastSaveTo: s.lastSaveTo,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    /* 存储失败不影响播放 */
  }
}

// 播放进度每秒上报多次，全量序列化大队列不能跟着这么频繁：进度类更新合并为
// 每 2 秒落盘一次；关键动作（增删、模式、音量、暂停等）传 immediate 立即写。
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSnapshot(s: PlayerState, immediate = false) {
  if (immediate) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeSnapshot(s);
    return;
  }
  if (saveTimer) return; // 已有待写的合并任务
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSnapshot(usePlayer.getState());
  }, 2000);
}

export interface AddStats {
  saved: number; // 实际新增到目标（歌单/喜欢/库）的数量
  skipped: number; // 因已在目标中而跳过的数量
}

export interface PlayerState {
  tracks: Track[];
  currentId: string | null;
  playing: boolean;
  loading: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean; // 显式静音标志；实际音量 = muted ? 0 : volume
  mode: LoopMode;
  error: string | null;
  savedSeek: number | null; // 重启恢复：当前曲目首次加载时定位到此进度
  clearedBackup: { tracks: Track[]; currentId: string | null } | null; // 清空撤销用，不落盘
  plRemoveBackup: { id: string; key: TrackKey; index: number } | null; // 从歌单移除的撤销备份，不落盘
  lib: Record<TrackKey, LibTrack>; // 曲目库（全部音乐），bvid:cid 去重
  libOrder: TrackKey[]; // 曲目库插入顺序（Record 不保序）
  playlists: Playlist[]; // 自建歌单，仅存 key 引用
  favs: TrackKey[]; // 我的喜欢：红心即加入的固定歌单（有序，类似网易云）
  recent: TrackKey[]; // 最近播放：按最后开播时间倒序的去重 key（封顶 RECENT_MAX），只引用曲库
  view: ViewSpec; // 左侧导航当前浏览位置，重启恢复
  lastBrowse: ViewSpec; // 进入正在播放页之前的浏览位置（返回用），不落盘
  queueOpen: boolean; // 右侧队列抽屉显隐
  lastSaveTo: 'all' | 'favs' | TrackKey; // 解析弹窗上次有效保存目标，重启恢复
  parseTargetHint: 'all' | 'favs' | TrackKey | null; // 从歌单页「添加音乐」进入时的目标提示，用后即清
  focusAddTick: number; // 请求聚焦顶部添加输入框（歌单页「添加音乐」按钮）
  toast: Toast | null;

  /** 添加内容：收录进库；saveTo 决定额外保存到哪；playNow = 保存后把本批追加到队列并从本批第一首播放（不替换队列）。返回实际新增/跳过数。 */
  addTracks(items: LibTrack[], playNow: boolean, saveTo?: 'all' | 'favs' | TrackKey | null): AddStats;
  /** 解析弹窗统一入口：解析 {new} 目标 → 创建歌单 → 保存 → 反馈提示，一次完成。 */
  confirmAdd(items: LibTrack[], playNow: boolean, target: AddTarget): void;
  enqueue(item: LibTrack): void; // 追加到队列末尾，不改变播放
  playNext(items: LibTrack[]): void; // 下一首播放：插入当前曲目之后，不打断播放
  playAt(uid: string): void;
  playFrom(source: 'favs' | 'all' | string, key: TrackKey): void; // 用该列表整单替换队列并从 key 播放
  toggle(): void;
  next(auto: boolean): void;
  prev(): void;
  seekTo(t: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  cycleMode(): void;
  remove(uid: string): void;
  reorder(uid: string, dir: -1 | 1): void;
  clear(): void;
  undoClear(): void;
  createPlaylist(name: string): string;
  renamePlaylist(id: string, name: string): void;
  deletePlaylist(id: string): void;
  /** 加入歌单：按 bvid:cid 去重（不同版本可共存），返回实际新增数 */
  addToPlaylist(id: string, items: LibTrack[]): number;
  removeFromPlaylist(id: string, key: TrackKey): void;
  undoRemoveFromPlaylist(): void;
  /** 从最近播放移除单条（不影响曲库/歌单/喜欢） */
  removeFromRecent(key: TrackKey): void;
  toggleFav(item: LibTrack): void;
  setView(view: ViewSpec): void;
  setQueueOpen(open: boolean): void;
  setLastSaveTo(target: 'all' | 'favs' | TrackKey): void;
  requestAddFocus(): void;
  setParseTargetHint(target: 'all' | 'favs' | TrackKey | null): void;
  notify(text: string, action?: { label: string; run: () => void }): void;
  dismissToast(): void;
  flushSnapshot(): void; // 关窗兜底：跳过节流立即落盘
  restore(): void;
  patchMedia(patch: { playing?: boolean; loading?: boolean; position?: number; duration?: number; error?: string | null }): void;
  dismissError(): void;
}

// 把一份快照数据应用到状态（v1/v2/v3 兼容）。数据损坏或字段非法时抛错，由调用方隔离坏档。
function applySnapshotData(data: Partial<PlayerState> & { v?: number }, set: (patch: Partial<PlayerState>) => void) {
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const volume = typeof data.volume === 'number' ? data.volume : 0.8;
  const muted = data.muted === true;
  const mode = MODES.includes(data.mode as LoopMode) ? (data.mode as LoopMode) : 'order';
  setVolume(muted ? 0 : volume);
  // v1 快照没有库/歌单：把旧队列曲目整体收录进库，歌单从空开始
  const lib: Record<TrackKey, LibTrack> = {};
  for (const t of tracks as Track[]) {
    const k = keyOf(t);
    lib[k] = { bvid: t.bvid, cid: t.cid, title: t.title, up: t.up, cover: t.cover, duration: t.duration, pageLabel: t.pageLabel, source: t.source };
  }
  if (data.lib && typeof data.lib === 'object') {
    for (const [k, t] of Object.entries(data.lib as Record<string, LibTrack>)) {
      if (!t || typeof t.bvid !== 'string' || typeof t.cid !== 'number') continue;
      lib[k] = t;
    }
  }
  // 曲库顺序：v3 有保存顺序，按其校验恢复（缺失的 key 补到尾部），
  // 不能让播放队列改写库顺序；v1 没有曲目库，退回「队列优先」迁移
  const seen = new Set<TrackKey>();
  const libOrder: TrackKey[] = [];
  const savedOrder: TrackKey[] = Array.isArray(data.libOrder)
    ? data.libOrder.filter((k): k is TrackKey => typeof k === 'string' && !!lib[k])
    : [];
  if (savedOrder.length > 0) {
    for (const k of savedOrder) {
      if (!seen.has(k)) {
        libOrder.push(k);
        seen.add(k);
      }
    }
  } else {
    for (const t of tracks as Track[]) {
      const k = keyOf(t);
      if (lib[k] && !seen.has(k)) {
        libOrder.push(k);
        seen.add(k);
      }
    }
  }
  for (const k of Object.keys(lib)) {
    if (!seen.has(k)) {
      libOrder.push(k);
      seen.add(k);
    }
  }
  const playlists = Array.isArray(data.playlists)
    ? data.playlists.filter((p): p is Playlist => !!p && typeof p.id === 'string' && Array.isArray(p.keys))
    : [];
  const favs = Array.isArray(data.favs) ? data.favs.filter((k): k is TrackKey => typeof k === 'string' && !!lib[k]) : [];
  // 最近播放：只收仍在库中的合法 key，去重保序封顶；旧快照没有该字段 → 空列表
  const recent: TrackKey[] = [];
  if (Array.isArray(data.recent)) {
    for (const k of data.recent) {
      if (typeof k === 'string' && lib[k] && !recent.includes(k)) recent.push(k);
      if (recent.length >= RECENT_MAX) break;
    }
  }
  // 视图迁移：v2 的 'queue' 不再是导航位置 → 全部音乐；指向已删歌单 → 全部音乐
  const rawView = data.view as ViewSpec | undefined;
  let view: ViewSpec = { kind: 'all' };
  if (rawView && typeof rawView === 'object' && 'kind' in rawView) {
    if (rawView.kind === 'playlist' && playlists.some((p) => p.id === (rawView as { id: string }).id)) {
      view = rawView;
    } else if (rawView.kind === 'favs' || rawView.kind === 'all' || rawView.kind === 'recent' || rawView.kind === 'nowplaying') {
      view = rawView;
    }
  }
  const rawSave = data.lastSaveTo;
  const lastSaveTo: 'all' | 'favs' | TrackKey =
    rawSave === 'all' || rawSave === 'favs'
      ? rawSave
      : typeof rawSave === 'string' && playlists.some((p) => p.id === rawSave)
        ? rawSave
        : 'all';
  if (tracks.length === 0 && libOrder.length === 0) {
    set({ volume, muted, mode, lib, libOrder, playlists, favs, recent, view, lastSaveTo });
    return;
  }
  const currentId = tracks.some((t) => t.uid === data.currentId) ? data.currentId! : null;
  const resumePos = currentId ? data.position ?? 0 : 0;
  set({
    tracks,
    volume,
    muted,
    mode,
    currentId,
    // 恢复进度同时进入 position：未播放就切页/关窗时，快照写的 position 不得是 0
    position: resumePos,
    savedSeek: currentId ? resumePos : null,
    lib,
    libOrder,
    playlists,
    favs,
    recent,
    view,
    lastSaveTo,
  });
}

export const usePlayer = create<PlayerState>((set, get) => {
  // 开播成功后按循环模式预解析并预缓冲下一首，切歌/自动接续时近乎零等待；
  // 预取失败静默，切歌时引擎走常规解析兜底。
  function schedulePrefetch() {
    const { tracks, mode, currentId } = get();
    const idx = tracks.findIndex((t) => t.uid === currentId);
    if (idx < 0) return;
    let target: Track | undefined;
    if (mode === 'one') return; // 同曲重播：引擎直接定位回 0，无需预取
    if (mode === 'random') {
      const cands = tracks.filter((t) => t.uid !== currentId);
      target = cands.length > 0 ? cands[Math.floor(Math.random() * cands.length)] : undefined;
    } else {
      target = tracks[(idx + 1) % tracks.length]; // 含回绕：列表循环自动接续 + 手动下一首都可能命中
    }
    if (target) void prefetchTrack(target.bvid, target.cid);
  }

  function startTrack(index: number, seekTo?: number, opts?: { keepRecentSession?: boolean }) {
    const { tracks } = get();
    const track = tracks[index];
    if (!track) return;
    // 最近播放会话门控：startTrack 即新播放会话（点播/切歌/自动接续/清空后重播/
    // 主动重播当前曲目），旧标记作废——重新点播同一首也要重新入史，key 比对无法
    // 区分用户意图，由调用入口声明。唯一例外是错误重试（toggle 的 needsReload 分支
    // 传 keepRecentSession）：失败会话是原会话的延续，显式移除不被重试撤销；
    // 暂停/缓冲恢复不经过 startTrack，同样保留移除。
    if (!opts?.keepRecentSession) recentRecordedFor = null;
    const resumeAt = seekTo ?? null; // 本次加载试图定位的进度：失败时回写，重试不从 0 开始
    // 开始加载即消费掉重启恢复的定位，避免之后清空→撤销再播放时跳到过期进度
    set({ currentId: track.uid, error: null, position: seekTo ?? 0, savedSeek: null });
    loadTrack(track.bvid, track.cid, seekTo)
      .then((ok) => {
        if (!ok && resumeAt) set({ savedSeek: resumeAt, position: resumeAt }); // 加载失败：恢复定位并回显进度
        schedulePrefetch();
      })
      .catch(() => {
        // 引擎未就绪等异常：引擎抛错前不上报任何状态，回写定位，代理就绪后点播放仍从原进度续播
        if (resumeAt) set({ savedSeek: resumeAt, position: resumeAt });
      });
  }

  // 曲目库收录：新 key 追加顺序，已有条目刷新元数据（重新解析后标题/封面可能更新）
  function upsertLib(items: LibTrack[]) {
    const { lib, libOrder } = get();
    const nextLib = { ...lib };
    const nextOrder = libOrder.slice();
    let added = false;
    let updated = false;
    for (const it of items) {
      const k = keyOf(it);
      const prev = nextLib[k];
      if (!prev) {
        nextOrder.push(k);
        added = true;
      } else if (
        prev.title !== it.title ||
        prev.up !== it.up ||
        prev.cover !== it.cover ||
        prev.duration !== it.duration ||
        prev.pageLabel !== it.pageLabel ||
        prev.source !== it.source
      ) {
        updated = true; // 元信息变化也要提交，否则库与队列显示不一致
      }
      nextLib[k] = it;
    }
    if (added) set({ lib: nextLib, libOrder: nextOrder });
    else if (updated) set({ lib: nextLib }); // 只刷新元数据，不动顺序
  }

  // 按来源物化曲目列表（缺库条目跳过）
  function materialize(source: 'favs' | 'all' | string): LibTrack[] {
    const { lib, libOrder, playlists, favs, recent } = get();
    const keys =
      source === 'favs'
        ? favs
        : source === 'all'
          ? libOrder
          : source === 'recent'
            ? recent
            : (playlists.find((p) => p.id === source)?.keys ?? []);
    return keys.map((k) => lib[k]).filter(Boolean);
  }

  // 最近播放记录：引擎上报真正出声（playing 事件：playing=true 且 loading=false）时调用。
  // play 事件（请求播放）只翻按钮态，不等于开播——缓冲后失败、从未出声的曲目不入史。
  // recentRecordedFor 门控本会话：同一首的恢复/重试不刷位置，且若用户已把该曲
  // 从最近播放移除，移除保持生效；新会话由 startTrack 重置标记，重新点播可再次入列。
  // 落盘由 patchMedia 的播放类立即写承接，这里不重复保存。
  function recordRecent() {
    const { tracks, currentId, recent } = get();
    const t = tracks.find((x) => x.uid === currentId);
    if (!t) return;
    const k = keyOf(t);
    if (recentRecordedFor === k) return;
    recentRecordedFor = k;
    set({ recent: [k, ...recent.filter((x) => x !== k)].slice(0, RECENT_MAX) });
  }

  return {
    tracks: [],
    currentId: null,
    playing: false,
    loading: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    mode: 'order',
    error: null,
    savedSeek: null,
    clearedBackup: null,
    plRemoveBackup: null,
    lib: {},
    libOrder: [],
    playlists: [],
    favs: [],
    recent: [],
    view: { kind: 'all' },
    lastBrowse: { kind: 'all' },
    queueOpen: true,
    lastSaveTo: 'all',
    parseTargetHint: null,
    focusAddTick: 0,
    toast: null,

    addTracks(items, playNow, saveTo = null) {
      if (items.length === 0) return { saved: 0, skipped: 0 };
      const inLibBefore = new Set(get().libOrder); // 基线：判断哪些是这次真正新入库的
      upsertLib(items); // 添加过的内容自动进「全部」
      let saved = 0;
      let skipped = 0;
      if (saveTo === 'favs') {
        const known = new Set(get().favs);
        const fresh = items.map(keyOf).filter((k) => !known.has(k));
        saved = fresh.length;
        skipped = items.length - fresh.length;
        if (fresh.length > 0) set({ favs: [...get().favs, ...fresh] });
      } else if (saveTo === 'all' || !saveTo) {
        // 仅收录音乐库（目标 'all' 或不保存）：upsert 已跑完，用基线统计真正的新 key（元数据刷新不算新增）
        saved = items.map(keyOf).filter((k) => !inLibBefore.has(k)).length;
        skipped = items.length - saved;
      } else {
        saved = get().addToPlaylist(saveTo, items);
        skipped = items.length - saved;
      }
      if (playNow) {
        // 追加到队列末尾并从本批第一首播放；不替换、不打断既有队列结构之外的内容
        const fresh = items.map((t) => ({ ...t, uid: newUid() }));
        const { tracks } = get();
        set({ tracks: [...tracks, ...fresh], clearedBackup: null }); // 新内容进来后撤销已无意义
        startTrack(tracks.length);
      }
      saveSnapshot(get(), true);
      return { saved, skipped };
    },

    confirmAdd(items, playNow, target) {
      const { playlists } = get();
      let saveTo: 'all' | 'favs' | TrackKey;
      let targetName: string;
      let plId: string | null = null;
      if (typeof target === 'object') {
        plId = get().createPlaylist(target.new); // 创建歌单与添加一次完成，不留空歌单
        saveTo = plId;
        targetName = target.new;
      } else {
        saveTo = target;
        if (target === 'favs') targetName = '我的喜欢';
        else if (target === 'all') targetName = '音乐库';
        else {
          plId = target;
          targetName = playlists.find((p) => p.id === target)?.name ?? '歌单';
        }
      }
      const { saved, skipped } = get().addTracks(items, playNow, saveTo);
      get().setLastSaveTo(saveTo); // 记住上次有效目标（下次全局解析默认用它）
      if (plId) {
        get().notify(
          saved > 0 ? `已添加 ${saved} 首到「${targetName}」${skipped > 0 ? `，跳过 ${skipped} 首重复` : ''}` : '所选歌曲均已在此歌单',
          { label: '查看歌单', run: () => get().setView({ kind: 'playlist', id: plId! }) },
        );
      } else if (saveTo === 'favs') {
        get().notify(
          saved > 0 ? `已添加 ${saved} 首到「我的喜欢」${skipped > 0 ? `，跳过 ${skipped} 首重复` : ''}` : '所选歌曲均已喜欢',
          { label: '查看', run: () => get().setView({ kind: 'favs' }) },
        );
      } else if (saveTo === 'all') {
        get().notify(
          saved > 0 ? `已收录 ${saved} 首到音乐库${skipped > 0 ? `，跳过 ${skipped} 首重复` : ''}` : '所选歌曲均已收录',
        );
      }
    },

    enqueue(item) {
      upsertLib([item]);
      set({ tracks: [...get().tracks, { ...item, uid: newUid() }], clearedBackup: null });
      saveSnapshot(get(), true);
    },

    playNext(items) {
      if (items.length === 0) return;
      upsertLib(items);
      const fresh = items.map((t) => ({ ...t, uid: newUid() }));
      const { tracks, currentId } = get();
      if (!currentId) {
        // 没有正在播的：追加并从插入的第一首开始（无播放可打断）
        set({ tracks: [...tracks, ...fresh], clearedBackup: null });
        startTrack(tracks.length);
      } else {
        const idx = tracks.findIndex((t) => t.uid === currentId);
        const next = [...tracks.slice(0, idx + 1), ...fresh, ...tracks.slice(idx + 1)];
        set({ tracks: next, clearedBackup: null });
      }
      saveSnapshot(get(), true);
    },

    playAt(uid) {
      const index = get().tracks.findIndex((t) => t.uid === uid);
      if (index >= 0) startTrack(index);
    },

    playFrom(source, key) {
      const list = materialize(source);
      const tracks = list.map((t) => ({ ...t, uid: newUid() }));
      if (tracks.length === 0) return;
      const idx = tracks.findIndex((t) => keyOf(t) === key);
      if (idx < 0) return;
      set({ tracks, clearedBackup: null });
      startTrack(idx);
      saveSnapshot(get(), true);
    },

    toggle() {
      const { currentId, tracks, playing, savedSeek, position } = get();
      if (!currentId) {
        if (tracks.length > 0) startTrack(0);
        return;
      }
      // 重启恢复的会话：媒体尚未加载（audio 无源），点播放即从记录进度继续。
      // savedSeek 已被上次点击消费时回退 position：解析窗口（src 未挂）内双击播放
      // 会两次进入本分支，不能让第二次把续播点重置为 0（并落盘覆盖原进度）
      if (!playing && !hasSource()) {
        const index = tracks.findIndex((t) => t.uid === currentId);
        if (index >= 0) {
          startTrack(index, savedSeek ?? position);
          return;
        }
      }
      if (playing) saveSnapshot(get(), true);
      // 当前加载会话已终败（切歌解析失败 / 媒体报错）：直接恢复旧源会播错歌（界面已是新曲目）
      // 或对坏源再拒一次。改走重试：position 即有效进度（中途报错≈出错位置，全新加载为 0/原定位点），
      // 由 startTrack 统一承接失败回写与预取调度。
      if (!playing && needsReload()) {
        const index = tracks.findIndex((t) => t.uid === currentId);
        if (index >= 0) {
          // 错误重试：原会话的延续而非新点播，保留最近播放会话标记（显式移除不被撤销）
          startTrack(index, get().position, { keepRecentSession: true });
          return;
        }
      }
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
        // 复用预取时定好的随机结果：手动/自动切歌都命中秒开路径
        //（随机模式"下一首是哪首"在预取时已随机好，提前定和现场定无感知差异）
        const pf = getPrefetched();
        const hinted = pf ? tracks.findIndex((t) => t.bvid === pf.bvid && t.cid === pf.cid) : -1;
        if (hinted >= 0 && tracks[hinted].uid !== currentId) {
          startTrack(hinted);
          return;
        }
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
          saveSnapshot(get(), true);
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
      // 未开播（重启恢复后）引擎 seek 是 no-op：同步改写待定位进度，
      // 否则点播放会跳回恢复点，用户拖动的位置被静默丢弃。
      // 加载在途时不写：定位已在 loadTrack 调用时绑定，此刻写入会留下陈旧恢复点
      if (!hasSource() && !get().loading) {
        set({ position: t, savedSeek: t });
        return;
      }
      set({ position: t });
      seek(t);
    },

    setVolume(v) {
      set({ volume: v, muted: v > 0 ? false : get().muted }); // 拖动即解除静音
      setVolume(get().muted ? 0 : v);
      saveSnapshot(get(), true);
    },

    toggleMute() {
      const muted = !get().muted;
      set({ muted });
      setVolume(muted ? 0 : get().volume);
      saveSnapshot(get(), true);
    },

    cycleMode() {
      const { mode } = get();
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      set({ mode: next });
      saveSnapshot(get(), true);
    },

    remove(uid) {
      const { tracks, currentId, playing } = get();
      const index = tracks.findIndex((t) => t.uid === uid);
      if (index < 0) return;
      const remaining = tracks.filter((t) => t.uid !== uid);
      if (uid !== currentId) {
        set({ tracks: remaining });
        saveSnapshot(get(), true);
        return;
      }
      // 删除当前播放项：选其后继；没有后继则选剩余第一项。此前暂停则保持暂停。
      stopAndRelease();
      if (remaining.length === 0) {
        set({ tracks: remaining, currentId: null, position: 0, duration: 0 });
        saveSnapshot(get(), true);
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
      saveSnapshot(get(), true);
    },

    reorder(uid, dir) {
      const { tracks } = get();
      const i = tracks.findIndex((t) => t.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= tracks.length) return;
      const next = [...tracks];
      [next[i], next[j]] = [next[j], next[i]];
      set({ tracks: next }); // 排序不改变当前播放项
      saveSnapshot(get(), true);
    },

    clear() {
      const { tracks, currentId } = get();
      if (tracks.length === 0) return;
      stopAndRelease();
      const backup = { tracks, currentId };
      set({ tracks: [], currentId: null, position: 0, duration: 0, clearedBackup: backup });
      // 5 秒后撤销机会自动过期，备份释放（按对象身份匹配，撤销→再清空不会误清新备份）
      setTimeout(() => {
        if (get().clearedBackup === backup) set({ clearedBackup: null });
      }, 5000);
      saveSnapshot(get(), true);
    },

    undoClear() {
      const backup = get().clearedBackup;
      if (!backup) return;
      set({ tracks: backup.tracks, currentId: backup.currentId, clearedBackup: null });
      saveSnapshot(get(), true);
    },

    createPlaylist(name) {
      const pl: Playlist = { id: newPlId(), name, keys: [] };
      set({ playlists: [...get().playlists, pl] });
      saveSnapshot(get(), true);
      return pl.id;
    },

    renamePlaylist(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      set({ playlists: get().playlists.map((p) => (p.id === id ? { ...p, name: trimmed } : p)) });
      saveSnapshot(get(), true);
    },

    deletePlaylist(id) {
      const { playlists, view, lastSaveTo, parseTargetHint } = get();
      set({ playlists: playlists.filter((p) => p.id !== id) });
      // 浏览位置、保存目标若指向被删歌单一并回落
      if (view.kind === 'playlist' && view.id === id) set({ view: { kind: 'all' } });
      if (lastSaveTo === id) set({ lastSaveTo: 'all' });
      if (parseTargetHint === id) set({ parseTargetHint: null });
      saveSnapshot(get(), true);
    },

    addToPlaylist(id, items) {
      upsertLib(items); // 歌单引用的条目必须先在库里
      const pl = get().playlists.find((p) => p.id === id);
      if (!pl) return 0;
      const known = new Set(pl.keys);
      const fresh = items.map(keyOf).filter((k) => !known.has(k));
      if (fresh.length === 0) return 0;
      set({
        playlists: get().playlists.map((p) => (p.id === id ? { ...p, keys: [...p.keys, ...fresh] } : p)),
      });
      saveSnapshot(get(), true);
      return fresh.length;
    },

    removeFromPlaylist(id, key) {
      const pl = get().playlists.find((p) => p.id === id);
      if (!pl) return;
      const index = pl.keys.indexOf(key);
      if (index < 0) return;
      const backup = { id, key, index };
      set({
        playlists: get().playlists.map((p) => (p.id === id ? { ...p, keys: p.keys.filter((k) => k !== key) } : p)),
        plRemoveBackup: backup,
      });
      saveSnapshot(get(), true);
      // 短暂撤销入口（歌单还在且未被重复操作时有效）
      get().notify(`已从「${pl.name}」移除`, { label: '撤销', run: () => get().undoRemoveFromPlaylist() });
      // 按备份对象身份过期：同 key 短时间内再次移除时，旧定时器不得清掉新备份
      setTimeout(() => {
        if (get().plRemoveBackup === backup) set({ plRemoveBackup: null });
      }, TOAST_MS + 500);
    },

    undoRemoveFromPlaylist() {
      const b = get().plRemoveBackup;
      if (!b) return;
      set({ plRemoveBackup: null });
      const pl = get().playlists.find((p) => p.id === b.id);
      if (!pl || pl.keys.includes(b.key)) return; // 歌单已删或曲目已被重新加入：无事可做
      const keys = pl.keys.slice();
      keys.splice(Math.min(b.index, keys.length), 0, b.key);
      set({ playlists: get().playlists.map((p) => (p.id === b.id ? { ...p, keys } : p)) });
      saveSnapshot(get(), true);
    },

    removeFromRecent(key) {
      const { recent } = get();
      if (!recent.includes(key)) return;
      set({ recent: recent.filter((k) => k !== key) });
      saveSnapshot(get(), true);
    },

    toggleFav(item) {
      const k = keyOf(item);
      const { favs } = get();
      if (favs.includes(k)) {
        set({ favs: favs.filter((x) => x !== k) });
      } else {
        upsertLib([item]); // 收藏的条目必须能从库里物化
        set({ favs: [...favs, k] });
      }
      saveSnapshot(get(), true);
    },

    setView(view) {
      const prev = get().view;
      if (prev.kind !== 'nowplaying') set({ lastBrowse: prev });
      set({ view });
      saveSnapshot(get(), true);
    },

    setQueueOpen(open) {
      set({ queueOpen: open });
    },

    setLastSaveTo(target) {
      set({ lastSaveTo: target });
      saveSnapshot(get(), true);
    },

    requestAddFocus() {
      set({ focusAddTick: get().focusAddTick + 1 });
    },

    setParseTargetHint(target) {
      set({ parseTargetHint: target });
    },

    notify(text, action) {
      const id = ++toastSeq;
      set({ toast: { id, text, action } });
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, TOAST_MS);
    },

    dismissToast() {
      set({ toast: null });
    },

    flushSnapshot() {
      saveSnapshot(get(), true);
    },

    restore() {
      let corrupted = false;
      // 依次尝试 v3 → v2 → v1：坏档隔离为 *.bad 保留并移出主档位，继续回落旧版本；
      // 所有出口都必须允许落盘（hydrated），否则界面能操作但保存被静默跳过，用户数据无端丢失
      for (const key of [SAVE_KEY, SAVE_KEY_V2, SAVE_KEY_V1]) {
        let raw: string | null = null;
        try {
          raw = localStorage.getItem(key);
        } catch {
          return; // localStorage 不可用：落盘同样会失败，保持默认空状态
        }
        if (!raw) continue;
        try {
          applySnapshotData(JSON.parse(raw) as Partial<PlayerState> & { v?: number }, set);
          hydrated = true; // 恢复成功，允许落盘
          if (corrupted) get().notify('本地记录部分损坏，已从旧版本恢复');
          return;
        } catch {
          corrupted = true;
          // 坏档移到 *.bad 保留（供排查找回），主档位腾空以便回落旧版本
          try {
            localStorage.setItem(`${key}.bad`, raw);
            localStorage.removeItem(key);
          } catch {
            /* 隔离失败不影响启动 */
          }
        }
      }
      hydrated = true; // 没有任何可用快照：全新开始，正常落盘
      if (corrupted) get().notify('本地记录损坏，已重新开始（坏档已保留为 .bad）');
    },

    patchMedia(patch) {
      const s = get();
      set(patch as Partial<PlayerState>);
      // 真正出声（playing 事件）才记入最近播放：play 事件只翻按钮态，
      // 缓冲后失败、从未开播的不算「播过」（审查 P2：失败尝试不得挤掉有效历史）
      if (patch.playing === true && patch.loading === false) recordRecent();
      if (patch.error != null) return; // 出错状态不覆盖快照
      if (patch.playing !== undefined) {
        // get() 而非 {...s, ...patch}：recordRecent 刚写入的 recent 也一并落盘
        saveSnapshot(get(), true); // 播放/暂停立即落盘，关窗不丢
      } else if (patch.position !== undefined || patch.duration !== undefined) {
        saveSnapshot({ ...s, ...patch } as PlayerState); // 进度类走 2 秒节流
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
