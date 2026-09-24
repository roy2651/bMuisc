// 重命名歌单弹窗：侧栏歌单 ⋯ 菜单与列表页共用入口；同名（不含自己）拒绝提交。
import { useEffect, useRef, useState } from 'react';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { usePlayer } from '../store';
import { IconX } from './icons';

export default function RenamePlaylistModal({ playlistId, onClose }: { playlistId: string; onClose: () => void }) {
  const pl = usePlayer((s) => s.playlists.find((p) => p.id === playlistId));
  const [name, setName] = useState(pl?.name ?? '');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => registerEsc(() => onCloseRef.current()), []);
  useModalFocus(modalRef); // Tab 限制在弹窗内，不穿透到背景（审查 R6）

  if (!pl) return null;
  const trimmed = name.trim();
  const dup = trimmed !== pl.name && usePlayer.getState().playlists.some((p) => p.id !== playlistId && p.name === trimmed);

  function confirm() {
    if (!trimmed || dup) return;
    usePlayer.getState().renamePlaylist(playlistId, trimmed);
    usePlayer.getState().notify(`已重命名为「${trimmed}」`);
    onCloseRef.current();
  }

  return (
    <div
      className="modal-mask confirm-mask"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="modal confirm-modal" tabIndex={-1} ref={modalRef} role="dialog" aria-modal="true" aria-label="重命名歌单" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          <IconX />
        </button>
        <h3 className="confirm-title">重命名歌单</h3>
        <input
          autoFocus
          className="np-input"
          value={name}
          placeholder="歌单名称"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') confirm();
          }}
        />
        {dup && <div className="np-dup">已有同名歌单，换个名字吧</div>}
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn accent" disabled={!trimmed || dup} onClick={confirm}>
            重命名
          </button>
        </div>
      </div>
    </div>
  );
}
