// 歌曲列表主区：全部音乐 / 我的喜欢 / 最近播放 / 歌单详情多种视图共用。
// 点行 = 用当前浏览列表建立队列并从该曲播放（保存与播放分离，不改歌单）；
// 行内 ⋯ 菜单：下一首播放 / 加入播放队列 / 添加到歌单 / 从当前歌单移除 / 从最近播放移除 / 打开原页面；
// 红心独立于菜单，直接切换「我的喜欢」。UP 主不作歌手展示：歌名为主，来源次之。
import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { keyOf, usePlayer, type LibTrack, type TrackKey } from '../store';
import { useSession } from '../session';
import { useUiBus } from '../uiBus';
import { fmtDur } from '../util';
import ConfirmModal from './ConfirmModal';
import NewPlaylistModal from './NewPlaylistModal';
import PlaylistPicker from './PlaylistPicker';
import ThumbImg from './ThumbImg';
import { IconHeart, IconHeartFilled, IconHistory, IconMore, IconMusic, IconPlay, IconPlus, IconSearch, IconSync, IconX } from './icons';

interface Row {
  item: LibTrack;
  key: TrackKey;
}

function EqBars() {
  return (
    <span className="eq" aria-label="正在播放">
      <i />
      <i />
      <i />
    </span>
  );
}

export default function TrackView() {
  const s = usePlayer();
  const { view, lib, libOrder, playlists, favs, recent, tracks, currentId, playing } = s;
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  // 删除类操作统一弹确认框：歌单删除 / 从曲库删除单曲
  const [delPlOpen, setDelPlOpen] = useState(false);
  const [delKey, setDelKey] = useState<TrackKey | null>(null);
  const [newPlKey, setNewPlKey] = useState<TrackKey | null>(null); // 经新建歌单弹窗添加的曲目
  // 行内菜单：main = 主操作；pick = 选择目标歌单
  const [menu, setMenu] = useState<{ key: TrackKey; mode: 'main' | 'pick' } | null>(null);
  const [headMenu, setHeadMenu] = useState(false);

  const viewId = view.kind === 'playlist' ? view.id : '';
  // 切换视图时还原全部临时态
  useEffect(() => {
    setFilter('');
    setRenaming(false);
    setDelPlOpen(false);
    setDelKey(null);
    setNewPlKey(null);
    setMenu(null);
    setHeadMenu(false);
  }, [view.kind, viewId]);

  const pl = view.kind === 'playlist' ? playlists.find((p) => p.id === view.id) : null;
  const loggedIn = useSession((s) => s.state?.loggedIn ?? false);
  const source = view.kind === 'favs' ? 'favs' : view.kind === 'all' ? 'all' : view.kind === 'recent' ? 'recent' : pl?.id ?? '';
  const keys = view.kind === 'all' ? libOrder : view.kind === 'favs' ? favs : view.kind === 'recent' ? recent : pl?.keys ?? [];
  const rows: Row[] = keys.flatMap((k) => (lib[k] ? [{ item: lib[k], key: k }] : []));
  const q = filter.trim().toLowerCase();
  const shown = q ? rows.filter((r) => `${r.item.title} ${r.item.up} ${r.item.source ?? ''}`.toLowerCase().includes(q)) : rows;

  const currentTrack = tracks.find((t) => t.uid === currentId) ?? null;
  const currentKey = currentTrack ? keyOf(currentTrack) : null;
  const totalDur = rows.reduce((a, r) => a + r.item.duration, 0);

  // Esc 关闭行内/头部菜单（输入法用 Esc 取消候选词不作数）
  useEffect(() => {
    if (!menu && !headMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        setMenu(null);
        setHeadMenu(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, headMenu]);

  // 歌单页「添加音乐」：从该歌单进入解析流程，目标默认本歌单；其他页面走上次目标
  function addMusic() {
    s.setParseTargetHint(view.kind === 'playlist' ? view.id : null);
    s.requestAddFocus();
  }

  function playAll() {
    const first = rows[0];
    if (first) s.playFrom(source, first.key);
  }

  // 行菜单 → 添加到歌单：单曲添加，选择后立即执行
  function pickTarget(target: 'all' | 'favs' | string) {
    if (!menu) return;
    const item = lib[menu.key];
    const k = menu.key;
    setMenu(null);
    if (!item) return;
    if (target === 'favs') {
      if (favs.includes(k)) {
        s.notify('这首歌已在「我的喜欢」');
      } else {
        s.toggleFav(item);
        s.notify('已添加到「我的喜欢」', { label: '查看', run: () => s.setView({ kind: 'favs' }) });
      }
      return;
    }
    if (target === 'all') return; // 行内菜单不提供该选项（本就在库里）
    const n = s.addToPlaylist(target, [item]);
    const name = playlists.find((p) => p.id === target)?.name ?? '歌单';
    s.notify(n > 0 ? `已添加 1 首到「${name}」` : '这首歌已在此歌单', n > 0 ? { label: '查看歌单', run: () => s.setView({ kind: 'playlist', id: target }) } : undefined);
  }

  const listTitle = view.kind === 'all' ? '全部音乐' : view.kind === 'favs' ? '我的喜欢' : view.kind === 'recent' ? '最近播放' : pl?.name ?? '';
  const cover = rows[0]?.item.cover ?? null;
  const headTile =
    view.kind === 'favs' ? (
      <div className="list-cover fav-tile">
        <IconHeartFilled size={34} />
      </div>
    ) : view.kind === 'recent' ? (
      <div className="list-cover empty-tile">
        <IconHistory size={30} />
      </div>
    ) : cover ? (
      <ThumbImg className="list-cover" cover={cover} size="md" />
    ) : (
      <div className="list-cover empty-tile">
        <IconMusic size={30} />
      </div>
    );

  return (
    <section className="list-page">
      <header className="list-head">
        {headTile}
        <div className="list-head-info">
          {renaming ? (
            <input
              autoFocus
              className="list-rename"
              value={draftName}
              placeholder="歌单名称"
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  s.renamePlaylist(viewId, draftName);
                  setRenaming(false);
                }
                if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={() => setRenaming(false)}
            />
          ) : (
            <h2 className="list-title" title={listTitle}>
              {view.kind === 'favs' && (
                <span className="title-heart">
                  <IconHeartFilled size={17} />
                </span>
              )}
              {listTitle}
            </h2>
          )}
          <p className="list-meta">
            {rows.length} 首{rows.length > 0 ? ` · 共 ${fmtDur(totalDur)}` : ''}
            {view.kind === 'playlist' && pl?.biliMlid && <span className="bili-badge">已关联B站收藏夹</span>}
          </p>
          <div className="list-actions">
            <button className="btn accent sm" disabled={rows.length === 0} onClick={playAll}>
              <IconPlay size={13} /> 播放全部
            </button>
            <button className="btn sm" onClick={addMusic}>
              <IconPlus size={14} /> 添加音乐
            </button>
            {/* 写回B站收藏夹：常驻按钮（登录后可见）；分P合并/幂等语义见 FavPushModal */}
            {view.kind === 'playlist' && pl && loggedIn && (
              <button className="btn sm" onClick={() => useUiBus.getState().openPush(pl.id)}>
                <IconSync size={13} /> 推送到B站
              </button>
            )}
            {view.kind === 'playlist' && (
              <button className={`icon-btn sm${headMenu ? ' on' : ''}`} title="更多操作" onClick={() => setHeadMenu((v) => !v)}>
                <IconMore size={16} />
              </button>
            )}
            {/* 头部更多菜单锚定在 ⋯ 按钮下方（.list-actions 为定位基准） */}
            {headMenu && pl && (
              <>
                <div className="menu-mask" onClick={() => setHeadMenu(false)} />
                <div className="row-menu head-menu">
                  <button
                    onClick={() => {
                      setHeadMenu(false);
                      setDraftName(pl.name);
                      setRenaming(true);
                    }}
                  >
                    重命名
                  </button>
                  <button
                    className="danger"
                    title="仅属于此歌单的音乐会一并从曲库移除"
                    onClick={() => {
                      setHeadMenu(false);
                      setDelPlOpen(true);
                    }}
                  >
                    删除歌单
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {rows.length > 0 && (
          <label className="list-search">
            <IconSearch size={14} />
            <input
              value={filter}
              placeholder={view.kind === 'playlist' ? '搜索此歌单' : '搜索此列表'}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button className="icon-btn sm" onClick={() => setFilter('')} aria-label="清除搜索">
                <IconX size={12} />
              </button>
            )}
          </label>
        )}
      </header>

      {rows.length === 0 ? (
        <div className="list-empty">
          <div className="empty-art">
            {view.kind === 'favs' ? <IconHeart size={40} /> : view.kind === 'recent' ? <IconHistory size={40} /> : <IconMusic size={40} />}
          </div>
          {view.kind === 'playlist' ? (
            <>
              <h3>还没有音乐</h3>
              <p>粘贴 B 站链接，把喜欢的歌曲收进来。</p>
              <button className="btn accent sm" onClick={addMusic}>
                添加音乐
              </button>
            </>
          ) : view.kind === 'favs' ? (
            <>
              <h3>还没有喜欢的音乐</h3>
              <p>在任意列表点 ♥，喜欢的曲目都会进「我的喜欢」。</p>
            </>
          ) : view.kind === 'recent' ? (
            <>
              <h3>还没有播放记录</h3>
              <p>播过的歌曲会按时间列在这里（最多 50 条）。</p>
            </>
          ) : (
            <>
              <h3>曲目库还是空的</h3>
              <p>解析添加过的内容都会自动留在这里。</p>
            </>
          )}
        </div>
      ) : shown.length === 0 ? (
        <div className="list-empty">
          <h3>没有匹配「{filter.trim()}」的歌曲</h3>
        </div>
      ) : (
        <ul className="list-rows">
          {shown.map((r, i) => {
            const fav = favs.includes(r.key);
            const active = r.key === currentKey;
            return (
              <li key={r.key} className={`queue-row${active ? ' active' : ''}`}>
                <span className="row-index">{active && playing ? <EqBars /> : <span className="row-num">{i + 1}</span>}</span>
                <ThumbImg className="row-cover" cover={r.item.cover} size="sm" loading="lazy" />
                <button className="row-main" onClick={() => s.playFrom(source, r.key)} title={`播放：${r.item.title}（用此列表替换队列）`}>
                  <span className="row-title">{r.item.title}</span>
                  <span className="row-sub">
                    {r.item.pageLabel ? `${r.item.pageLabel} · ` : ''}
                    {r.item.up}
                    {r.item.source ? ` · ${r.item.source}` : ''}
                  </span>
                </button>
                <span className="row-dur">{fmtDur(r.item.duration)}</span>
                <span className="row-actions">
                  <button
                    className={fav ? 'fav-on' : ''}
                    title={fav ? '从「我的喜欢」移除' : '加入「我的喜欢」（红心）'}
                    onClick={() => s.toggleFav(r.item)}
                  >
                    {fav ? <IconHeartFilled size={14} /> : <IconHeart size={14} />}
                  </button>
                  <button title="更多操作" onClick={() => setMenu(menu?.key === r.key ? null : { key: r.key, mode: 'main' })}>
                    <IconMore size={14} />
                  </button>
                </span>
                {menu?.key === r.key && (
                  <RowMenu
                    mode={menu.mode}
                    plView={view.kind === 'playlist'}
                    recentView={view.kind === 'recent'}
                    libView={view.kind === 'all'}
                    onMain={() => setMenu({ key: r.key, mode: 'pick' })}
                    onPick={pickTarget}
                    onNew={() => {
                      setMenu(null);
                      setNewPlKey(r.key);
                    }}
                    onNext={() => {
                      const item = lib[r.key];
                      if (item) s.playNext([item]);
                      setMenu(null);
                    }}
                    onEnqueue={() => {
                      const item = lib[r.key];
                      if (item) s.enqueue(item);
                      setMenu(null);
                    }}
                    onRemoveFromPl={() => {
                      if (view.kind === 'playlist') s.removeFromPlaylist(view.id, r.key);
                      setMenu(null);
                    }}
                    onRemoveFromRecent={() => {
                      s.removeFromRecent(r.key);
                      setMenu(null);
                    }}
                    onRemoveFromLib={() => {
                      setMenu(null);
                      setDelKey(r.key);
                    }}
                    onOpen={() => {
                      void openUrl(`https://www.bilibili.com/video/${r.item.bvid}/`);
                      setMenu(null);
                    }}
                    onClose={() => setMenu(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 删除类操作统一确认弹窗 */}
      {delPlOpen && pl && (
        <ConfirmModal
          title="删除歌单"
          body={`歌单「${pl.name}」将被删除。仅属于此歌单、且未被「我的喜欢」或其他歌单引用的音乐会一并从曲库移除；B站收藏夹不受影响。`}
          confirmText="删除"
          danger
          onConfirm={() => s.deletePlaylist(pl.id)}
          onClose={() => setDelPlOpen(false)}
        />
      )}
      {delKey !== null && lib[delKey] && (
        <ConfirmModal
          title="从音乐库删除"
          body={`《${lib[delKey].title}》将从曲库移除，「我的喜欢」与最近播放里的记录一并清理；不影响当前播放队列。`}
          confirmText="删除"
          danger
          onConfirm={() => {
            s.removeFromLib([delKey]);
            s.notify('已从音乐库删除');
          }}
          onClose={() => setDelKey(null)}
        />
      )}
      {newPlKey !== null && (
        <NewPlaylistModal
          confirmText="创建并添加"
          onCreated={(id, existed) => {
            const item = lib[newPlKey];
            setNewPlKey(null);
            if (!item) return;
            const n = s.addToPlaylist(id, [item]);
            const name = usePlayer.getState().playlists.find((p) => p.id === id)?.name ?? '歌单';
            s.notify(
              existed ? `已使用歌单「${name}」` : n > 0 ? `已添加 1 首到「${name}」` : '这首歌已在此歌单',
              n > 0 && !existed ? { label: '查看歌单', run: () => s.setView({ kind: 'playlist', id }) } : undefined,
            );
          }}
          onClose={() => setNewPlKey(null)}
        />
      )}
    </section>
  );
}

// 行内菜单主体（相对行定位；透明遮罩兜底点击关闭）
function RowMenu(props: {
  mode: 'main' | 'pick';
  plView: boolean;
  recentView: boolean;
  libView: boolean;
  onMain: () => void;
  onPick: (t: 'all' | 'favs' | string) => void;
  onNew: () => void;
  onNext: () => void;
  onEnqueue: () => void;
  onRemoveFromPl: () => void;
  onRemoveFromRecent: () => void;
  onRemoveFromLib: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  if (props.mode === 'pick') {
    return (
      <>
        <div className="menu-mask" onClick={props.onClose} />
        <div className="row-menu">
          <PlaylistPicker onPick={props.onPick} onNew={props.onNew} />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="menu-mask" onClick={props.onClose} />
      <div className="row-menu">
        <button onClick={props.onNext}>下一首播放</button>
        <button onClick={props.onEnqueue}>加入播放队列</button>
        <button onClick={props.onMain}>添加到歌单</button>
        {props.plView && (
          <button className="danger" onClick={props.onRemoveFromPl}>
            从当前歌单移除
          </button>
        )}
        {props.recentView && (
          <button className="danger" onClick={props.onRemoveFromRecent}>
            从最近播放移除
          </button>
        )}
        {props.libView && (
          <button className="danger" onClick={props.onRemoveFromLib}>
            从音乐库删除
          </button>
        )}
        <button onClick={props.onOpen}>打开 B 站原页面</button>
      </div>
    </>
  );
}
