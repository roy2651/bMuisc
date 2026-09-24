// 从B站导入：选收藏夹 → 拉取内容 → 逐条解析成可播放曲目 → 落入本地歌单。
// 已按 biliMlid 绑定过的歌单会更新而不是重复新建；解析逐条进行（250ms 间隔，
// 受控速率）；失效视频与音频区条目跳过并在结果中汇报。任何关闭入口（取消/X/
// 遮罩/Esc/卸载）都会中止在途任务，中止的导入不落库。只做本地落地，不动B站收藏夹。
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveView } from '../api';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { usePlayer, type Track } from '../store';
import { favFolders, favResources, type FavFolder } from '../session';
import ConfirmModal from './ConfirmModal';
import { IconLock, IconX } from './icons';

type Phase = 'list' | 'importing' | 'done';

interface ImportResult {
  added: number;
  total: number;
  failed: { title: string; reason: string }[];
  skippedOther: number;
  skippedInvalid: number;
  plId: string;
  plName: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function FavImportModal({ onClose }: { onClose: () => void }) {
  const playlists = usePlayer((s) => s.playlists);
  const [folders, setFolders] = useState<FavFolder[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [delPlOpen, setDelPlOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('list');
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [result, setResult] = useState<ImportResult | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 在途导入任务：关闭即中止（cancelled），tracks 只在完整跑完后才落库，中止无副作用
  const taskRef = useRef<{ cancelled: boolean } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // 仅引用 ref，恒定标识：Esc/取消/X/遮罩统一走它中止任务后再关闭
  const close = useCallback(() => {
    if (taskRef.current) taskRef.current.cancelled = true;
    onCloseRef.current();
  }, []);

  useEffect(() => registerEsc(close), [close]);
  // 卸载兜底：父层提前卸载本弹窗时同样中止在途任务
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
      .then((f) => {
        if (!cancelled) {
          setFolders(f);
          setSelected(f.find((x) => x.mediaCount > 0)?.id ?? f[0]?.id ?? null);
        }
      })
      .catch((e) => !cancelled && setLoadErr(errText(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  async function startImport() {
    const folder = folders?.find((f) => f.id === selected);
    if (!folder || taskRef.current) return; // 任务独占，防重复提交
    const task = { cancelled: false };
    taskRef.current = task;
    try {
      setPhase('importing');
      setProgress({ done: 0, total: 0, current: '正在拉取收藏夹内容…' });
      const res = await favResources(folder.id);
      if (task.cancelled) return;
      if (res.items.length === 0) {
        setActionErr('这个收藏夹里没有可导入的视频（可能全是失效或音频条目）');
        setPhase('list');
        return;
      }
      const tracks: Omit<Track, 'uid'>[] = [];
      const failed: { title: string; reason: string }[] = [];
      for (let i = 0; i < res.items.length; i++) {
        if (task.cancelled) return;
        const it = res.items[i];
        setProgress({ done: i, total: res.items.length, current: it.title });
        try {
          const v = await resolveView(it.bvid);
          const multi = v.pages.length > 1;
          for (const p of v.pages) {
            tracks.push({
              bvid: v.bvid,
              cid: p.cid,
              // 与 ParseModal 同规：多 P 用 P 名（大标题作来源），单 P 用视频标题——
              // P 名可能是上传者没改的文件名（如 "9月22日(13)"）
              title: multi ? p.part || v.title : v.title,
              up: v.owner,
              cover: v.cover,
              duration: p.duration,
              pageLabel: multi ? `P${p.page}` : undefined,
              source: multi ? v.title : undefined,
            });
          }
        } catch (e) {
          failed.push({ title: it.title, reason: errText(e) });
        }
        await new Promise((r) => setTimeout(r, 250)); // 受控速率，不做批量抓取
        if (task.cancelled) return;
      }
      // 落库：绑过此收藏夹的歌单直接更新，否则新建同名歌单并绑定
      const st = usePlayer.getState();
      const exist = st.playlists.find((p) => p.biliMlid === folder.id);
      const plId = exist?.id ?? st.createPlaylist(folder.title);
      if (!exist) {
        st.bindPlaylistBili(plId, folder.id, 'import');
      } else if (!exist.biliSrc) {
        // 旧快照的歌单没有来源字段：导入时补记为 import（绑定来源写后不变，
        // 若不在此处补记，先发生的推送会把导入歌单误标成 push，见复审第三轮 P2）
        st.bindPlaylistBili(exist.id, folder.id, 'import');
      }
      const added = st.addToPlaylist(plId, tracks);
      const plName = usePlayer.getState().playlists.find((p) => p.id === plId)?.name ?? folder.title;
      st.notify(
        added > 0 ? `已导入 ${added} 首到「${plName}」` : `「${plName}」已是最新`,
        { label: '查看歌单', run: () => usePlayer.getState().setView({ kind: 'playlist', id: plId }) },
      );
      setResult({
        added,
        total: tracks.length,
        failed,
        skippedOther: res.skippedOther,
        skippedInvalid: res.skippedInvalid,
        plId,
        plName,
      });
      setPhase('done');
    } catch (e) {
      if (task.cancelled) return;
      setActionErr(errText(e));
      setPhase('list');
    } finally {
      if (taskRef.current === task) taskRef.current = null;
    }
  }

  // 删除选中收藏夹对应的本地同步歌单（确认弹窗）。只删本地，B站收藏夹不动。
  function removeBoundPl() {
    const boundPl = playlists.find((p) => p.biliMlid === selected);
    if (!boundPl) return;
    usePlayer.getState().deletePlaylist(boundPl.id);
    setDelPlOpen(false);
    usePlayer.getState().notify(`已删除本地歌单「${boundPl.name}」，B站收藏夹不受影响`);
  }

  const sel = folders?.find((f) => f.id === selected) ?? null;
  const boundPl = playlists.find((p) => p.biliMlid === selected) ?? null;

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal" tabIndex={-1} ref={modalRef} role="dialog" aria-modal="true" aria-label="从B站导入" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={close} aria-label="关闭">
          <IconX />
        </button>
        <div className="modal-head-info qr-head">
          <h2>从B站导入</h2>
          {phase === 'list' && <p>选择收藏夹，导入为本地歌单；B站收藏夹不受影响</p>}
        </div>

        {phase === 'list' && (
          <>
            {folders === null && !loadErr && (
              <div className="modal-list-empty">正在获取收藏夹…</div>
            )}
            {loadErr && <div className="fav-result bad">{loadErr}</div>}
            {folders !== null && folders.length === 0 && (
              <div className="modal-list-empty">B站账号里还没有收藏夹</div>
            )}
            {folders !== null && folders.length > 0 && (
              <div className="modal-list">
                {folders.map((f) => (
                  <label key={f.id} className="pick-row">
                    <input
                      type="radio"
                      name="fav-folder"
                      checked={selected === f.id}
                      onChange={() => {
                        setSelected(f.id);
                        setDelPlOpen(false);
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
              </div>
            )}
            {boundPl && (
              <div className="sync-bound">
                <span>
                  {boundPl.biliSrc === 'push'
                    ? `此收藏夹已关联歌单「${boundPl.name}」（推送时建立，${boundPl.keys.length} 首），导入将合并更新它`
                    : `已导入为歌单「${boundPl.name}」（${boundPl.keys.length} 首），再次导入增量更新`}
                </span>
                <button title="只删除本地歌单，不影响B站收藏夹" onClick={() => setDelPlOpen(true)}>
                  删除本地歌单
                </button>
              </div>
            )}
            {actionErr && <div className="fav-result bad">{actionErr}</div>}
            <div className="modal-foot">
              <button className="btn ghost" onClick={close}>
                取消
              </button>
              <button className="btn accent" disabled={!sel || sel.mediaCount === 0} onClick={startImport}>
                导入「{sel?.title ?? '—'}」
              </button>
            </div>
          </>
        )}

        {phase === 'importing' && (
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
              <span className="fav-stop-note">停止即中止本次导入，不保存已解析的内容</span>
              <button className="btn ghost sm" onClick={close}>
                停止
              </button>
            </div>
          </>
        )}

        {phase === 'done' && result && (
          <>
            <div className="fav-result">
              <p className="ok">
                已导入 {result.added} 首 → 歌单「{result.plName}」
              </p>
              {result.total > result.added && <p>{result.total - result.added} 首与歌单现有曲目重复，已跳过</p>}
              {result.skippedInvalid > 0 && <p className="bad">{result.skippedInvalid} 条已失效，无法导入</p>}
              {result.skippedOther > 0 && <p className="bad">{result.skippedOther} 条音频等内容暂不支持，已跳过</p>}
              {result.failed.length > 0 && (
                <p className="bad">
                  {result.failed.length} 条解析失败（{result.failed[0].title}
                  {result.failed.length > 1 ? ' 等' : ''}）
                </p>
              )}
            </div>
            <div className="modal-foot">
              <button
                className="btn accent"
                onClick={() => {
                  usePlayer.getState().setView({ kind: 'playlist', id: result.plId });
                  close();
                }}
              >
                查看歌单
              </button>
              <button className="btn ghost" onClick={close}>
                完成
              </button>
            </div>
          </>
        )}
      </div>
      {delPlOpen && boundPl && (
        <ConfirmModal
          title="删除本地歌单"
          body={`本地歌单「${boundPl.name}」（${boundPl.keys.length} 首）将被删除；仅属于它的音乐会一并从曲库移除。B站收藏夹不受影响。`}
          confirmText="删除"
          danger
          onConfirm={removeBoundPl}
          onClose={() => setDelPlOpen(false)}
        />
      )}
    </div>
  );
}
