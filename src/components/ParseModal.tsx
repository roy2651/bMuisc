// 「添加音乐」弹窗：单曲 / 多分 P / 合集统一入口。
// 目标选择器常驻底部（默认目标由进入路径决定：歌单页 → 该歌单；全局 → 上次目标），
// 提交前显示重复预览；新建歌单在最终提交时才创建，中途关闭不留空歌单。
import { useEffect, useMemo, useState } from 'react';
import type { ViewInfo } from '../api';
import { keyOf, usePlayer, type AddTarget, type Track } from '../store';
import { fmtDur } from '../util';
import PlaylistPicker from './PlaylistPicker';
import { IconMusic, IconX } from './icons';

interface Props {
  view: ViewInfo;
  defaultTarget: 'all' | 'favs' | string;
  onClose: () => void;
  onConfirm: (tracks: Omit<Track, 'uid'>[], playNow: boolean, target: AddTarget) => void;
}

type Tab = 'pages' | 'season';

export default function ParseModal({ view, defaultTarget, onClose, onConfirm }: Props) {
  const hasMultiP = view.pages.length > 1;
  const hasSeason = !!view.season && view.season.episodes.length > 0;
  const [tab, setTab] = useState<Tab>(hasMultiP ? 'pages' : 'season');
  const [checkedPages, setCheckedPages] = useState<Set<number>>(() => new Set(view.pages.map((p) => p.page)));
  const [checkedEps, setCheckedEps] = useState<Set<string>>(() => new Set([view.bvid])); // 合集默认只选当前视频
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState<'all' | 'favs' | string>(defaultTarget);
  const [newMode, setNewMode] = useState(false); // ＋新建歌单展开的行内输入
  const [newName, setNewName] = useState('');
  const [playNow, setPlayNow] = useState(false);
  const playlists = usePlayer((s) => s.playlists);
  const favs = usePlayer((s) => s.favs);
  const libOrder = usePlayer((s) => s.libOrder);

  const q = filter.trim().toLowerCase();
  const filteredPages = q ? view.pages.filter((p) => p.part.toLowerCase().includes(q)) : view.pages;
  const eps = view.season?.episodes ?? [];
  const filteredEps = q ? eps.filter((e) => e.title.toLowerCase().includes(q)) : eps;

  const selectedTracks = useMemo((): Omit<Track, 'uid'>[] => {
    if (tab === 'pages' || !hasSeason) {
      return view.pages
        .filter((p) => checkedPages.has(p.page))
        .map((p) => ({
          // 歌名 = 分 P 自己的标题（通常就是歌名）；视频大标题降级为来源信息
          bvid: view.bvid,
          cid: p.cid,
          title: p.part || view.title,
          up: view.owner,
          cover: view.cover,
          duration: p.duration,
          pageLabel: hasMultiP ? `P${p.page}` : undefined,
          source: hasMultiP ? view.title : undefined,
        }));
    }
    return eps
      .filter((e) => checkedEps.has(e.bvid))
      .map((e) => ({
        bvid: e.bvid,
        cid: e.cid,
        title: e.title,
        up: e.owner || view.owner,
        cover: e.cover || view.cover,
        duration: e.duration,
        pageLabel: '合集',
        source: view.season?.title,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, checkedPages, checkedEps, view, hasMultiP, hasSeason]);

  const count = selectedTracks.length;
  // 重复预览：同一目标按 bvid:cid 去重，不同版本允许共存。
  // 新建歌单是空目标不存在重复；「全部音乐」同样按库去重。
  const dupCount = useMemo(() => {
    if (newMode) return 0;
    const keys = selectedTracks.map(keyOf);
    if (target === 'favs') return keys.filter((k) => favs.includes(k)).length;
    if (target === 'all') return keys.filter((k) => libOrder.includes(k)).length;
    const pl = playlists.find((p) => p.id === target);
    return keys.filter((k) => pl?.keys.includes(k)).length;
  }, [selectedTracks, target, favs, playlists, newMode, libOrder]);
  const freshCount = count - dupCount;

  const dupNameExists = newMode && playlists.some((p) => p.name === newName.trim());
  const targetName =
    newMode ? newName.trim() || '新歌单' : target === 'favs' ? '我的喜欢' : target === 'all' ? '音乐库' : playlists.find((p) => p.id === target)?.name ?? '歌单';
  // 全部已存在且不立即播放：无事可做；新建歌单必须先有名称
  const submittable = count > 0 && (newMode ? newName.trim().length > 0 : freshCount > 0 || playNow);

  // Esc 关闭弹窗；isComposing 排除输入法用 Esc 取消候选词的情况（mac 会以 Escape 上报）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit() {
    if (!submittable) return;
    onConfirm(selectedTracks, playNow, newMode ? { new: newName.trim() } : target);
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          <IconX />
        </button>
        <div className="modal-head">
          <img className="modal-cover" src={view.cover} alt="" />
          <div className="modal-head-info">
            <h2 title={view.title}>{view.title}</h2>
            <p>{view.owner} · {fmtDur(view.duration)} · 共 {view.pages.length} 个分 P</p>
            {hasSeason && <p className="muted">所属合集：{view.season!.title}（{view.season!.episodes.length} 集）</p>}
          </div>
        </div>

        {(hasMultiP || hasSeason) && (
          <div className="modal-tabs">
            {hasMultiP && (
              <button className={tab === 'pages' ? 'on' : ''} onClick={() => setTab('pages')}>
                分 P 选择{checkedPages.size > 0 ? `（已选 ${checkedPages.size}）` : ''}
              </button>
            )}
            {hasSeason && (
              <button className={tab === 'season' ? 'on' : ''} onClick={() => setTab('season')}>
                合集《{view.season!.title}》{tab === 'season' && checkedEps.size > 0 ? `（已选 ${checkedEps.size}）` : ''}
              </button>
            )}
            {tab === 'pages' && hasMultiP && (
              <span className="tab-actions">
                <button
                  onClick={() =>
                    setCheckedPages((prev) => new Set([...prev, ...filteredPages.map((p) => p.page)]))
                  }
                >
                  全选{q ? '筛选结果' : ''}
                </button>
                <button onClick={() => setCheckedPages(new Set())}>清空</button>
              </span>
            )}
            {tab === 'season' && (
              <span className="tab-actions">
                <button onClick={() => setCheckedEps((prev) => new Set([...prev, ...filteredEps.map((e) => e.bvid)]))}>全选</button>
                <button onClick={() => setCheckedEps(new Set())}>清空</button>
              </span>
            )}
          </div>
        )}

        {view.pages.length > 3 && (
          <label className="modal-search">
            <input value={filter} placeholder="搜索歌曲名称" onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
            {filter && (
              <button className="icon-btn sm" onClick={() => setFilter('')} aria-label="清除搜索">
                <IconX size={12} />
              </button>
            )}
          </label>
        )}

        <div className="modal-list">
          {tab === 'pages' || !hasSeason
            ? filteredPages.map((p) => (
                <label key={p.cid} className="pick-row">
                  <input
                    type="checkbox"
                    checked={checkedPages.has(p.page)}
                    onChange={(e) => {
                      const next = new Set(checkedPages);
                      if (e.target.checked) next.add(p.page);
                      else next.delete(p.page);
                      setCheckedPages(next);
                    }}
                  />
                  <span className="pick-title">{hasMultiP ? `P${p.page} ${p.part}` : p.part}</span>
                  <span className="pick-dur">{fmtDur(p.duration)}</span>
                </label>
              ))
            : filteredEps.map((e) => (
                <label key={e.bvid + e.cid} className="pick-row">
                  <input
                    type="checkbox"
                    checked={checkedEps.has(e.bvid)}
                    onChange={(ev) => {
                      const next = new Set(checkedEps);
                      if (ev.target.checked) next.add(e.bvid);
                      else next.delete(e.bvid);
                      setCheckedEps(next);
                    }}
                  />
                  <span className="pick-title" title={e.title}>{e.title}</span>
                  <span className="pick-dur">{fmtDur(e.duration)}</span>
                </label>
              ))}
          {(tab === 'pages' || !hasSeason ? filteredPages : filteredEps).length === 0 && (
            <div className="modal-list-empty">没有匹配「{filter.trim()}」的条目</div>
          )}
        </div>

        <div className="save-row">
          <span className="save-label">添加到</span>
          {newMode ? (
            <span className="save-new-wrap">
              <input
                autoFocus
                className="save-new"
                placeholder="新歌单名称，如：小说 / 华语歌"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') submit();
                  if (e.key === 'Escape') {
                    e.stopPropagation(); // 只收起新建输入，不触发窗口级 Esc 把整个弹窗连选择一起关掉
                    setNewMode(false);
                    setNewName('');
                  }
                }}
              />
              {dupNameExists && (
                <span className="save-dup">
                  已有同名歌单
                  <button
                    onClick={() => {
                      const exist = playlists.find((p) => p.name === newName.trim());
                      if (exist) setTarget(exist.id);
                      setNewMode(false);
                      setNewName('');
                    }}
                  >
                    使用已有歌单
                  </button>
                </span>
              )}
            </span>
          ) : (
            // 与行菜单共用同一目标选择器（§7）；新建歌单只在最终提交时创建
            <div className="save-picker">
              <PlaylistPicker current={target} includeAll onPick={setTarget} onNew={() => setNewMode(true)} />
            </div>
          )}
        </div>

        <div className="submit-row">
          <span className="dup-line">
            已选 {count} 首
            {dupCount > 0 && (
              <>
                ，其中 {dupCount} 首已{target === 'favs' ? '在此列表' : target === 'all' ? '收录' : '在此歌单'}，将新增 {freshCount} 首
              </>
            )}
          </span>
          <label className="playnow-check">
            <input type="checkbox" checked={playNow} onChange={(e) => setPlayNow(e.target.checked)} />
            添加后立即播放
          </label>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!submittable}
            onClick={submit}
            title={!submittable && count > 0 ? (target === 'all' ? '所选歌曲均已收录' : '所选歌曲均已在此歌单') : undefined}
          >
            <IconMusic size={15} />
            {newMode
              ? `创建「${targetName}」并添加 ${count} 首`
              : freshCount > 0
                ? `添加 ${freshCount} 首到「${targetName}」`
                : playNow
                  ? `播放所选 ${count} 首`
                  : target === 'all'
                    ? '所选歌曲均已收录'
                    : '所选歌曲均已在此歌单'}
          </button>
        </div>
      </div>
    </div>
  );
}
