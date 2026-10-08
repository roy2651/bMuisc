// 扫码登录弹窗：渲染B站登录二维码 + 轮询扫码状态。
// 状态机：loading → waiting → scanned → success（86038 过期自动换新码重来）。
// 网络失败自动重试；凭证在 Rust 侧入库（OS 安全存储），前端只收登录结果。
// 登录尝试带前端生成的 attemptId：轮询随代际号（epoch）上报，关窗/登出/换码后
// 原生侧丢弃迟到结果不落库；取消按 attemptId 定向——旧弹窗迟到的取消
// 不会作废新弹窗的登录。
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { usePlayer } from '../store';
import { loginQrCancel, loginQrGenerate, loginQrPoll, useSession, type SessionUser } from '../session';
import { IconX } from './icons';

type Phase = 'loading' | 'waiting' | 'scanned' | 'success' | 'error';

const PHASE_TEXT: Record<Phase, string> = {
  loading: '正在获取二维码…',
  waiting: '等待扫码…',
  scanned: '已扫码，请在手机上确认',
  success: '登录成功',
  error: '连接失败，正在重试…',
};

export default function LoginQrModal({ onClose }: { onClose: () => void }) {
  const [qrData, setQrData] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const refresh = useSession((s) => s.refresh);
  const notify = usePlayer((s) => s.notify);
  // 轮询循环只跑一次；关闭回调走 ref，避免父组件重渲染导致二维码反复重生成
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => registerEsc(() => onCloseRef.current()), []);
  // 焦点接管：Tab 限制在弹窗内，不穿透到底层弹窗/页面（审查 R6）
  useModalFocus(modalRef);

  useEffect(() => {
    let cancelled = false;
    let succeeded = false; // 登录已成功：卸载时不再作废（凭证已落库，作废无意义）
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 本次弹窗的登录尝试 ID：取消按它定向，只作废本弹窗的在途登录
    const attemptId = crypto.randomUUID();
    const sleep = (ms: number) => new Promise<void>((r) => (timer = setTimeout(r, ms)));
    (async () => {
      // 外层循环：过期/网络失败后重新取码；内层循环：1.5s 轮询扫码状态
      while (!cancelled) {
        try {
          setPhase('loading');
          setQrData(null);
          const { url, qrcodeKey, epoch } = await loginQrGenerate(attemptId);
          if (cancelled) return;
          setQrData(
            await QRCode.toDataURL(url, { width: 216, margin: 1, color: { dark: '#12151c', light: '#ffffff' } }),
          );
          setPhase('waiting');
          let expired = false;
          while (!cancelled && !expired) {
            await sleep(1500);
            if (cancelled) return;
            const r = await loginQrPoll(qrcodeKey, epoch);
            if (cancelled) return;
            if (r.status === 'cancelled') return; // 本次登录已被作废（登出/换新码）：静默停止
            if (r.status === 'success' && r.user) {
              succeeded = true;
              setUser(r.user);
              setPhase('success');
              void refresh();
              notify(`欢迎，${r.user.uname || 'B站用户'}｜凭证已存入系统安全存储`);
              await sleep(900); // 成功态稍作停留再收起
              if (!cancelled) onCloseRef.current();
              return;
            }
            if (r.status === 'scanned') setPhase('scanned');
            if (r.status === 'expired') expired = true; // 180s 有效期已过：回到外层换新码
          }
          if (!cancelled) await sleep(400);
        } catch {
          if (cancelled) return;
          setPhase('error');
          await sleep(2500);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // 关窗/Esc/遮罩/卸载统一走到卸载：按 attemptId 定向作废原生侧在途登录
      // （复审 P2-①）——只置前端 cancelled 不够，在途轮询迟到成功仍会落库；
      // 定向保证这个迟到的取消不会误杀新弹窗已开始的登录
      if (!succeeded) void loginQrCancel(attemptId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-mask" onClick={() => onCloseRef.current()}>
      <div className="modal qr-modal" tabIndex={-1} ref={modalRef} role="dialog" aria-modal="true" aria-label="扫码登录" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={() => onCloseRef.current()} aria-label="关闭">
          <IconX />
        </button>
        <div className="modal-head-info qr-head">
          <h2>扫码登录</h2>
        </div>
        <div className="qr-box">
          {qrData ? (
            <img className="qr-img" src={qrData} alt="B站登录二维码" />
          ) : (
            <div className="qr-img qr-loading">
              <span className="spinner dark" />
            </div>
          )}
        </div>
        <p className="qr-tip">打开B站 App，右上角「扫一扫」确认登录</p>
        <div className={`qr-status ${phase}`} role="status">
          <i />
          <span>{phase === 'success' && user ? `登录成功，欢迎 ${user.uname || user.mid}` : PHASE_TEXT[phase]}</span>
        </div>
      </div>
    </div>
  );
}
