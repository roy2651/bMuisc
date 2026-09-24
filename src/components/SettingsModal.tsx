// 设置弹窗：账号（B站扫码登录）+「关于 / 更新」+ 数据管理（危险区集中）。
// 内容区独立滚动（审查 R5：880×580 小窗下底部行必须可达），标题与关闭键常驻。
// 更新区仅 Windows 生产构建显示（macOS 公证后放开，见 src/updater.ts）。
import { useEffect, useRef, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { usePlayer } from '../store';
import { useSession } from '../session';
import { useUiBus } from '../uiBus';
import { autoUpdateEnabled, checkForUpdate, setAutoUpdateEnabled, updaterSupported } from '../updater';
import ConfirmModal from './ConfirmModal';
import ThumbImg from './ThumbImg';
import { IconUser, IconX } from './icons';

interface Props {
  version: string;
  onClose: () => void;
  onFoundUpdate: (update: Update) => void;
}

export default function SettingsModal({ version, onClose, onFoundUpdate }: Props) {
  const canUpdate = updaterSupported();
  const [auto, setAuto] = useState(autoUpdateEnabled());
  const [checkState, setCheckState] = useState<'idle' | 'checking' | 'latest' | 'fail'>('idle');
  const [loggingOut, setLoggingOut] = useState(false);
  // 清除数据：按钮只负责打开确认弹窗（范围），确认后执行
  const [clearScope, setClearScope] = useState<'all' | 'synced' | 'lib' | null>(null);
  const sessionState = useSession((s) => s.state);
  const sessionRefresh = useSession((s) => s.refresh);
  const sessionLogout = useSession((s) => s.logout);
  const playlistCount = usePlayer((s) => s.playlists.length);
  // 只统计「从B站导入」的歌单：仅推送过的本地自建歌单虽带 biliMlid（biliSrc='push'），
  // 不属于本清理项的范围（复审 F2）
  const importedCount = usePlayer((s) => s.playlists.filter((p) => p.biliMlid && p.biliSrc !== 'push').length);
  const trackCount = usePlayer((s) => s.libOrder.length);
  const modalRef = useRef<HTMLDivElement>(null);

  // 弹窗打开时查一次登录态（启动后台已有兜底查询，这里保证展示新鲜）
  useEffect(() => {
    void sessionRefresh();
  }, [sessionRefresh]);

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

  // 清除（确认弹窗后执行）：只动本地，B站收藏夹永远不碰
  function doClear(scope: 'all' | 'synced' | 'lib') {
    const st = usePlayer.getState();
    if (scope === 'lib') {
      st.clearLibrary();
      st.notify('已清空全部音乐数据');
      return;
    }
    const before = st.playlists.length;
    st.clearPlaylists(scope);
    const cleared = before - usePlayer.getState().playlists.length;
    st.notify(cleared > 0 ? `已清除 ${cleared} 个本地歌单` : '没有可清除的本地歌单');
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal"
        tabIndex={-1}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          <IconX />
        </button>
        <div className="modal-head upd-head">
          <div className="modal-head-info">
            <h2>设置</h2>
            <p>账号 / 关于与更新 / 数据管理</p>
          </div>
        </div>

        <div className="set-body">
          <div className="set-sec">账号</div>
          <div className="set-row">
            <div>
              <div className="acct-user">
                {sessionState?.user?.face ? (
                  <ThumbImg className="acct-avatar" cover={sessionState.user.face} size="sm" />
                ) : (
                  <span className="acct-avatar empty">
                    <IconUser size={16} />
                  </span>
                )}
                <div>
                  <p className="acct-name">
                    {sessionState?.loggedIn ? sessionState.user?.uname || `B站用户 ${sessionState.user?.mid}` : '未登录'}
                  </p>
                  <p className="acct-mid">
                    {sessionState?.loggedIn ? `MID ${sessionState.user?.mid} · 凭证存于系统安全存储` : '尚未登录B站账号'}
                  </p>
                </div>
              </div>
              <p className="set-desc">登录后可从B站导入收藏夹，也能把本地歌单推送回B站</p>
            </div>
            {sessionState?.loggedIn ? (
              <button
                className="btn ghost sm"
                disabled={loggingOut}
                onClick={async () => {
                  setLoggingOut(true);
                  try {
                    await sessionLogout();
                  } finally {
                    setLoggingOut(false);
                  }
                }}
              >
                登出
              </button>
            ) : (
              <button className="btn ghost sm" onClick={() => useUiBus.getState().openQr()}>
                扫码登录
              </button>
            )}
          </div>

          <div className="set-sec">关于与更新</div>
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

          <div className="set-sec danger">数据管理 · 危险区</div>
          <p className="set-danger-note">以下操作只影响本机数据，B站收藏夹永远不受影响</p>
          <div className="set-row">
            <div>
              <p className="set-label">清除从B站导入的歌单</p>
              <p className="set-desc">
                {sessionState?.loggedIn
                  ? importedCount > 0
                    ? `删除 ${importedCount} 个从B站收藏夹导入生成的本地歌单，仅属于它们音乐会一并移出曲库；本地自建、仅推送过的歌单不受影响；B站收藏夹不受影响`
                    : '还没有从B站导入生成的歌单'
                  : '登录后可按导入来源清除'}
              </p>
            </div>
            <button
              className="btn ghost sm"
              disabled={!sessionState?.loggedIn || importedCount === 0}
              onClick={() => setClearScope('synced')}
            >
              清除 {importedCount} 个
            </button>
          </div>
          <div className="set-row">
            <div>
              <p className="set-label">清除全部本地歌单</p>
              <p className="set-desc">
                删除所有自建歌单（{playlistCount} 个），仅属于它们的音乐会一并移出曲库，喜欢的音乐保留；B站收藏夹不受影响
              </p>
            </div>
            <button className="btn ghost sm" disabled={playlistCount === 0} onClick={() => setClearScope('all')}>
              一键清除
            </button>
          </div>
          <div className="set-row">
            <div>
              <p className="set-label">清空全部音乐</p>
              <p className="set-desc">
                清空曲目库（{trackCount} 首）并删除全部歌单、喜欢与最近播放记录；B站收藏夹与当前播放不受影响
              </p>
            </div>
            <button className="btn ghost sm" disabled={trackCount === 0} onClick={() => setClearScope('lib')}>
              清空
            </button>
          </div>
        </div>

        {clearScope !== null && (
          <ConfirmModal
            title={clearScope === 'all' ? '清除全部本地歌单' : clearScope === 'synced' ? '清除从B站导入的歌单' : '清空全部音乐'}
            body={
              clearScope === 'all'
                ? `将删除全部 ${playlistCount} 个本地歌单；其中未被「我的喜欢」引用的音乐会一并从曲库移除。B站收藏夹不受影响。`
                : clearScope === 'synced'
                  ? `将删除 ${importedCount} 个从B站收藏夹导入生成的本地歌单；其中未被「我的喜欢」或保留歌单引用的音乐会一并从曲库移除。本地自建、仅推送过的歌单不受影响；B站收藏夹不受影响。`
                  : `将清空曲目库（${trackCount} 首）并删除全部歌单、「我的喜欢」与最近播放记录，恢复到空白状态。B站收藏夹与当前播放不受影响。`
            }
            confirmText={clearScope === 'lib' ? '清空' : '清除'}
            danger
            onConfirm={() => doClear(clearScope)}
            onClose={() => setClearScope(null)}
          />
        )}
      </div>
    </div>
  );
}

// 说明：扫码登录弹窗由 App 层按 useUiBus.qrOpen 渲染（顶栏「登录」与设置共用），
// 这里不再内嵌。
