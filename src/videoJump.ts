// 「在B站看视频」：想看画面时跳回 B 站网页，本地音乐暂停（需求与验收见 docs/video-jump.md）。
// 顺序必须是先 openUrl 成功、再 pause——打开失败时音乐不受影响，只提示。
// 独立模块而非 store action：store 不新增 plugin-opener 依赖，verify 脚手架的 mock 不受影响。
import { openUrl } from '@tauri-apps/plugin-opener';
import { usePlayer } from './store';

export interface JumpTarget {
  bvid: string;
  cid: number;
  page?: number; // 分 P 序号；缺省（旧数据 / 合集单集 / 单 P）不带定位参数
}

const JUMP_DEBOUNCE_MS = 800;
let lastJumpAt = 0;

/** 构造 B 站原视频地址：仅多 P（序号 >1）带 p，仅带进度且 ≥5 秒带 t */
export function videoUrl(item: JumpTarget, positionSec?: number): string {
  const params: string[] = [];
  if (item.page && item.page > 1) params.push(`p=${item.page}`);
  if (positionSec !== undefined && positionSec >= 5) params.push(`t=${Math.floor(positionSec)}`);
  return `https://www.bilibili.com/video/${item.bvid}/${params.length ? `?${params.join('&')}` : ''}`;
}

/** 跳转原视频：防抖 → 打开浏览器 → 成功后暂停本地播放（保留进度）；失败提示且不暂停 */
export async function jumpToVideo(item: JumpTarget): Promise<void> {
  const now = Date.now();
  if (now - lastJumpAt < JUMP_DEBOUNCE_MS) return; // 连点合并，防多开标签页
  lastJumpAt = now;
  const s = usePlayer.getState();
  const cur = s.tracks.find((t) => t.uid === s.currentId);
  // 只有跳当前曲才带播放进度；行菜单跳其他曲没有进度概念
  const position = cur && cur.bvid === item.bvid && cur.cid === item.cid ? s.position : undefined;
  const intentSeq = s.intentSeq; // 点击时的播放意图版本
  try {
    await openUrl(videoUrl(item, position));
  } catch {
    s.notify('打开浏览器失败，请重试');
    return;
  }
  // openUrl 等待期间用户可能已切歌 / 重播 / 手动播放暂停（intentSeq 已递增）：
  // 过期回调不再暂停，以最新播放意图为准；自然结束的自动接续不递增版本，
  // 「看视频时音乐停」的暂停仍然生效
  const after = usePlayer.getState();
  if (after.currentId && after.intentSeq === intentSeq) after.pause();
}
