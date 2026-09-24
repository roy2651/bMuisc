// 顶栏账号区：登录入口放在最外层——未登录显示「登录」按钮，点击直接弹扫码；
// 已登录显示头像 + 昵称，点开菜单可从B站导入 / 登出。凭证细节仍在设置里。
import { useEffect, useState } from 'react';
import { usePlayer } from '../store';
import { useSession } from '../session';
import { useUiBus } from '../uiBus';
import ThumbImg from './ThumbImg';
import { IconSync, IconUser } from './icons';

export default function AccountMenu() {
  const state = useSession((s) => s.state);
  const logout = useSession((s) => s.logout);
  const notify = usePlayer((s) => s.notify);
  const [menu, setMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // 菜单开着时 Esc 收起（输入法用 Esc 取消候选词不作数）
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  async function doLogout() {
    setMenu(false);
    setLoggingOut(true);
    try {
      await logout();
      notify('已登出，本机凭证已清除');
    } finally {
      setLoggingOut(false);
    }
  }

  if (!state?.loggedIn) {
    return (
      <button className="btn accent sm top-login" onClick={() => useUiBus.getState().openQr()}>
        登录
      </button>
    );
  }
  const user = state.user;
  return (
    <div className="top-acct">
      <button
        className={`acct-btn${menu ? ' on' : ''}`}
        title={user ? `${user.uname}（MID ${user.mid}）` : 'B站账号'}
        onClick={() => setMenu((v) => !v)}
      >
        {user?.face ? (
          <ThumbImg className="top-avatar" cover={user.face} size="sm" />
        ) : (
          <span className="top-avatar empty">
            <IconUser size={13} />
          </span>
        )}
        <span className="top-name">{user?.uname || `B站用户 ${user?.mid ?? ''}`}</span>
      </button>
      {menu && (
        <>
          <div className="menu-mask" onClick={() => setMenu(false)} />
          <div className="acct-menu">
            <div className="menu-label">{user?.uname} · MID {user?.mid}</div>
            <button
              onClick={() => {
                setMenu(false);
                useUiBus.getState().openImport();
              }}
            >
              <IconSync size={14} /> 从B站导入
            </button>
            <button className="danger" disabled={loggingOut} onClick={doLogout}>
              {loggingOut ? '登出中…' : '登出'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
