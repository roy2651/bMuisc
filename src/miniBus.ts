// 迷你播放器跨窗协议：主窗（miniHost.ts）与浮窗（MiniPlayer.tsx）共享的
// 事件名、载荷类型与纯函数。零依赖（不 import store/engine），两个 bundle 都可用。
// 设计依据 docs/mini-player.md §6：广播只含展示/控制必需信息——
// 不发曲库、登录凭证、签名媒体地址；封面是 hdslb 公开 CDN 原始 URL（非签名媒体地址）。
// 事件走 Tauri emit/listen（受 ACL 管理）；BroadcastChannel/localStorage 事件非受支持方案，不用。

export const EV_STATE = 'mini:state'; // 主窗→副窗：状态推送（全量快照 + 增量变更，带 seq）
export const EV_CMD = 'mini:cmd'; // 副窗→主窗：受限操作指令（一击一发，永不重发）
export const EV_CMD_RESULT = 'mini:cmd-result'; // 主窗→副窗：失败回执（成功不回执，状态推送即结果）
export const EV_HELLO = 'mini:hello'; // 副窗→主窗：请求全量状态（boot / 激活 / 主窗重载自愈）
export const EV_CANCELLED = 'mini:cancelled'; // Rust→主窗：指定进入请求已作废
export const EV_READY = 'mini:ready'; // 副窗→主窗：回传 requestId；位置已应用且已收到本次全量状态，尚未 show
export const EV_ACTIVATE = 'mini:activate'; // Rust→副窗：mini_show 的激活信号（携带 requestId；未就绪时有界补发）
export const EV_HOST_READY = 'mini:host-ready'; // 主窗→副窗：miniHost 就绪（dev HMR 重载主窗后副窗重新 hello）
export const EV_ENTER = 'mini:enter'; // Rust→主窗：托盘「迷你播放器」请求进入迷你模式（真正建窗/藏主窗的握手在主窗 enterMini 里，Rust 回调不建窗——wry#583）

export interface MiniState {
  requestId?: string; // 仅回应激活 hello 时携带；普通状态广播不确认进入
  seq: number; // 主窗单调递增；副窗丢弃 seq <= lastSeq 的迟到/乱序推送
  key: string | null; // 当前曲目 TrackKey（bvid:cid），null = 无在播曲目
  title: string | null;
  pageLabel: string | null;
  up: string | null;
  cover: string | null; // hdslb 原始 URL，副窗自行 thumbUrl('sm')
  playing: boolean;
  loading: boolean; // 解析/缓冲中：播放键转 spinner
  error: string | null; // 非空 = 错误态（播放键=重试入口）
  liked: boolean; // 当前曲目是否已在「我的喜欢」
  canToggle: boolean; // 队列非空（镜像 PlayerBar 播放键禁用条件 !track && tracks.length===0）
  hasTrack: boolean; // 有在播曲目（镜像 prev/next/红心禁用条件 !track）
}

export type MiniCmdOp = 'toggle' | 'prev' | 'next' | 'fav';

export interface MiniCmd {
  cmdId: string; // 一击一发、永不重发：id 用于失败回执与主窗有界去重
  op: MiniCmdOp;
  target?: string; // fav 必带：点击时显示曲目的 key；执行侧绝不盲取当前 currentId
}

export interface MiniCmdResult {
  cmdId: string;
  ok: boolean;
  reason?: string;
}

/** seq 守卫：hello 全量与增量变更交错时的迟到/乱序推送丢弃判定 */
export function isStaleState(payload: MiniState, lastSeq: number): boolean {
  return payload.seq <= lastSeq;
}
