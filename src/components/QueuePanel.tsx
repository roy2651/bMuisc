// 播放队列：当前项标记、点击播放、移除、清空（两段式确认）、排序（上移/下移）

import { useEffect, useState } from 'react';
import { usePlayer, type Track } from '../store';
import { fmtDur } from '../util';
import { IconArrowDown, IconArrowUp, IconMusic, IconTrash, IconX } from './icons';

function EqBars() {
  return (
    <span className="eq" aria-label="正在播放">
      <i /><i /><i />
    </span>
  );
}

export default function QueuePanel() {
  const { tracks, currentId, playing, playAt, remove, reorder, clear } = usePlayer();
  const [confirmClear, setConfirmClear] = useState(false);
  const current = tracks.find((t) => t.uid === currentId) ?? null;

  // 确认态 3 秒无操作自动还原，避免停在待确认状态
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  return (
    <aside className="queue">
      <header className="queue-head">
        <h3>播放队列 <span className="count">{tracks.length}</span></h3>
        {tracks.length > 0 && (
          <button
            className={`btn ghost sm${confirmClear ? ' danger' : ''}`}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              clear();
            }}
            title={confirmClear ? '再次点击确认清空' : '清空队列'}
          >
            <IconTrash size={14} /> {confirmClear ? '确认清空？' : '清空'}
          </button>
        )}
      </header>
      {tracks.length === 0 ? (
        <div className="queue-empty">队列还是空的<br /><span>解析一个链接，把喜欢的音乐加进来</span></div>
      ) : (
        <ul className="queue-list">
          {tracks.map((t: Track, i: number) => {
            const active = t.uid === currentId;
            return (
              <li key={t.uid} className={`queue-row${active ? ' active' : ''}`}>
                <span className="row-index">
                  {active && playing ? <EqBars /> : <IconMusic size={14} />}
                </span>
                <img className="row-cover" src={t.cover} alt="" loading="lazy" />
                <button className="row-main" onClick={() => playAt(t.uid)} title={t.title}>
                  <span className="row-title" title={t.title}>{t.title}</span>
                  <span className="row-sub">{t.pageLabel ? `${t.pageLabel} · ` : ''}{t.up}</span>
                </button>
                <span className="row-dur">{fmtDur(t.duration)}</span>
                <span className="row-actions">
                  <button title="上移" disabled={i === 0} onClick={() => reorder(t.uid, -1)}><IconArrowUp size={14} /></button>
                  <button title="下移" disabled={i === tracks.length - 1} onClick={() => reorder(t.uid, 1)}><IconArrowDown size={14} /></button>
                  <button title="移除" onClick={() => remove(t.uid)}><IconX size={14} /></button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {current && <footer className="queue-foot">当前：{current.title}</footer>}
    </aside>
  );
}
