// 迷你播放器浮窗（mini.html 入口的唯一页面）：当前曲目卡 + 四键
// （上一首 / 播放暂停 / 下一首 / 红心）+ 窗口操作（置顶 / 展开主窗 / 收起）。
// 纯遥控器：状态来自主窗 mini:state 推送（seq 守卫丢弃迟到/乱序），点击发
// mini:cmd 指令（一击一发）；绝不 import store/engine——隔离从构建层面保证。
// 硬约束（docs/mini-player.md §6）：位置/置顶偏好只存 bmuisc.mini.*
// （localStorage 跨窗共享，靠命名空间隔离）。拖动 = data-tauri-drag-region
// 标在所有非交互元素上（mousedown 目标必须带该属性），按钮子元素自然拦截点击。
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { availableMonitors, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import ThumbImg from './components/ThumbImg';
import { clampMiniPosition, parseMiniPosition } from './miniGeometry';
import type { MiniCmdOp, MiniCmdResult, MiniState } from './miniBus';
import { EV_ACTIVATE, EV_CANCELLED, EV_CMD, EV_CMD_RESULT, EV_HELLO, EV_HOST_READY, EV_READY, EV_STATE, isStaleState } from './miniBus';
import { IconExpand, IconHeart, IconHeartFilled, IconMusic, IconNext, IconPause, IconPin, IconPlay, IconPrev, IconX } from './components/icons';

const GEO_KEY = 'bmuisc.mini.geometry'; // { x, y } 物理像素；本窗是唯一写者
const PIN_KEY = 'bmuisc.mini.pinned'; // '1' | '0'，默认置顶

// ---------- 窗口壳：位置/置顶应用（每次激活都跑，先于 show 防闪跳） ----------

async function applyGeometry(isCurrent: () => boolean) {
  const win = getCurrentWindow();
  await win.setAlwaysOnTop(localStorage.getItem(PIN_KEY) !== '0');
  const monitors = await availableMonitors();
  const saved = parseMiniPosition(localStorage.getItem(GEO_KEY));
  const savedMonitor = saved ? monitors.find((m) => {
    const a = m.workArea;
    return saved.x >= a.position.x && saved.x < a.position.x + a.size.width &&
      saved.y >= a.position.y && saved.y < a.position.y + a.size.height;
  }) : undefined;
  const target = savedMonitor ?? (await currentMonitor()) ?? monitors[0];
  if (!target) throw new Error('无法取得显示器工作区');
  let size = await win.outerSize();
  const area = target.workArea;
  const desired = saved && savedMonitor
    ? saved
    : { x: area.position.x + area.size.width - size.width - 24, y: area.position.y + 16 };
  if (!isCurrent()) return;
  let position = clampMiniPosition(desired, size, area);
  await win.setPosition(new PhysicalPosition(position.x, position.y));
  // 跨屏移动可能触发 DPI 改变；按落点屏幕上的实际物理尺寸再校正一次。
  size = await win.outerSize();
  if (!isCurrent()) return;
  position = clampMiniPosition(position, size, area);
  await win.setPosition(new PhysicalPosition(position.x, position.y));
}

export default function MiniPlayer() {
  // null = 尚未收到主窗任何状态（激活例程已 hello，正常几十 ms 内到达）
  const [state, setState] = useState<MiniState | null>(null);
  const [pinned, setPinned] = useState(() => localStorage.getItem(PIN_KEY) !== '0');
  const [toast, setToast] = useState<string | null>(null);
  const geometryReady = useRef(false); // 应用位置时不回写偏好
  const syncedRef = useRef(-1); // 最后应用的 seq（乱序/重放丢弃）
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let moveTimer: ReturnType<typeof setTimeout> | undefined;
    const un: Array<() => void> = [];
    let requestId: string | null = null;
    let prepared = false;
    let acknowledged = false;

    // listen 的 Promise 可能在 StrictMode cleanup 后才完成，届时立即释放。
    async function retain(promise: Promise<() => void>) {
      const off = await promise;
      if (disposed) off();
      else un.push(off);
    }

    async function activate(id: string) {
      if (disposed) return;
      if (requestId === id) {
        if (prepared) void emit(EV_HELLO, { requestId: id }).catch(() => {});
        return;
      }
      requestId = id;
      prepared = false;
      acknowledged = false;
      geometryReady.current = false;
      const isCurrent = () => !disposed && requestId === id;
      try {
        await applyGeometry(isCurrent);
        if (!isCurrent()) return;
        prepared = true;
        geometryReady.current = true;
        await emit(EV_HELLO, { requestId: id });
      } catch {
        if (isCurrent()) {
          requestId = null; // 下次有界补发可重试；不以旧状态或计时器伪造 ready
          flash('迷你窗口准备失败，请重试');
        }
      }
    }

    void (async () => {
      await retain(listen<MiniState>(EV_STATE, (e) => {
        if (disposed) return;
        const p = e.payload;
        if (!p || typeof p.seq !== 'number') return;
        // 状态镜像和握手独立：较新的普通广播先到，也能确认较早的本次全量回执。
        if (!isStaleState(p, syncedRef.current)) {
          syncedRef.current = p.seq;
          setState(p);
        }
        if (prepared && !acknowledged && requestId && p.requestId === requestId) {
          acknowledged = true;
          void emit(EV_READY, requestId).catch(() => { acknowledged = false; });
        }
      }));
      if (disposed) return;
      await retain(listen<string>(EV_ACTIVATE, (e) => {
        if (typeof e.payload === 'string') void activate(e.payload);
      }));
      await retain(listen<string>(EV_CANCELLED, (e) => {
        if (!disposed && e.payload === requestId) {
          requestId = null;
          prepared = false;
        }
      }));
      await retain(listen<MiniCmdResult>(EV_CMD_RESULT, (e) => {
        if (disposed) return;
        const p = e.payload;
        if (p && p.ok === false) {
          flash(p.reason || '操作失败');
          void emit(EV_HELLO, {}).catch(() => {});
        }
      }));
      await retain(listen(EV_HOST_READY, () => {
        if (disposed) return;
        syncedRef.current = -1;
        void emit(EV_HELLO, {}).catch(() => {});
      }));
    })().catch(() => { if (!disposed) flash('状态连接失败，请重新打开迷你窗口'); });

    void retain(getCurrentWindow().onMoved(({ payload }) => {
      if (disposed || !geometryReady.current) return;
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        try { localStorage.setItem(GEO_KEY, JSON.stringify({ x: payload.x, y: payload.y })); }
        catch { /* 偏好保存失败不影响播放 */ }
      }, 300);
    })).catch(() => {});

    return () => {
      disposed = true;
      requestId = null;
      if (moveTimer) clearTimeout(moveTimer);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      for (const f of un) f();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flash(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }

  // 指令一击一发、永不重发（无队列/无重连重放）；红心在此捕获点击时显示的曲目 key
  function sendCmd(op: MiniCmdOp, target?: string) {
    const cmdId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    void emit(EV_CMD, { cmdId, op, target }).catch(() => {});
  }

  async function togglePin() {
    const next = !pinned;
    setPinned(next);
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
      localStorage.setItem(PIN_KEY, next ? '1' : '0');
    } catch {
      setPinned(!next);
    }
  }

  const s = state;
  const sub = s ? (s.error ? s.error : `${s.pageLabel ? `${s.pageLabel} · ` : ''}${s.up ?? ''}`) : '';

  return (
    <div className="mini-card" data-tauri-drag-region>
      <div className="mini-ops">
        <button className={`mini-op${pinned ? ' on' : ''}`} onClick={togglePin} title={pinned ? '取消置顶' : '置顶浮窗'}>
          <IconPin size={13} />
        </button>
        <button className="mini-op" onClick={() => void invoke('mini_expand').catch(() => flash('恢复主窗口失败，请重试'))} title="展开主窗口">
          <IconExpand size={13} />
        </button>
        <button className="mini-op" onClick={() => void invoke('mini_close').catch(() => flash('收起失败，请重试'))} title="收起迷你播放器，继续播放">
          <IconX size={13} />
        </button>
      </div>

      {!s || !s.hasTrack ? (
        // 空态与有歌卡片同构（封面位 + 两行文案 + 右侧动作），待命感而非「缺内容」
        <div className="mini-empty" data-tauri-drag-region>
          <div className="mini-cover mini-cover-empty" data-tauri-drag-region>
            <IconMusic size={20} />
          </div>
          <div className="mini-info" data-tauri-drag-region>
            <span className={`mini-title${s?.error ? ' bad' : ''}`} data-tauri-drag-region title={s?.error ?? undefined}>
              {s ? (s.error ?? '暂无播放内容') : '正在同步播放状态…'}
            </span>
            <span className="mini-sub" data-tauri-drag-region>
              {s?.error ? '可展开主窗口重试' : '主窗口开始播放后，这里同步显示'}
            </span>
          </div>
          <button className="btn ghost sm mini-empty-btn" onClick={() => void invoke('mini_expand').catch(() => flash('恢复主窗口失败，请重试'))}>
            打开主窗口
          </button>
        </div>
      ) : (
        <>
          {s.cover ? (
            <ThumbImg cover={s.cover} size="sm" className="mini-cover" dragRegion />
          ) : (
            <div className="mini-cover mini-cover-empty" data-tauri-drag-region>
              <IconMusic size={20} />
            </div>
          )}
          <div className="mini-info" data-tauri-drag-region>
            <span className="mini-title" data-tauri-drag-region title={s.title ?? undefined}>
              {s.title}
            </span>
            <span className={`mini-sub${s.error ? ' bad' : ''}`} data-tauri-drag-region title={sub || undefined}>
              {sub}
            </span>
          </div>
          <div className="mini-controls">
            <button
              className={`icon-btn${s.liked ? ' fav-on' : ''}`}
              onClick={() => sendCmd('fav', s.key ?? undefined)}
              disabled={!s.key}
              title={s.liked ? '从「我的喜欢」移除' : '加入「我的喜欢」（红心）'}
            >
              {s.liked ? <IconHeartFilled /> : <IconHeart />}
            </button>
            <button className="icon-btn" onClick={() => sendCmd('prev')} disabled={!s.hasTrack} title="上一首">
              <IconPrev />
            </button>
            <button
              className="play-btn"
              onClick={() => sendCmd('toggle')}
              disabled={!s.canToggle}
              title={s.error ? '重试播放' : s.playing ? '暂停' : '播放'}
            >
              {s.loading ? <span className="spinner dark" /> : s.playing ? <IconPause size={18} /> : <IconPlay size={18} />}
            </button>
            <button className="icon-btn" onClick={() => sendCmd('next')} disabled={!s.hasTrack} title="下一首">
              <IconNext />
            </button>
          </div>
        </>
      )}

      {toast && <div className="mini-toast">{toast}</div>}
    </div>
  );
}
