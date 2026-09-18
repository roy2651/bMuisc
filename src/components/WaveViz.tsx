// 正在播放波浪：优先渲染真实 FFT 频谱（音频经 WebAudio 分析），
// 不可用时退化为多组正弦叠加的合成波浪；暂停时条形平滑落底后停帧。

import { useEffect, useRef } from 'react';
import { getVizData } from '../engine';

interface Props {
  playing: boolean;
}

const BARS = 56;

export default function WaveViz({ playing }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const levels = new Array<number>(BARS).fill(0);
    let raf = 0;
    let idleFrames = 0;

    const render = () => {
      raf = requestAnimationFrame(render);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const data = playing ? getVizData() : null;
      const t = performance.now() / 1000;
      for (let i = 0; i < BARS; i++) {
        let target = 0; // 暂停：平滑落底
        if (data) {
          // 真实频谱：低频段映射全部条形（ FFT 前 96 桶能量最集中）
          const fi = Math.floor((i / BARS) * Math.min(data.length, 96));
          target = 0.08 + (data[fi] / 255) * 0.92;
        } else if (playing) {
          // 合成波浪：三组不同频率相位的正弦叠加，中段高两端低的包络
          const wave =
            0.32 +
            0.24 * Math.sin(t * 2.1 + i * 0.55) +
            0.16 * Math.sin(t * 3.7 + i * 0.31 + 1.7) +
            0.1 * Math.sin(t * 5.3 + i * 0.83 + 4.2);
          target = Math.max(0.06, Math.min(0.85, wave)) * (0.55 + 0.45 * Math.sin((i / BARS) * Math.PI));
        }
        // 上升快、回落慢，接近真实律动
        levels[i] += (target - levels[i]) * (target > levels[i] ? 0.35 : 0.08);
      }

      const gap = 3;
      const bw = (w - gap * (BARS - 1)) / BARS;
      for (let i = 0; i < BARS; i++) {
        const bh = Math.max(2, levels[i] * (h - 6));
        const x = i * (bw + gap);
        const y = h - bh;
        const grad = ctx.createLinearGradient(0, h, 0, y);
        grad.addColorStop(0, 'rgba(251, 114, 153, 0.05)');
        grad.addColorStop(0.55, 'rgba(251, 114, 153, 0.5)');
        grad.addColorStop(1, 'rgba(177, 108, 234, 0.85)');
        ctx.fillStyle = grad;
        const r = Math.min(bw / 2, 2.5);
        ctx.beginPath();
        ctx.moveTo(x, h);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.lineTo(x + bw - r, y);
        ctx.arcTo(x + bw, y, x + bw, y + r, r);
        ctx.lineTo(x + bw, h);
        ctx.closePath();
        ctx.fill();
      }

      // 暂停且条形落底后停帧省电；playing 变化时 effect 重新点火
      idleFrames = !playing && levels.every((v) => v < 0.004) ? idleFrames + 1 : 0;
      if (idleFrames > 10) cancelAnimationFrame(raf);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return <canvas ref={ref} className="np-viz" aria-hidden="true" />;
}
