// 推送到B站：把本地歌单写回B站收藏夹。
// B 站收藏粒度是「稿件」（fav/resource/deal 的 rid=aid），同一视频的多 P 会合并为
// 一条收藏——本地按 bvid 去重后逐条推送；deal 幂等，重复推送不产生重复收藏。
// 目标：已绑定收藏夹默认预选，也可换绑或新建（默认私密）；推送成功即按绑定语义
// 持久化目标关联（仅追加，不镜像删除）。绑定来源（biliSrc）由 store 写后不变地记录——
// 推送不会把导入建立的歌单改标成 push 来源（复审第三轮 P2）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { usePlayer } from '../store';
import { favCreateFolder, favFolders, favPush, type FavFolder } from '../session';
import { IconLock, IconX } from './icons';

type Phase = 'pick' | 'pushing' | 'done';

interface PushResult {
  ok: number;
  failed: { title: string; reason: string }[];
  mlid: string;
  folderName: string;
  aborted: boolean;
  bound: boolean; // 本次是否持久化了歌单 ↔ 收藏夹关联（新建夹必然绑定；推已有夹需有成功写入）
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function FavPushModal({ playlistId, onClose }: { playlistId: string; onClose: () => void }) {
  const pl = usePlayer((s) => s.playlists.find((p) => p.id === playlistId));
  const lib = usePlayer((s) => s.lib);
  const bindPlaylistBili = usePlayer((s) => s.bindPlaylistBili);
  const notify = usePlayer((s) => s.notify);
  const [phase, setPhase] = useState<Phase>('pick');
  const [folders, setFolders] = useState<FavFolder[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // existing = 推到已有收藏夹（默认绑定的那个）；new = 新建收藏夹
  const [mode, setMode] = useState<'existing' | 'new'>(pl?.biliMlid ? 'existing' : 'new');
  const [selected, setSelected] = useState<string | null>(pl?.biliMlid ?? null);
  const [newName, setNewName] = useState(pl?.name ?? '');
  const [newPrivate, setNewPrivate] = useState(true);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [result, setResult] = useState<PushResult | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 在途推送任务：任何关闭入口（取消/X/遮罩/Esc/卸载）都置 cancelled，
  // 循环在每个 await 后检查——创建收藏夹请求返回前取消，也不会再发后续收藏请求
  const taskRef = useRef<{ cancelled: boolean } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // 仅引用 ref，恒定标识：Esc/取消/X/遮罩统一走它中止任务后再关闭
  const close = useCallback(() => {
    if (taskRef.current) taskRef.current.cancelled = true;
    onCloseRef.current();
  }, []);

  useEffect(() => registerEsc(close), [close]);
  // 卸载兜底：父层（App）提前卸载本弹窗时同样中止在途任务
  useEffect(
    () => () => {
      if (taskRef.current) taskRef.current.cancelled = true;
    },
    [],
  );
  useModalFocus(modalRef);

  useEffect(() => {
    let cancelled = false;
    favFolders()
      .then((f) => !cancelled && setFolders(f))
      .catch((e) => !cancelled && setLoadErr(errText(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const uniqBvids: { bvid: string; title: string }[] = [];
  if (pl) {
    const seen = new Set<string>();
    for (const k of pl.keys) {
      const t = lib[k];
      if (t && !seen.has(t.bvid)) {
        seen.add(t.bvid);
        uniqBvids.push({ bvid: t.bvid, title: t.source || t.title });
      }
    }
  }

  // 绑定的收藏夹已不存在（B站侧删除 / 切换账号后列表里没有）：预选失效，
  // 必须禁止推送并说明原因（复审 F1：否则进 pushing 后查无目标，永久停在 0/N）
  const staleSelected =
    mode === 'existing' && selected !== null && folders !== null && !folders.some((f) => f.id === selected);

  async function startPush() {
    if (!pl || taskRef.current) return; // 任务独占：等待创建响应时按钮不可重复提交
    // 全部校验先于阶段切换（复审 F1）：先切 pushing 再 return 会永久停在 0/N。
    // 目标存在性 / 名称 / 曲目数在 pick 态拦下；异步建夹失败由 catch 退回 pick 提示
    if (uniqBvids.length === 0) return;
    let pendingName = '';
    if (mode === 'new') {
      pendingName = newName.trim();
      if (!pendingName) return; // 空名称 Enter：留在选择页
    } else if (!folders?.some((f) => f.id === selected)) {
      setLoadErr('所选收藏夹已不存在（可能已被删除或账号已切换），请重新选择推送目标');
      return;
    }
    const task = { cancelled: false };
    taskRef.current = task;
    try {
      setPhase('pushing');
      setProgress({ done: 0, total: uniqBvids.length, current: mode === 'new' ? '正在创建收藏夹…' : '' });
      let mlid = '';
      let folderName = '';
      try {
        if (mode === 'new') {
          mlid = await favCreateFolder(pendingName, newPrivate);
          folderName = pendingName;
        } else {
          const f = folders?.find((x) => x.id === selected);
          if (!f) {
            // 上方已校验，此处仅在列表被并发改动时命中：退回选择页，绝不卡在 0/N
            setPhase('pick');
            return;
          }
          mlid = f.id;
          folderName = f.title;
        }
      } catch (e) {
        if (task.cancelled) return;
        setLoadErr(errText(e));
        setPhase('pick');
        return;
      }
      if (task.cancelled) return;
      const ok: string[] = [];
      const failed: { title: string; reason: string }[] = [];
      let aborted = false;
      for (let i = 0; i < uniqBvids.length; i++) {
        if (task.cancelled) return;
        const { bvid, title } = uniqBvids[i];
        setProgress({ done: i, total: uniqBvids.length, current: title });
        try {
          await favPush(mlid, bvid);
          ok.push(bvid);
        } catch (e) {
          const reason = errText(e);
          failed.push({ title, reason });
          if (reason.includes('登录已过期')) {
            aborted = true; // 凭证失效：继续推只会全部失败，停下汇报
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 350)); // 写操作受控速率
        if (task.cancelled) return;
      }
      taskRef.current = null;
      // 绑定语义（审查 R8）：新建收藏夹必然绑定；推到已有收藏夹只要有成功写入，
      // 也按「换绑/首次关联」持久化目标——之后推送与导入都认它。
      // src='push' 只在歌单还没有建立来源时生效（本地自建首次推送）；导入建立的
      // 歌单保持 import 来源，不因推送被改标（复审第三轮 P2）
      const bound = mode === 'new' || ok.length > 0;
      if (bound) bindPlaylistBili(pl.id, mlid, 'push');
      notify(
        failed.length === 0 ? `已推送 ${ok.length} 条到B站收藏夹「${folderName}」` : `推送完成：成功 ${ok.length} 条，失败 ${failed.length} 条`,
      );
      setResult({ ok: ok.length, failed, mlid, folderName, aborted, bound });
      setPhase('done');
    } finally {
      if (taskRef.current === task) taskRef.current = null;
    }
  }

  if (!pl) return null;
  const pushable =
    mode === 'new' ? newName.trim().length > 0 : !!selected && !staleSelected && !!folders?.some((f) => f.id === selected);

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal" tabIndex={-1} ref={modalRef} role="dialog" aria-modal="true" aria-label="推送到B站" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={close} aria-label="关闭">
          <IconX />
        </button>
        <div className="modal-head-info qr-head">
          <h2>推送到B站</h2>
          <p>
            歌单「{pl.name}」· {uniqBvids.length} 个视频
            {pl.biliMlid ? ' · 已关联收藏夹' : ''}
          </p>
        </div>

        {phase === 'pick' && (
          <>
            <p className="push-hint">
              B 站收藏以「视频整稿」为单位：同一视频的分 P 会合并为一条收藏；已在收藏夹里的视频重复推送不会产生重复。
              推送只追加收藏，不会删除或改动B站已有的内容。
            </p>
            {loadErr && <div className="fav-result bad">{loadErr}</div>}
            <div className="modal-list">
              <label className="pick-row pick-head">
                <input
                  type="radio"
                  checked={mode === 'new'}
                  onChange={() => {
                    setMode('new');
                    setLoadErr(null);
                  }}
                />
                <span className="pick-title">新建收藏夹</span>
              </label>
              {mode === 'new' && (
                <div className="new-folder-row">
                  <input
                    autoFocus
                    value={newName}
                    placeholder="收藏夹名称，默认用歌单名"
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === 'Enter') startPush();
                    }}
                  />
                  <label className="new-private">
                    <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} />
                    私密
                  </label>
                </div>
              )}
              {folders !== null && folders.length > 0 && (
                <label className="pick-row pick-head">
                  <input
                    type="radio"
                    checked={mode === 'existing'}
                    onChange={() => {
                      setMode('existing');
                      setLoadErr(null);
                    }}
                  />
                  <span className="pick-title">推送到已有收藏夹</span>
                </label>
              )}
              {mode === 'existing' && (
                <>
                  {staleSelected && (
                    <div className="fav-result bad">
                      原关联的收藏夹已不存在（可能已被删除或当前账号下没有此收藏夹），请重新选择目标或改为新建
                    </div>
                  )}
                  {folders === null && !loadErr && <div className="pl-pick-empty">正在获取收藏夹…</div>}
                  {folders !== null && folders.length === 0 && (
                    <div className="pl-pick-empty">B站账号里还没有收藏夹，可改为新建</div>
                  )}
                  {folders?.map((f) => (
                    <label key={f.id} className="pick-row">
                      <input
                        type="radio"
                        name="push-folder"
                        checked={selected === f.id}
                        onChange={() => {
                          setSelected(f.id);
                          setLoadErr(null);
                        }}
                      />
                      <span className="pick-title">{f.title}</span>
                      {f.private && (
                        <span className="fav-lock" title="私密收藏夹">
                          <IconLock size={12} />
                        </span>
                      )}
                      <span className="pick-dur">{f.mediaCount} 条</span>
                    </label>
                  ))}
                </>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={close}>
                取消
              </button>
              <button className="btn accent" disabled={!pushable || uniqBvids.length === 0} onClick={startPush}>
                {mode === 'new' ? `创建「${newName.trim() || '…'}」并推送` : '开始推送'}
              </button>
            </div>
          </>
        )}

        {phase === 'pushing' && (
          <>
            <div className="fav-progress">
              <div className="fav-progress-line">
                <span className="cur" title={progress.current}>
                  {progress.current || '…'}
                </span>
                <span>
                  {progress.done}/{progress.total}
                </span>
              </div>
              <div className="fav-bar">
                <i style={{ width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : '8%' }} />
              </div>
            </div>
            <div className="fav-progress-foot">
              <span className="fav-stop-note">已推送成功的条目保留（重复推送不会产生重复收藏）</span>
              <button className="btn ghost sm" onClick={close}>
                停止
              </button>
            </div>
          </>
        )}

        {phase === 'done' && result && (
          <>
            <div className="fav-result">
              <p className={result.failed.length === 0 ? 'ok' : ''}>
                已推送 {result.ok} 条视频到「{result.folderName}」
              </p>
              {result.aborted && <p className="bad">登录已过期，推送中止，请重新扫码后再推</p>}
              {result.failed.length > 0 && (
                <p className="bad">
                  {result.failed.length} 条失败（{result.failed[0].title}
                  {result.failed.length > 1 ? ' 等' : ''}）：{result.failed[0].reason}
                </p>
              )}
              {result.bound && <p className="fav-bind-note">歌单已关联收藏夹「{result.folderName}」，之后推送与导入都以此为准</p>}
            </div>
            <div className="modal-foot">
              <button className="btn accent" onClick={close}>
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
