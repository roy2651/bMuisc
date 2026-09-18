// 底部播放栏：进度、控制、音量、播放模式

import { usePlayer, MODE_TEXT } from '../store';
import { fmtDur } from '../util';
import { IconLoop, IconNext, IconOne, IconOrder, IconPause, IconPlay, IconPrev, IconRandom, IconVolume, IconVolumeMuted } from './icons';

function ModeIcon() {
  const mode = usePlayer((s) => s.mode);
  if (mode === 'random') return <IconRandom />;
  if (mode === 'loop') return <IconLoop />;
  if (mode === 'one') return <IconOne />;
  return <IconOrder />;
}

export default function PlayerBar() {
  const { currentId, tracks, playing, loading, position, duration, volume, muted, mode, toggle, next, prev, seekTo, setVolume, toggleMute, cycleMode } =
    usePlayer();
  const track = tracks.find((t) => t.uid === currentId) ?? null;
  const total = duration || track?.duration || 0;
  const progress = total > 0 ? Math.min(100, (position / total) * 100) : 0;
  const effective = muted ? 0 : volume; // 实际生效音量：显示与之一致

  return (
    <footer className="playerbar">
      <div className="seek-row">
        <span className="time">{fmtDur(position)}</span>
        <input
          className="slider seek"
          type="range"
          min={0}
          max={Math.floor(total) || 1}
          value={Math.floor(position)}
          style={{ ['--val' as string]: `${progress}%` }}
          disabled={!track}
          onChange={(e) => seekTo(Number(e.target.value))}
          aria-label="播放进度"
        />
        <span className="time">{fmtDur(total)}</span>
      </div>
      <div className="control-row">
        <div className="pb-track">
          {track ? (
            <>
              <img className="pb-cover" src={track.cover} alt="" />
              <div className="pb-info">
                <span className="pb-title" title={track.title}>{track.title}</span>
                <span className="pb-sub">{track.pageLabel ? `${track.pageLabel} · ` : ''}{track.up}</span>
              </div>
            </>
          ) : (
            <div className="pb-info"><span className="pb-title dim">还没有在播的内容</span></div>
          )}
        </div>
        <div className="pb-controls">
          <button className="icon-btn" onClick={cycleMode} title={MODE_TEXT[mode]}>
            <ModeIcon />
          </button>
          <button className="icon-btn" onClick={prev} disabled={!track} title="上一首">
            <IconPrev />
          </button>
          <button className="play-btn" onClick={toggle} disabled={!track && tracks.length === 0} title={playing ? '暂停' : '播放'}>
            {loading ? <span className="spinner dark" /> : playing ? <IconPause size={20} /> : <IconPlay size={20} />}
          </button>
          <button className="icon-btn" onClick={() => next(false)} disabled={!track} title="下一首">
            <IconNext />
          </button>
        </div>
        <div className="pb-volume">
          <button
            className="icon-btn vol-btn"
            onClick={toggleMute}
            title={muted ? '取消静音' : '静音'}
            aria-label={muted ? '取消静音' : '静音'}
          >
            {effective === 0 ? <IconVolumeMuted /> : <IconVolume />}
          </button>
          <input
            className="slider vol"
            type="range"
            min={0}
            max={100}
            value={Math.round(effective * 100)}
            style={{ ['--val' as string]: `${effective * 100}%` }}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            aria-label="音量"
          />
          <span className="vol-pct">{Math.round(effective * 100)}%</span>
        </div>
      </div>
    </footer>
  );
}
