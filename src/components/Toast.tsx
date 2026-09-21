// 底部中央轻提示：保存结果反馈（可带「查看歌单」动作）、移除撤销入口。
// 自动消失，不抢占焦点，不打断用户继续收集音乐。
import { usePlayer } from '../store';
import { IconX } from './icons';

export default function Toast() {
  const toast = usePlayer((s) => s.toast);
  const dismissToast = usePlayer((s) => s.dismissToast);
  if (!toast) return null;
  return (
    <div className="toast" role="status" key={toast.id}>
      <span className="toast-text">{toast.text}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            dismissToast();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" onClick={dismissToast} aria-label="关闭提示">
        <IconX size={13} />
      </button>
    </div>
  );
}
