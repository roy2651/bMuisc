// 设置弹窗：首版只承载「关于 / 更新」——版本信息、启动自动检查开关、手动检查。
// 更新区仅 Windows 生产构建显示（macOS 公证后放开，见 src/updater.ts）。
import { useEffect, useRef, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { autoUpdateEnabled, checkForUpdate, setAutoUpdateEnabled, updaterSupported } from '../updater';
import { IconX } from './icons';

interface Props {
  version: string;
  onClose: () => void;
  onFoundUpdate: (update: Update) => void;
}

export default function SettingsModal({ version, onClose, onFoundUpdate }: Props) {
  const canUpdate = updaterSupported();
  const [auto, setAuto] = useState(autoUpdateEnabled());
  const [checkState, setCheckState] = useState<'idle' | 'checking' | 'latest' | 'fail'>('idle');
  const modalRef = useRef<HTMLDivElement>(null);

  // Esc 关闭弹窗（与解析弹窗一致）；更新弹窗叠在其上时按 Esc 只关最上层
  useEffect(() => registerEsc(onClose), [onClose]);
  useModalFocus(modalRef);

  async function manualCheck() {
    setCheckState('checking');
    try {
      const u = await checkForUpdate();
      if (u) {
        onFoundUpdate(u);
        onClose();
        return;
      }
      setCheckState('latest');
    } catch {
      setCheckState('fail');
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" tabIndex={-1} ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          <IconX />
        </button>
        <div className="modal-head upd-head">
          <div className="modal-head-info">
            <h2>设置</h2>
            <p>关于与更新</p>
          </div>
        </div>

        <div className="set-row">
          <div>
            <p className="set-label">版本</p>
            <p className="set-desc">{version ? `bMuisc v${version}` : '开发模式'}</p>
          </div>
        </div>

        {canUpdate && (
          <>
            <div className="set-row">
              <div>
                <p className="set-label">启动时检查更新</p>
                <p className="set-desc">启动后连接 GitHub 检查新版本，发现后弹窗提醒，手动确认才会下载</p>
              </div>
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.target.checked);
                  setAutoUpdateEnabled(e.target.checked);
                }}
              />
            </div>
            <div className="set-row">
              <div>
                <p className="set-label">检查更新</p>
                <p className="set-desc">
                  {checkState === 'latest' ? '当前已是最新版本' : checkState === 'fail' ? '检查失败，请确认网络后重试' : checkState === 'checking' ? '正在检查…' : '立即连接 GitHub 检查是否有新版本'}
                </p>
              </div>
              <button className="btn ghost sm" disabled={checkState === 'checking'} onClick={manualCheck}>
                检查
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
