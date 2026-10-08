// B 站账号会话：登录状态展示 + 收藏夹读写命令封装。
// 凭证（SESSDATA 等）只存 OS 安全存储并在 Rust 侧使用；这里拿到的
// 仅是 mid/昵称/头像等展示信息，不接触任何凭证。
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export interface SessionUser {
  mid: number;
  uname: string;
  face: string;
}

export interface SessionState {
  loggedIn: boolean;
  user: SessionUser | null;
}

interface SessionStore {
  state: SessionState | null; // null = 启动后尚未查询
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

export const useSession = create<SessionStore>((set) => ({
  state: null,
  refresh: async () => {
    try {
      set({ state: await invoke<SessionState>('login_state') });
    } catch {
      set({ state: { loggedIn: false, user: null } });
    }
  },
  logout: async () => {
    await invoke('login_logout');
    set({ state: { loggedIn: false, user: null } });
  },
}));

// ---- 登录流程 ----

export interface QrStart {
  url: string;
  qrcodeKey: string;
  epoch: number; // 登录代际号：轮询须回传，原生侧落库前校验（防作废登录迟到写回）
}

export type QrPollStatus = 'waiting' | 'scanned' | 'expired' | 'success' | 'cancelled';

export interface QrPoll {
  status: QrPollStatus;
  user?: SessionUser;
}

// attemptId 由前端生成、每次打开弹窗一个：定向取消旧弹窗的登录尝试，
// 迟到的取消不会误杀新弹窗已开始的登录（无差别换代会）
export const loginQrGenerate = (attemptId: string) =>
  invoke<QrStart>('login_qr_generate', { attemptId });
export const loginQrPoll = (qrcodeKey: string, epoch: number) =>
  invoke<QrPoll>('login_qr_poll', { qrcodeKey, epoch });
export const loginQrCancel = (attemptId: string) => invoke('login_qr_cancel', { attemptId });

// ---- 收藏夹 ----

export interface FavFolder {
  id: string;
  title: string;
  mediaCount: number;
  private: boolean;
}

export interface FavItem {
  bvid: string;
  title: string;
  up: string;
  page: number;
  duration: number;
}

export interface FavListResult {
  items: FavItem[];
  skippedOther: number;
  skippedInvalid: number;
  truncated: boolean; // 50 页封顶仍未读完：部分结果，UI 需提示
}

export const favFolders = () => invoke<FavFolder[]>('fav_folders');
export const favResources = (mediaId: string) => invoke<FavListResult>('fav_resources', { mediaId });
export const favPush = (mediaId: string, bvid: string) => invoke<void>('fav_push', { mediaId, bvid });
export const favCreateFolder = (title: string, isPrivate: boolean) =>
  invoke<string>('fav_create_folder', { title, private: isPrivate });
