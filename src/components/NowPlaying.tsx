// 正在播放主区域：歌名第一信息，UP/来源次级，封面 + 柔和模糊背景 + 播放波浪 + 原页面入口

import { openUrl } from '@tauri-apps/plugin-opener';
import type { Track } from '../store';
import { fmtDur } from '../util';
import { IconExternal, LogoTile } from './icons';
import WaveViz from './WaveViz';

interface Props {
  track: Track | null;
  loading: boolean;
  playing: boolean;
}

export default function NowPlaying({ track, loading, playing }: Props) {
  if (!track) {
    return (
      <div className="nowplaying empty">
        <div className="empty-art">
          <LogoTile size={68} />
        </div>
        <h2>把 B 站的音乐搬到这里来听</h2>
        <p>粘贴视频链接或 BV 号，选择分 P 或整张合集加入队列。默认只播音频，随时可以切回视频。</p>
        <code>https://www.bilibili.com/video/BV...</code>
      </div>
    );
  }
  return (
    <div className="nowplaying">
      <div className="np-backdrop" style={{ backgroundImage: `url(${track.cover})` }} />
      <WaveViz playing={playing} />
      <div className="np-card">
        <div className="np-cover-wrap">
          <img className="np-cover" src={track.cover} alt={track.title} />
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
          <p className="np-sub">时长 {fmtDur(track.duration)} · 来自 B 站</p>
          <button className="btn ghost sm" onClick={() => openUrl(`https://www.bilibili.com/video/${track.bvid}/`)}>
            <IconExternal size={15} /> 打开原页面
          </button>
        </div>
      </div>
    </div>
  );
}
