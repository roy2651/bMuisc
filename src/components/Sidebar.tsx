// 左侧导航：我的音乐（全部 / 我的喜欢 / 最近播放）+ 我的歌单（常驻列出，可新建空歌单、
// 可从B站导入；歌单项悬停出 ⋯ 菜单：推送到B站 / 重命名 / 删除）。
// 这里只切换主区浏览内容，与播放互不相干；队列在右侧抽屉。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayer } from '../store';
import { useSession } from '../session';
import { useUiBus } from '../uiBus';
import ConfirmModal from './ConfirmModal';
import NewPlaylistModal from './NewPlaylistModal';
import RenamePlaylistModal from './RenamePlaylistModal';
import { IconHeart, IconHistory, IconMore, IconMusic, IconPlus, IconSync } from './icons';

const MENU_W = 150; // 与 .side-menu min-width 一致，用于固定定位时的水平收拢
const MENU_H = 130; // 菜单估算高度：底部空间不足时向上翻

export default function Sidebar() {
  const s = usePlayer();
  const { view, libOrder, favs, recent, playlists } = s;
  const [createOpen, setCreateOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null); // 打开 ⋯ 菜单的歌单 id
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [delFor, setDelFor] = useState<string | null>(null);
  const loggedIn = useSession((st) => st.state?.loggedIn ?? false);

  // ⋯ 菜单开着时 Esc 收起（输入法用 Esc 取消候选词不作数）；弹窗自己的 Esc 走 escStack
  useEffect(() => {
    if (!menuFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') setMenuFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuFor]);

  // 菜单用 portal 渲染到 body 并以 fixed 定位（审查 R7）：侧栏窄窗下 overflow hidden、
  // 宽窗下 .side-pls overflow auto，普通绝对定位的菜单都会被滚动容器裁切
  function openMenu(id: string, btn: HTMLElement) {
    const r = btn.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.right - MENU_W), window.innerWidth - MENU_W - 8);
    const top = r.bottom + MENU_H + 8 > window.innerHeight ? Math.max(8, r.top - MENU_H - 6) : r.bottom + 6;
    setMenuPos({ top, left });
    setMenuFor(id);
  }

  const delPl = delFor ? playlists.find((p) => p.id === delFor) : null;

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
      <button className={`side-item${view.kind === 'recent' ? ' on' : ''}`} onClick={() => s.setView({ kind: 'recent' })}>
        <IconHistory size={16} />
        <span className="grow">最近播放</span>
        <span className="cnt">{recent.length}</span>
      </button>

      <div className="side-label">
        我的歌单
        <button
          className="icon-btn sm"
          title="从B站导入收藏夹"
          onClick={() => {
            if (!useSession.getState().state?.loggedIn) {
              s.notify('先登录B站账号，再导入收藏夹', { label: '扫码登录', run: () => useUiBus.getState().openQr() });
              return;
            }
            useUiBus.getState().openImport();
          }}
        >
          <IconSync size={14} />
        </button>
        <button className="icon-btn sm" title="新建歌单" onClick={() => setCreateOpen(true)}>
          <IconPlus size={14} />
        </button>
      </div>
      <ul className="side-pls">
        {playlists.map((p) => (
          <li key={p.id} className={menuFor === p.id ? 'menu-open' : ''}>
            <button
              className={`side-item${view.kind === 'playlist' && view.id === p.id ? ' on' : ''}`}
              title={p.biliMlid ? `${p.name}（${p.biliSrc === 'push' ? '已推送关联B站收藏夹' : '从B站导入'}）` : p.name}
              onClick={() => s.setView({ kind: 'playlist', id: p.id })}
            >
              <span className="grow">{p.name}</span>
              {p.biliMlid && (
                <span className="cloud-mark" title={p.biliSrc === 'push' ? '已推送关联B站收藏夹' : '从B站导入'}>
                  <IconSync size={11} />
                </span>
              )}
              <span className="cnt">{p.keys.length}</span>
            </button>
            {/* 悬停出现的歌单操作入口：⋯ 遮住计数位 */}
            <button
              className="side-more"
              title="歌单操作"
              onClick={(e) => {
                e.stopPropagation();
                if (menuFor === p.id) setMenuFor(null);
                else openMenu(p.id, e.currentTarget);
              }}
            >
              <IconMore size={13} />
            </button>
          </li>
        ))}
      </ul>
      {menuFor && menuPos && (
        createPortal(
          <>
            <div className="menu-mask" onClick={() => setMenuFor(null)} />
            {/* fixed 定位后必须清掉基类的 right:8px，否则菜单被反向拉伸至右缘（复审 F1 备注） */}
            <div className="side-menu" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, right: 'auto', width: 'max-content' }}>
              {loggedIn && (
                <button
                  onClick={() => {
                    setMenuFor(null);
                    useUiBus.getState().openPush(menuFor);
                  }}
                >
                  <IconSync size={13} /> 推送到B站
                </button>
              )}
              <button
                onClick={() => {
                  setRenameFor(menuFor);
                  setMenuFor(null);
                }}
              >
                重命名
              </button>
              <button
                className="danger"
                onClick={() => {
                  setDelFor(menuFor);
                  setMenuFor(null);
                }}
              >
                删除歌单
              </button>
            </div>
          </>,
          document.body,
        )
      )}
      {delPl && (
        <ConfirmModal
          title="删除歌单"
          body={`歌单「${delPl.name}」将被删除。仅属于此歌单、且未被「我的喜欢」或其他歌单引用的音乐会一并从曲库移除；B站收藏夹不受影响。`}
          confirmText="删除"
          danger
          onConfirm={() => {
            s.deletePlaylist(delPl.id);
            s.notify(`已删除歌单「${delPl.name}」`);
          }}
          onClose={() => setDelFor(null)}
        />
      )}
      {renameFor && <RenamePlaylistModal playlistId={renameFor} onClose={() => setRenameFor(null)} />}
      {createOpen && (
        <NewPlaylistModal
          onCreated={(id, existed) => {
            s.setView({ kind: 'playlist', id });
            if (existed) s.notify('已有同名歌单，已为你打开');
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </nav>
  );
}
