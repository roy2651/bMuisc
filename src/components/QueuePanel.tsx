// 右侧播放队列抽屉：接下来播什么。独立于左侧浏览与歌单——
// 保留完整队列操作（播放、上/下移、移除、清空、定位当前、撤销清空）。
import { useEffect, useRef, useState } from 'react';
import { keyOf, usePlayer } from '../store';
import { fmtDur } from '../util';
import ThumbImg from './ThumbImg';
import { IconArrowDown, IconArrowUp, IconHeart, IconHeartFilled, IconLocate, IconTrash, IconX } from './icons';

function EqBars() {
  return (
    <span className="eq" aria-label="正在播放">
      <i />
      <i />
      <i />
    </span>
  );
}

export default function QueuePanel() {
  const s = usePlayer();
  const { tracks, favs, currentId, playing } = s;
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // 确认态 3 秒无操作自动还原，避免停在待确认状态
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  function locateCurrent() {
    listRef.current?.querySelector('.queue-row.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  return (
    <aside className="queue">
      <header className="queue-head">
        <h3>
          播放队列 <span className="count">{tracks.length}</span>
        </h3>
        <div className="head-actions">
          {currentId && tracks.length > 0 && (
            <button className="icon-btn sm" onClick={locateCurrent} title="定位当前播放">
              <IconLocate size={15} />
            </button>
          )}
          {tracks.length > 0 && (
            <button
              className={`btn ghost sm${confirmClear ? ' danger' : ''}`}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  return;
                }
                setConfirmClear(false);
                s.clear();
              }}
              title={confirmClear ? '再次点击确认清空' : '清空队列'}
            >
              <IconTrash size={14} /> {confirmClear ? '确认清空？' : '清空'}
            </button>
          )}
        </div>
      </header>
      {tracks.length === 0 ? (
        s.clearedBackup ? (
          <div className="queue-empty">
            已清空 {s.clearedBackup.tracks.length} 首
            <br />
            <button className="btn sm undo-btn" onClick={s.undoClear}>
              撤销清空
            </button>
          </div>
        ) : (
          <div className="queue-empty">
            队列还是空的
            <br />
            <span>在左侧选一个歌单播放，或解析一个链接加进来</span>
          </div>
        )
      ) : (
        <ul className="queue-list" ref={listRef}>
          {tracks.map((t, i) => {
            const key = keyOf(t);
            const fav = favs.includes(key);
            return (
              <li key={t.uid} className={`queue-row${t.uid === currentId ? ' active' : ''}`}>
                <span className="row-index">{t.uid === currentId && playing ? <EqBars /> : <span className="row-num">{i + 1}</span>}</span>
                <ThumbImg className="row-cover" cover={t.cover} size="sm" loading="lazy" />
                <button
                  className="row-main"
                  onClick={() => s.playAt(t.uid)}
                  title={t.source ? `${t.title}\n${t.pageLabel ?? ''} ${t.source}`.trim() : t.title}
                >
                  <span className="row-title">{t.title}</span>
                  <span className="row-sub">
                    {t.pageLabel ? `${t.pageLabel} · ` : ''}
                    {t.up}
                  </span>
                </button>
                <span className="row-dur">{fmtDur(t.duration)}</span>
                <span className="row-actions">
                  <button
                    className={fav ? 'fav-on' : ''}
                    title={fav ? '从「我的喜欢」移除' : '加入「我的喜欢」（红心）'}
                    onClick={() => s.toggleFav(t)}
                  >
                    {fav ? <IconHeartFilled size={14} /> : <IconHeart size={14} />}
                  </button>
                  <button title="上移" disabled={i === 0} onClick={() => s.reorder(t.uid, -1)}>
                    <IconArrowUp size={14} />
                  </button>
                  <button title="下移" disabled={i === tracks.length - 1} onClick={() => s.reorder(t.uid, 1)}>
                    <IconArrowDown size={14} />
                  </button>
                  <button title="移除" onClick={() => s.remove(t.uid)}>
                    <IconX size={14} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
