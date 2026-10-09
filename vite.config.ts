import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 双入口：主窗 index.html + 迷你播放器浮窗 mini.html。副窗走独立 bundle，
// 从构建层面保证其导入链碰不到 store/engine/快照（docs/mini-player.md §6 硬约束）。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        mini: fileURLToPath(new URL('./mini.html', import.meta.url)),
      },
    },
  },
});
