// 解析结果弹窗：展示元信息，选择分 P / 合集条目加入队列。

import { useMemo, useState } from 'react';
import type { ViewInfo } from '../api';
import type { Track } from '../store';
import { fmtDur } from '../util';
import { IconMusic, IconX } from './icons';

interface Props {
  view: ViewInfo;
  onClose: () => void;
  onConfirm: (tracks: Omit<Track, 'uid'>[], playNow: boolean) => void;
}

type Tab = 'pages' | 'season';

export default function ParseModal({ view, onClose, onConfirm }: Props) {
  const hasMultiP = view.pages.length > 1;
  const hasSeason = !!view.season && view.season.episodes.length > 0;
  const [tab, setTab] = useState<Tab>(hasMultiP ? 'pages' : 'season');
  const [checkedPages, setCheckedPages] = useState<Set<number>>(() => new Set(view.pages.map((p) => p.page)));
  const [checkedEps, setCheckedEps] = useState<Set<string>>(() => new Set([view.bvid]));

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
    return (view.season?.episodes ?? [])
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
  }, [tab, checkedPages, checkedEps, view, hasMultiP, hasSeason]);

  const count = selectedTracks.length;
  const eps = view.season?.episodes ?? [];

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
                分 P 选择
              </button>
            )}
            {hasSeason && (
              <button className={tab === 'season' ? 'on' : ''} onClick={() => setTab('season')}>
                合集《{view.season!.title}》
              </button>
            )}
            {tab === 'pages' && hasMultiP && (
              <span className="tab-actions">
                <button onClick={() => setCheckedPages(new Set(view.pages.map((p) => p.page)))}>全选</button>
                <button onClick={() => setCheckedPages(new Set())}>清空</button>
              </span>
            )}
            {tab === 'season' && (
              <span className="tab-actions">
                <button onClick={() => setCheckedEps(new Set(eps.map((e) => e.bvid)))}>全选</button>
                <button onClick={() => setCheckedEps(new Set())}>清空</button>
              </span>
            )}
          </div>
        )}

        <div className="modal-list">
          {tab === 'pages' || !hasSeason
            ? view.pages.map((p) => (
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
            : eps.map((e) => (
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
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={count === 0} onClick={() => onConfirm(selectedTracks, false)}>
            加入队列（{count}）
          </button>
          <button className="btn accent" disabled={count === 0} onClick={() => onConfirm(selectedTracks, true)}>
            <IconMusic size={16} /> 立即播放
          </button>
        </div>
      </div>
    </div>
  );
}
