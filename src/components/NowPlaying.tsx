// 正在播放页：歌名第一信息，UP/来源次级，封面 + 柔和模糊背景 + 播放波浪 + 原页面入口。
// 从底栏封面展开进入；收起回到之前的浏览位置（浏览哪里与播什么互不影响）。

import { openUrl } from '@tauri-apps/plugin-opener';
import { usePlayer, type Track } from '../store';
import { fmtDur, thumbUrl } from '../util';
import { IconExternal, IconX, LogoTile } from './icons';
import ThumbImg from './ThumbImg';
import WaveViz from './WaveViz';

interface Props {
  track: Track | null;
  loading: boolean;
  playing: boolean;
}

export default function NowPlaying({ track, loading, playing }: Props) {
  const setView = usePlayer((s) => s.setView);
  function collapse() {
    const back = usePlayer.getState().lastBrowse;
    setView(back.kind === 'nowplaying' ? { kind: 'all' } : back);
  }
  if (!track) {
    return (
      <div className="nowplaying empty">
        <button className="np-collapse" onClick={collapse} title="收起" aria-label="收起正在播放">
          <IconX size={16} />
        </button>
        <div className="empty-art">
          <LogoTile size={68} />
        </div>
        <h2>把 B 站的音乐搬到这里来听</h2>
        <p>粘贴视频链接或 BV 号，选择分 P 或整张合集加入队列，默认只播音频。</p>
        <code>https://www.bilibili.com/video/BV...</code>
      </div>
    );
  }
  return (
    <div className="nowplaying">
      <button className="np-collapse" onClick={collapse} title="收起" aria-label="收起正在播放">
        <IconX size={16} />
      </button>
      {/* 模糊装饰背景：16:9 缩略图即可（重度模糊下分辨率无关紧要）；CSS 背景无 onError，失败只是没有背景层 */}
      <div className="np-backdrop" style={{ backgroundImage: `url(${thumbUrl(track.cover, 'wide')})` }} />
      <WaveViz playing={playing} />
      <div className="np-card">
        <div className="np-cover-wrap">
          <ThumbImg key={track.cover} className="np-cover" cover={track.cover} size="lg" alt={track.title} />
          {loading && <div className="np-loading"><span className="spinner" /></div>}
        </div>
        <div className="np-meta">
          <h1 className="np-title" title={track.title}>{track.title}</h1>
          <p className="np-up">{track.up}</p>
          {track.source && (
            <p className="np-source" title={`${track.pageLabel ?? ''} ${track.source}`.trim()}>
              {track.pageLabel === '合集' ? '合集' : '来自'}：{track.source}
              {track.pageLabel && track.pageLabel !== '合集' ? ` · ${track.pageLabel}` : ''}
            </p>
          )}
          {loading ? (
            <p className="np-sub loading-line"><span className="spinner inline" />正在加载音频流…</p>
          ) : (
            <p className="np-sub">时长 {fmtDur(track.duration)} · 来自 B 站</p>
          )}
          <button className="btn ghost sm" onClick={() => openUrl(`https://www.bilibili.com/video/${track.bvid}/`)}>
            <IconExternal size={15} /> 打开原页面
          </button>
        </div>
      </div>
    </div>
  );
}
