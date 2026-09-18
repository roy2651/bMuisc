// 应用外壳：布局、链接解析入口、错误横幅、引擎初始化与记录恢复

import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ViewInfo } from './api';
import { initEngine } from './engine';
import { usePlayer } from './store';
import AddBar from './components/AddBar';
import NowPlaying from './components/NowPlaying';
import ParseModal from './components/ParseModal';
import PlayerBar from './components/PlayerBar';
import QueuePanel from './components/QueuePanel';
import { IconX } from './components/icons';

export default function App() {
  const { tracks, currentId, loading, error, dismissError, restore, addTracks, flushSnapshot } = usePlayer();
  const [parsed, setParsed] = useState<ViewInfo | null>(null);
  const [input, setInput] = useState('');
  const [version, setVersion] = useState('');
  const track = tracks.find((t) => t.uid === currentId) ?? null;

  // 引擎初始化（代理端口就绪可能稍晚于窗口）+ 恢复上次记录 + 关窗前兜底落盘
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 5 && !cancelled; i++) {
        try {
          await initEngine();
          if (!cancelled) restore();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    })();
    // 关闭窗口时最后一次快照可能还挂在 2 秒节流里，这里强制写入
    const unListen = getCurrentWindow().onCloseRequested(() => {
      flushSnapshot();
    });
    getVersion()
      .then((v) => !cancelled && setVersion(v))
      .catch(() => {});
    return () => {
      cancelled = true;
      void unListen.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo" title="bMuisc">BM</div>
        <div className="sidebar-foot">v{version || '0.0.0'}</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand">
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
          />
        </header>

        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button onClick={dismissError} aria-label="关闭提示"><IconX size={14} /></button>
          </div>
        )}

        <div className="content">
          <NowPlaying track={track} loading={loading} />
          <QueuePanel />
        </div>

        <PlayerBar />
      </div>

      {parsed && (
        <ParseModal
          view={parsed}
          onClose={() => setParsed(null)}
          onConfirm={(list, playNow) => {
            addTracks(list, playNow);
            setParsed(null);
          }}
        />
      )}
    </div>
  );
}
