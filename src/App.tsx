// 应用外壳：顶栏（品牌 + 解析入口）、左侧导航、主区（浏览/正在播放）、
// 右侧队列抽屉、底部播放栏。浏览位置与播放状态相互独立。
import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Update } from '@tauri-apps/plugin-updater';
import type { ViewInfo } from './api';
import { initEngine, setVolume as syncEngineVolume } from './engine';
import { initMediaSession, syncMediaSession } from './mediaSession';
import { useSession } from './session';
import { usePlayer } from './store';
import { autoUpdateEnabled, checkForUpdate } from './updater';
import { useUiBus } from './uiBus';
import AddBar from './components/AddBar';
import AccountMenu from './components/AccountMenu';
import FavImportModal from './components/FavImportModal';
import FavPushModal from './components/FavPushModal';
import NowPlaying from './components/NowPlaying';
import ParseModal from './components/ParseModal';
import LoginQrModal from './components/LoginQrModal';
import PlayerBar from './components/PlayerBar';
import QueuePanel from './components/QueuePanel';
import SettingsModal from './components/SettingsModal';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import TrackView from './components/TrackView';
import UpdateModal from './components/UpdateModal';
import { IconSettings, IconX, LogoMark } from './components/icons';

export default function App() {
  const { tracks, currentId, playing, loading, error, dismissError, restore, confirmAdd, flushSnapshot, view, queueOpen, playlists, lastSaveTo, parseTargetHint, setParseTargetHint } = usePlayer();
  const [parsed, setParsed] = useState<ViewInfo | null>(null);
  const [input, setInput] = useState('');
  const [version, setVersion] = useState('');
  const [update, setUpdate] = useState<Update | null>(null);
  const settingsOpen = useUiBus((s) => s.settingsOpen);
  const openSettings = useUiBus((s) => s.openSettings);
  const closeSettings = useUiBus((s) => s.closeSettings);
  const qrOpen = useUiBus((s) => s.qrOpen);
  const closeQr = useUiBus((s) => s.closeQr);
  const importOpen = useUiBus((s) => s.importOpen);
  const closeImport = useUiBus((s) => s.closeImport);
  const pushFor = useUiBus((s) => s.pushFor);
  const closePush = useUiBus((s) => s.closePush);
  const track = tracks.find((t) => t.uid === currentId) ?? null;

  // 恢复上次记录（只读 localStorage，不依赖引擎——若被引擎初始化门控，
  // 代理起不来时界面会以空状态交互，关窗就用空状态覆盖快照，数据全丢）
  // + 引擎初始化（代理端口就绪可能稍晚于窗口）+ 关窗前兜底落盘
  useEffect(() => {
    let cancelled = false;
    restore();
    (async () => {
      for (let i = 0; i < 5 && !cancelled; i++) {
        try {
          await initEngine();
          // audio 元素在引擎初始化时才创建：把恢复出的音量补同步到真实元素
          const { volume, muted } = usePlayer.getState();
          syncEngineVolume(muted ? 0 : volume);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    })();
    // 关窗前强制落盘，最后一次快照可能还挂在 2 秒节流里。
    // 拦截默认关闭的只限有对应处理的两类平台：Windows（Rust 侧藏进托盘，lib.rs）/
    // macOS（这里隐藏，退出走 Dock 右键 / Cmd+Q）。必须显式 preventDefault：Tauri
    // 的 JS 包装在 handler 未拦截时会主动 destroy()，绕过 Rust 侧的 prevent_close
    // （实测 Windows 直接退了应用）。其余平台不拦截，保留默认关窗退出。
    const isMac = /Mac/i.test(navigator.userAgent);
    const isWin = /Win/i.test(navigator.userAgent);
    const unListen = getCurrentWindow().onCloseRequested(async (event) => {
      flushSnapshot();
      if (!isMac && !isWin) return; // 无关窗处理的平台：走默认关闭
      event.preventDefault();
      if (isMac) {
        await getCurrentWindow().hide();
      }
    });
    getVersion()
      .then((v) => !cancelled && setVersion(v))
      .catch(() => {});
    // 启动检查更新：稍作停顿再查（避开启动期的解析/代理请求），仅 Windows
    // 生产构建生效，设置里可关；检查失败静默，不打扰正常使用。
    // 触发时再读一次开关：用户若在启动数秒内关掉自动检查，已排队的检查不再执行
    let updateTimer: number | undefined;
    updateTimer = window.setTimeout(() => {
      if (!autoUpdateEnabled()) return;
      checkForUpdate()
        // prev ?? u：已有更新弹窗（如设置里手动检查到的）时不让迟到的启动
        // 检查覆盖——否则下载进行中换实例，显示与下载对象错位，旧实例还会
        // 因下载进行中被跳过释放
        .then((u) => {
          if (cancelled || !u) return;
          setUpdate((prev) => prev ?? u);
        })
        .catch(() => {});
    }, 6000);
    return () => {
      cancelled = true;
      window.clearTimeout(updateTimer);
      void unListen.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 登录状态启动查询一次（设置弹窗打开时会再查，保证新鲜）
  useEffect(() => {
    void useSession.getState().refresh();
  }, []);

  // 屏蔽 WebView 默认右键菜单（图片「另存为」等网页语义在桌面应用里突兀）
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);

  // 系统媒体控制（mac 媒体键/控制中心 Now Playing、Windows SMTC）：启动即注册
  // handler，系统指令改走应用内逻辑（不被 WebView 直接作用到 audio 元素）。
  // play/pause 必须用显式意图入口而非「守卫 + toggle」：store 的 playing 由异步
  // 媒体事件回写，指令到达时往往还是旧值，翻转语义会错向（连续两条暂停会把刚
  // 暂停的元素又播起来；解析窗口内的暂停会被吞掉、完成后照样自动开播）
  useEffect(() => {
    initMediaSession({
      play: () => usePlayer.getState().play(),
      pause: () => usePlayer.getState().pause(),
      next: () => usePlayer.getState().next(false),
      prev: () => usePlayer.getState().prev(),
      seek: (t) => usePlayer.getState().seekTo(t),
    });
  }, []);

  // 元数据与播放状态/进度增量同步到系统媒体面板（mediaSession 内部按签名/1s 节流）
  useEffect(() => {
    const push = () => {
      const s = usePlayer.getState();
      const t = s.tracks.find((x) => x.uid === s.currentId) ?? null;
      syncMediaSession({
        track: t ? { key: `${t.bvid}:${t.cid}`, title: t.title, artist: t.up, cover: t.cover } : null,
        playing: s.playing,
        position: s.position,
        duration: s.duration,
      });
    };
    push();
    return usePlayer.subscribe(push);
  }, []);

  // 解析弹窗默认目标：歌单页「添加音乐」的提示 > 上次有效目标 > 全部音乐
  let defaultTarget: 'all' | 'favs' | string = 'all';
  const hintValid = parseTargetHint != null && (parseTargetHint === 'all' || parseTargetHint === 'favs' || playlists.some((p) => p.id === parseTargetHint));
  if (hintValid && parseTargetHint) defaultTarget = parseTargetHint;
  else if (lastSaveTo === 'all' || lastSaveTo === 'favs' || playlists.some((p) => p.id === lastSaveTo)) defaultTarget = lastSaveTo;
  const clearHint = () => setParseTargetHint(null);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" title="bMuisc"><LogoMark size={26} /></span>
          <h1>bMuisc</h1>
          <span className="brand-sub">B 站音乐台</span>
        </div>
        <AddBar
          input={input}
          onInput={setInput}
          onParsed={(v) => {
            setParsed(v);
            setInput('');
          }}
          onFail={clearHint} // 解析失败：目标提示不再跨次生效，避免下次无关解析默认到遗留歌单
        />
        {version && <span className="version-chip">v{version}</span>}
        <AccountMenu />
        <button className="icon-btn" onClick={openSettings} title="设置" aria-label="设置">
          <IconSettings />
        </button>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button onClick={dismissError} aria-label="关闭提示"><IconX size={14} /></button>
        </div>
      )}

      <div className={queueOpen ? 'content queue-open' : 'content'}>
        <Sidebar />
        <main className="main">
          {view.kind === 'nowplaying' ? (
            <NowPlaying track={track} loading={loading} playing={playing} />
          ) : (
            <TrackView />
          )}
        </main>
        {queueOpen && <QueuePanel />}
      </div>

      <PlayerBar />

      {parsed && (
        <ParseModal
          view={parsed}
          defaultTarget={defaultTarget}
          onClose={() => {
            clearHint();
            setParsed(null);
          }}
          onConfirm={(list, playNow, target) => {
            clearHint();
            confirmAdd(list, playNow, target);
            setParsed(null);
          }}
        />
      )}
      {settingsOpen && <SettingsModal version={version} onClose={closeSettings} onFoundUpdate={setUpdate} />}
      {qrOpen && <LoginQrModal onClose={closeQr} />}
      {importOpen && <FavImportModal onClose={closeImport} />}
      {pushFor && <FavPushModal playlistId={pushFor} onClose={closePush} />}
      {update && <UpdateModal update={update} onClose={() => setUpdate(null)} />}
      <Toast />
    </div>
  );
}
