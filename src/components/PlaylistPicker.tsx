// 统一的「添加到」目标选择器：解析弹窗与歌曲行菜单共用同一套列表。
// 只负责展示与选择；「新建歌单」只发事件，何时真正创建由调用方决定
// （解析弹窗在最终提交时创建，避免中途关闭留下空歌单；行菜单自行处理）。
import { usePlayer } from '../store';
import { IconHeart, IconMusic, IconPlus } from './icons';

interface Props {
  current?: 'all' | 'favs' | string | null; // 高亮当前目标（select 形态）
  includeAll?: boolean; // 「全部音乐（仅收录）」选项；行内添加对已在库的曲目无意义，默认隐藏
  onPick: (target: 'all' | 'favs' | string) => void;
  onNew: () => void;
}

export default function PlaylistPicker({ current, includeAll = false, onPick, onNew }: Props) {
  const libOrder = usePlayer((s) => s.libOrder);
  const favs = usePlayer((s) => s.favs);
  const playlists = usePlayer((s) => s.playlists);
  return (
    <div className="pl-picker">
      {includeAll && (
        <button className={`pl-pick-item${current === 'all' ? ' on' : ''}`} onClick={() => onPick('all')}>
          <IconMusic size={15} />
          <span className="grow">全部音乐（仅收录）</span>
          <span className="cnt">{libOrder.length}</span>
        </button>
      )}
      <button className={`pl-pick-item${current === 'favs' ? ' on' : ''}`} onClick={() => onPick('favs')}>
        <IconHeart size={15} />
        <span className="grow">我的喜欢</span>
        <span className="cnt">{favs.length}</span>
      </button>
      {playlists.map((p) => (
        <button key={p.id} className={`pl-pick-item${current === p.id ? ' on' : ''}`} onClick={() => onPick(p.id)}>
          <span className="grow">{p.name}</span>
          <span className="cnt">{p.keys.length} 首</span>
        </button>
      ))}
      {playlists.length === 0 && <div className="pl-pick-empty">还没有自建歌单</div>}
      <button className="pl-pick-item new" onClick={onNew}>
        <IconPlus size={15} />
        <span className="grow">新建歌单</span>
      </button>
    </div>
  );
}
