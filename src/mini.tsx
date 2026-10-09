// 迷你播放器浮窗入口（mini.html → 本文件）：与主窗完全独立的第二个 bundle。
// 硬约束（docs/mini-player.md §6）：副窗导入链绝不出现 store/engine/App——
// 零引擎、零快照写路径（不 restore、不 saveSnapshot、不挂 flushSnapshot）；
// 与主窗的一切数据交换走 miniBus 事件协议，与主窗共享的只有纯模块
// （miniBus/icons/ThumbImg/util，均无 store 传递依赖）。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import MiniPlayer from './MiniPlayer';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MiniPlayer />
  </StrictMode>,
);
