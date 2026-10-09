// 主窗侧迷你播放器宿主：把展示状态推给副窗、执行副窗的受限指令、负责
// 进入迷你模式的握手（副窗 ready 之前保留原窗口，提交时校验本次请求）。
// 纯增量订阅（mediaSession 同款范式）：不改变任何现有播放路径；副窗零写路径，
// 快照/曲库/队列仍只由主窗触碰（docs/mini-player.md §6 硬约束）。
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { keyOf, usePlayer } from './store';
import type { MiniCmd, MiniCmdResult, MiniState } from './miniBus';
import { EV_CANCELLED, EV_CMD, EV_CMD_RESULT, EV_ENTER, EV_HELLO, EV_HOST_READY, EV_READY, EV_STATE } from './miniBus';

let initPromise: Promise<void> | null = null;
let seq = 0;
let lastSig = '';
const seenCmdIds = new Set<string>(); // 指令去重：事件重复投递不重复执行（一击一发之上再加一道）
type ReadyResult = 'ready' | 'cancelled' | 'timeout';
const readyWaiters = new Map<string, (result: ReadyResult) => void>();

function sendResult(cmdId: string, ok: boolean, reason?: string) {
  const payload: MiniCmdResult = { cmdId, ok, reason };
  void emit(EV_CMD_RESULT, payload).catch(() => {});
}

function buildState(): MiniState {
  const s = usePlayer.getState();
  const t = s.tracks.find((x) => x.uid === s.currentId) ?? null;
  return {
    seq: ++seq,
    key: t ? keyOf(t) : null,
    title: t?.title ?? null,
    pageLabel: t?.pageLabel ?? null,
    up: t?.up ?? null,
    cover: t?.cover ?? null, // hdslb 公开 CDN URL，非签名媒体地址（§6 允许出主窗的唯一图片信息）
    playing: s.playing,
    loading: s.loading,
    error: s.error,
    liked: t ? s.favs.includes(keyOf(t)) : false,
    canToggle: s.tracks.length > 0,
    hasTrack: t != null,
  };
}

function pushState(force = false, requestId?: string) {
  const payload = buildState();
  const { seq: _ignored, ...sigPart } = payload;
  const sig = JSON.stringify(sigPart);
  if (!force && sig === lastSig) return; // 进度等高频变更到此即止，不打扰副窗
  lastSig = sig;
  void emit(EV_STATE, { ...payload, requestId }).catch(() => {});
}

async function execCmd(cmd: MiniCmd) {
  if (!cmd || typeof cmd.cmdId !== 'string' || typeof cmd.op !== 'string') return;
  if (seenCmdIds.has(cmd.cmdId)) return;
  seenCmdIds.add(cmd.cmdId);
  if (seenCmdIds.size > 64) {
    const oldest = seenCmdIds.values().next().value;
    if (oldest) seenCmdIds.delete(oldest);
  }
  const s = usePlayer.getState();
  switch (cmd.op) {
    case 'toggle':
      s.toggle(); // PlayerBar 同款语义（无源重启/needsReload 重试分支都在里面）
      return;
    case 'prev':
      s.prev();
      return;
    case 'next':
      s.next(false);
      return;
    case 'fav': {
      // 红心定向（§4.3 核心）：按点击时携带的 bvid:cid 解析目标，绝不盲取执行时的 currentId
      const target = typeof cmd.target === 'string' ? cmd.target : null;
      const item = target ? (s.tracks.find((x) => keyOf(x) === target) ?? s.lib[target]) : null;
      if (!item) {
        sendResult(cmd.cmdId, false, '曲目已不在播放列表');
        pushState(true); // 副窗显示的可能是过期状态，立刻刷新
        return;
      }
      s.toggleFav(item); // 副作用已核实：只动 favs + upsertLib + 快照，不重排不重播不触发B站推送
      return;
    }
    default:
      sendResult(cmd.cmdId, false, '未知指令');
  }
}

type EnterAttempt = { requestId: string; stopped: boolean; stop(): void };
let currentAttempt: EnterAttempt | null = null;

function cancelNative(requestId: string) {
  void invoke('mini_cancel_enter', { requestId }).catch(() => {});
}

export function restoreMain(): Promise<void> {
  currentAttempt?.stop();
  return invoke('mini_expand');
}

/** 从登记、监听初始化到建窗/ready，共用可取消的五秒期限。 */
export async function enterMini(): Promise<void> {
  if (currentAttempt) return;
  const requestId = crypto.randomUUID();
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let finishReady: ((result: ReadyResult) => void) | undefined;
  const attempt: EnterAttempt = {
    requestId,
    stopped: false,
    stop() {
      if (attempt.stopped) return;
      attempt.stopped = true;
      finishReady?.('cancelled');
      cancelNative(requestId);
      resolveStopped();
    },
  };
  currentAttempt = attempt;
  const timer = window.setTimeout(() => {
    if (attempt.stopped) return;
    attempt.stop();
    usePlayer.getState().notify('迷你窗口未能就绪，已保留原窗口');
  }, 5000);

  async function run() {
    // 先登记原生请求：即使监听尚未初始化，托盘/第二实例也能取消它。
    await invoke('mini_begin_enter', { requestId });
    if (attempt.stopped) {
      cancelNative(requestId); // 登记回执迟到时，补做定向清理。
      return;
    }
    await initMiniHost();
    if (attempt.stopped) return;
    const ready = new Promise<ReadyResult>((resolve) => {
      finishReady = (result) => {
        readyWaiters.delete(requestId);
        resolve(result);
      };
      readyWaiters.set(requestId, finishReady);
    });
    const active = await invoke<boolean>('mini_show', { requestId });
    if (attempt.stopped) return;
    if (!active) finishReady?.('cancelled');
    if (await ready === 'ready' && !attempt.stopped) {
      await invoke<boolean>('mini_commit_enter', { requestId });
    }
  }

  try {
    // run 的迟到拒绝仍由 race 接管；取消不再等待建窗或清理 IPC 回执。
    await Promise.race([run(), stopped]);
  } catch (e) {
    if (!attempt.stopped) usePlayer.getState().notify(`进入迷你模式失败：${e}`);
  } finally {
    window.clearTimeout(timer);
    attempt.stop();
    if (currentAttempt === attempt) currentAttempt = null;
  }
}

/** 等监听真正注册后才开放进入；StrictMode 复用同一初始化 Promise。 */
export function initMiniHost(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const unlisten: Array<() => void> = [];
    try {
      unlisten.push(await listen<{ requestId?: string }>(EV_HELLO, (e) => {
        pushState(true, e.payload?.requestId);
      }));
      unlisten.push(await listen<MiniCmd>(EV_CMD, (e) => void execCmd(e.payload)));
      unlisten.push(await listen<string>(EV_READY, (e) => readyWaiters.get(e.payload)?.('ready')));
      unlisten.push(await listen<string>(EV_CANCELLED, (e) => {
        readyWaiters.get(e.payload)?.('cancelled');
        if (currentAttempt?.requestId === e.payload) currentAttempt.stop();
      }));
      unlisten.push(await listen(EV_ENTER, () => void enterMini()));
      usePlayer.subscribe(() => pushState(false));
      void emit(EV_HOST_READY, {}).catch(() => {});
      pushState(true);
    } catch (e) {
      for (const off of unlisten) off();
      initPromise = null;
      throw e;
    }
  })();
  return initPromise;
}
