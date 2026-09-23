// 「发现新版本」弹窗：提示 → 下载进度 → 安装。Windows 上安装器执行时应用
// 会自动退出并以新版本重启（passive 模式 /R 参数），下载 / 安装阶段因此
// 禁止关闭弹窗，避免用户在应用闪退时误以为更新失败。
import { useEffect, useRef, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { checkForUpdate } from '../updater';
import { IconX } from './icons';

type Phase = 'confirm' | 'downloading' | 'installing';

interface Props {
  update: Update;
  onClose: () => void;
}

const fmtMB = (n: number) => (n / 1024 / 1024).toFixed(1);
// 下载停滞判定：插件默认没有请求超时（下面传入的 15 分钟总超时只是兜底），
// 连接建立后迟迟不来数据时 download 的 Promise 会长时间挂起，而下载阶段
// 弹窗不可关闭——用户会被卡死在弹窗里（已复现）。30 秒收不到任何进度事件
// 即按失败处理，回到可关闭 / 可重试的确认态。
const STALL_MS = 30_000;
// 整个下载的总超时兜底：看门狗只管停滞，这里限制挂起下载的最大生命周期
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

// 失效尝试的下载完成后，插件把整包安装包缓冲作为资源挂在 Update 实例上
// （downloadedBytes，插件 JS 封装 dist-js/index.js 的 download()），没人安装
// 就没人释放，会一直留在 Rust 资源表直至应用退出（审查复现：三次停滞→复活
// →完成留下三个缓冲句柄）。这里在确定不安装 / 安装失败时主动 close 释放。
// 每次尝试持有独立 Update 实例（重试时重新 check，见 start），该字段不会跨
// 尝试共享，这里读到的必然是该实例自己最近一次下载的缓冲；安装成功由 Rust
// 侧释放并清空字段，这里兜底的是安装失败 / 从不安装的路径，重复释放的报错
// 吞掉。字段是插件私有字段，经运行时断言访问；升级插件时需留意字段名。
function releaseDownloaded(update: Update): void {
  const instance = update as unknown as {
    downloadedBytes?: { close(): Promise<void> } | undefined;
  };
  const bytes = instance.downloadedBytes;
  if (!bytes) return;
  // 先摘字段再释放：插件封装的 Update.close() 会先关 downloadedBytes 再关
  // Update 本体（dist-js/index.js 的 close()），悬空字段会对已释放的 rid 二次
  // close 而 reject，短路掉 Update 本体的释放——插件安装成功路径清字段的
  // 「免 close」正是同款处理
  instance.downloadedBytes = undefined;
  void bytes.close().catch(() => {});
}

export default function UpdateModal({ update, onClose }: Props) {
  // 本次尝试所用的 Update 实例：首次用 App 检查到的实例，重试时 start() 里
  // 重新 check 换入独立实例（插件把下载缓冲资源挂在实例字段上，跨尝试共用
  // 同一实例会相互覆盖该字段，已复现释放错对象）；App 换入新实例（设置里
  // 手动检查）时跟随
  const [current, setCurrent] = useState(update);
  const [phase, setPhase] = useState<Phase>('confirm');
  // 重试时重新 check 更新清单的短暂窗口（见 start）：状态文案区分「检查」「下载」
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState({ got: 0, total: null as number | null });
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  // 尝试标记：停滞判失败后底层下载无法真正取消（插件无取消 API），重试会
  // 换新实例另起一次下载（见 start）——旧尝试迟到的进度/完成事件靠它全部
  // 丢弃，不污染新进度；僵尸下载即使完成也会因标记失效被丢弃，绝不会触发
  // 安装（其安装包缓冲在完成处经自己的实例释放，见 releaseDownloaded）
  const attemptRef = useRef(0);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef);

  // App 换入新 Update（设置里手动检查发现更新）时跟随；重试换入由 start() 设置
  useEffect(() => {
    setCurrent(update);
  }, [update]);

  // 仅确认阶段可用 Esc 关闭；Esc 走共享栈，多弹窗叠加时只关本层（最上层）
  useEffect(
    () =>
      registerEsc(() => {
        if (!runningRef.current) onClose();
      }),
    [onClose],
  );

  // Update 实例变更 / 卸载时释放 Rust 侧资源（Update 本体，小结构）；重复
  // 释放的报错忽略。下载进行中不释放：此刻换入新实例（设置手动检查 / 重试
  // 重新 check），旧实例可能还有底层下载在进行，其缓冲由完成续体释放，这里
  // 不掺和；若因此漏关的 Update 本体留待应用退出，量级可忽略
  useEffect(() => {
    const instance = current;
    return () => {
      if (!runningRef.current) void instance.close().catch(() => {});
    };
  }, [current]);

  async function start() {
    if (runningRef.current) return;
    runningRef.current = true;
    const attempt = ++attemptRef.current;
    setError(null);
    setPhase('downloading');
    // 立即归零：重试瞬间到新尝试的 Started 事件之间不显示上一次的残留进度
    setProgress({ got: 0, total: null });
    let lastEventAt = Date.now();
    const watchdog = window.setInterval(() => {
      if (attemptRef.current !== attempt) return;
      if (Date.now() - lastEventAt > STALL_MS) {
        window.clearInterval(watchdog);
        attemptRef.current++; // 本尝试作废：迟到的进度/完成事件全部丢弃
        runningRef.current = false; // 恢复可关闭/可重试
        setPhase('confirm');
        setError('下载停滞（超过 30 秒无进展），请检查网络后重试');
      }
    }, 5000);
    // 本次尝试所用的实例：首次直接用 App 检查到的实例；重试重新 check 换入
    // 独立实例——插件把整包缓冲资源挂在实例私有字段 downloadedBytes 上，同一
    // 实例的多次下载会覆盖同一字段，旧尝试完成后的清理与新尝试的安装读的是
    // 同一个字段，交错时（隔离 IPC 模拟已复现）会释放错对象：新缓冲被误关、
    // 旧缓冲成孤儿泄漏。每次尝试独立实例后字段互不可见，彻底隔离；代价是
    // 重试多一次 latest.json 请求（清单很小，15 秒超时，也喂不饱 30 秒看门狗）。
    // 声明在 try 外：catch 的兜底释放也要读它
    let target = update;
    try {
      if (attempt > 1) {
        setChecking(true);
        const next = await checkForUpdate().finally(() => setChecking(false));
        if (attemptRef.current !== attempt) return; // 防御：检查期间不会被作废
        if (!next) {
          // latest.json 已不再提供更新（如发布被撤回）：没有可装的东西，收场
          onClose();
          return;
        }
        target = next;
        setCurrent(next);
      }
      lastEventAt = Date.now(); // recheck 不占停滞窗口：30 秒从下载真正开始计
      // 拆分 download / install（P1）：停滞作废后僵尸下载只会在完成时被丢弃，
      // 绝不会走到 install——若不拆分，网络恢复会让旧请求完成并背着用户静默
      // 安装退出应用（违背「手动确认才更新」）；重试与僵尸下载并行时也只有
      // 当前尝试会安装。两次下载的缓冲按调用隔离（插件源码确认），互不污染。
      await target.download(
        (event) => {
          if (attemptRef.current !== attempt) return; // 已放弃的旧尝试
          lastEventAt = Date.now();
          if (event.event === 'Started') {
            // 重试是从零下载（插件无断点续传），进度必须归零，否则第二次尝试的
            // 进度会叠加第一次的字节数，进度条虚高直到卡在 100%
            setProgress({ got: 0, total: event.data.contentLength ?? null });
          } else if (event.event === 'Progress') {
            setProgress((p) => ({ ...p, got: p.got + event.data.chunkLength }));
          } else if (event.event === 'Finished') {
            window.clearInterval(watchdog); // 安装阶段没有进度事件，别误判停滞
          }
        },
        { timeout: DOWNLOAD_TIMEOUT_MS },
      );
      if (attemptRef.current !== attempt) {
        // 僵尸下载完成：没人会安装它，主动释放安装包缓冲，别留整包字节在
        // Rust 资源表直至退出。此处代码在弹窗卸载后仍会执行（Promise 续体），
        // 覆盖「停滞 → 稍后再说 → 旧下载复活完成」的路径
        releaseDownloaded(target);
        return; // 已被判停滞/被重试取代作废：丢弃下载，绝不安装
      }
      setPhase('installing'); // 进入安装（Windows 上应用即将自动退出重启）
      await target.install({ restartAfterInstall: true });
    } catch (e) {
      if (attemptRef.current !== attempt) return;
      // 安装失败时缓冲未被消费（成功路径由 Rust 侧释放）；下载 / 检查失败则
      // 字段尚未写入，这里是空操作。target 是本尝试独享的实例，字段可靠
      releaseDownloaded(target);
      setPhase('confirm');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      window.clearInterval(watchdog);
      if (attemptRef.current === attempt) runningRef.current = false;
    }
  }

  const pct = progress.total ? Math.min(100, Math.round((progress.got / progress.total) * 100)) : null;

  return (
    <div className="modal-mask" onClick={() => phase === 'confirm' && !runningRef.current && onClose()}>
      <div className="modal" tabIndex={-1} ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭" disabled={phase !== 'confirm'}>
          <IconX />
        </button>
        <div className="modal-head upd-head">
          <div className="modal-head-info">
            <h2>发现新版本 v{current.version}</h2>
            <p>当前版本 v{current.currentVersion}，更新完成后应用会自动重启</p>
          </div>
        </div>

        {phase === 'confirm' && (
          <>
            {current.body && <div className="upd-notes">{current.body}</div>}
            {error && <p className="upd-error">更新失败：{error}</p>}
            <div className="modal-foot">
              <button className="btn ghost" onClick={onClose}>稍后再说</button>
              <button className="btn primary" onClick={start}>立即更新</button>
            </div>
          </>
        )}

        {phase !== 'confirm' && (
          <>
            <div className="upd-progress">
              <div className="upd-bar" style={{ width: pct != null ? `${pct}%` : '40%' }} />
            </div>
            <p className="upd-status">
              {phase === 'downloading'
                ? checking
                  ? '正在检查更新…'
                  : `正在下载 ${fmtMB(progress.got)} MB${progress.total ? ` / ${fmtMB(progress.total)} MB${pct != null ? `（${pct}%）` : ''}` : ''}…`
                : '正在安装，应用即将自动重启…'}
            </p>
            {error && <p className="upd-error">更新失败：{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
