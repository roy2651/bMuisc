// 左侧导航：我的音乐（全部 / 我的喜欢）+ 我的歌单（常驻列出，可新建空歌单）。
// 这里只切换主区浏览内容，与播放互不相干；队列在右侧抽屉。
import { useState } from 'react';
import { usePlayer } from '../store';
import { IconHeart, IconMusic, IconPlus } from './icons';

export default function Sidebar() {
  const s = usePlayer();
  const { view, libOrder, favs, playlists } = s;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [dup, setDup] = useState(false);

  function create() {
    const n = name.trim();
    if (!n) return;
    if (playlists.some((p) => p.name === n)) {
      setDup(true); // 同名提示，不静默合并
      return;
    }
    const id = s.createPlaylist(n);
    setCreating(false);
    setName('');
    setDup(false);
    s.setView({ kind: 'playlist', id });
  }

  return (
    <nav className="sidebar">
      <div className="side-label">我的音乐</div>
      <button className={`side-item${view.kind === 'all' ? ' on' : ''}`} onClick={() => s.setView({ kind: 'all' })}>
        <IconMusic size={16} />
        <span className="grow">全部音乐</span>
        <span className="cnt">{libOrder.length}</span>
      </button>
      <button className={`side-item${view.kind === 'favs' ? ' on' : ''}`} onClick={() => s.setView({ kind: 'favs' })}>
        <IconHeart size={16} />
        <span className="grow">我的喜欢</span>
        <span className="cnt">{favs.length}</span>
      </button>

      <div className="side-label">
        我的歌单
        <button
          className="icon-btn sm"
          title="新建歌单"
          onClick={() => {
            setCreating((v) => !v);
            setDup(false);
          }}
        >
          <IconPlus size={14} />
        </button>
      </div>
      {creating && (
        <div className="side-create">
          <input
            autoFocus
            value={name}
            placeholder="歌单名称，如：小说 / 华语歌"
            onChange={(e) => {
              setName(e.target.value);
              setDup(false);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // 输入法选词的 Enter/Esc 不作数
              if (e.key === 'Enter') create();
              if (e.key === 'Escape') {
                setCreating(false);
                setName('');
              }
            }}
          />
          {dup && (
            <div className="side-dup">
              已有同名歌单
              <button
                onClick={() => {
                  const exist = playlists.find((p) => p.name === name.trim());
                  if (exist) s.setView({ kind: 'playlist', id: exist.id });
                  setCreating(false);
                  setName('');
                  setDup(false);
                }}
              >
                打开它
              </button>
            </div>
          )}
        </div>
      )}
      <ul className="side-pls">
        {playlists.map((p) => (
          <li key={p.id}>
            <button
              className={`side-item${view.kind === 'playlist' && view.id === p.id ? ' on' : ''}`}
              title={p.name}
              onClick={() => s.setView({ kind: 'playlist', id: p.id })}
            >
              <span className="grow">{p.name}</span>
              <span className="cnt">{p.keys.length}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
