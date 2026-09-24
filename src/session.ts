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
}

export type QrPollStatus = 'waiting' | 'scanned' | 'expired' | 'success';

export interface QrPoll {
  status: QrPollStatus;
  user?: SessionUser;
}

export const loginQrGenerate = () => invoke<QrStart>('login_qr_generate');
export const loginQrPoll = (qrcodeKey: string) => invoke<QrPoll>('login_qr_poll', { qrcodeKey });

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
}

export const favFolders = () => invoke<FavFolder[]>('fav_folders');
export const favResources = (mediaId: string) => invoke<FavListResult>('fav_resources', { mediaId });
export const favPush = (mediaId: string, bvid: string) => invoke<void>('fav_push', { mediaId, bvid });
export const favCreateFolder = (title: string, isPrivate: boolean) =>
  invoke<string>('fav_create_folder', { title, private: isPrivate });
