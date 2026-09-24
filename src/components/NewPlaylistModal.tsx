// 新建歌单弹窗：侧栏「+」与行菜单「添加到歌单 → 新建」共用。
// 同名不静默新建——提示将使用已有歌单，按钮文案随之变化。
import { useEffect, useRef, useState } from 'react';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { usePlayer } from '../store';
import { IconX } from './icons';

interface Props {
  /** 确认键文案，默认「创建」；行菜单场景用「创建并添加」 */
  confirmText?: string;
  /** id = 命中已有歌单或新建的歌单；existed = 是否命中了同名 */
  onCreated: (id: string, existed: boolean) => void;
  onClose: () => void;
}

export default function NewPlaylistModal({ confirmText = '创建', onCreated, onClose }: Props) {
  const playlists = usePlayer((s) => s.playlists);
  const [name, setName] = useState('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => registerEsc(() => onCloseRef.current()), []);
  useModalFocus(modalRef); // Tab 限制在弹窗内，不穿透到背景（审查 R6）

  const trimmed = name.trim();
  const exist = playlists.find((p) => p.name === trimmed);

  function confirm() {
    if (!trimmed) return;
    if (exist) {
      onCreated(exist.id, true);
    } else {
      onCreated(usePlayer.getState().createPlaylist(trimmed), false);
    }
    onCloseRef.current();
  }

  return (
    <div className="modal-mask confirm-mask" onClick={onClose}>
      <div className="modal confirm-modal" tabIndex={-1} ref={modalRef} role="dialog" aria-modal="true" aria-label="新建歌单" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          <IconX />
        </button>
        <h3 className="confirm-title">新建歌单</h3>
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
        {exist && <div className="np-dup">已有同名歌单「{exist.name}」，将直接使用它</div>}
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn accent" disabled={!trimmed} onClick={confirm}>
            {exist ? `使用「${trimmed}」` : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
