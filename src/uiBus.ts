// 轻量 UI 总线：跨组件开关全局弹窗（设置 / 收藏导入 / 推送），
// 避免侧栏、列表、顶栏之间层层传回调。
import { create } from 'zustand';

interface UiBus {
  settingsOpen: boolean;
  qrOpen: boolean; // 扫码登录弹窗：顶栏「登录」和设置里的扫码按钮共用
  importOpen: boolean;
  pushFor: string | null; // 打开推送弹窗的歌单 id
  openSettings(): void;
  closeSettings(): void;
  openQr(): void;
  closeQr(): void;
  openImport(): void;
  closeImport(): void;
  openPush(playlistId: string): void;
  closePush(): void;
}

export const useUiBus = create<UiBus>((set) => ({
  settingsOpen: false,
  qrOpen: false,
  importOpen: false,
  pushFor: null,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openQr: () => set({ qrOpen: true }),
  closeQr: () => set({ qrOpen: false }),
  openImport: () => set({ importOpen: true }),
  closeImport: () => set({ importOpen: false }),
  openPush: (playlistId) => set({ pushFor: playlistId }),
  closePush: () => set({ pushFor: null }),
}));
