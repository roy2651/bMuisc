export function fmtDur(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// 封面缩略图：B 站图片服务支持在 hdslb.com/bfs URL 后追加 @Ww_Hh_1c.webp 后缀做服务端
// 缩放 + 转格式（2026-09-22 实测：原图 194KB → 256 方形 ~8KB / 480 方形 ~25KB，精确生效）。
// 内存大头是解码位图（宽×高×4 字节）：行封面从原图 ~3MB 解码降到 ~260KB，滑动长列表时
// GPU 进程不再涨出 GB 级。只在展示层追加，快照/曲库仍存原图 URL。
// 后缀语法见 docs/platform-feasibility.md 附录注记：_1c = 居中裁切到精确 W×H（B 站自家封面用法）；
// 已带 @ 的 URL 必须先剥再追加（对含 @ 的 URL 直接追加是未定义行为）；
// .gif 源加后缀会冻结成第一帧——B 站视频封面几乎全是 jpg/png/webp，可接受。
// 形状必须与展示槽位一致（复审 P2 教训）：前台槽位全是正方形，用方形 _1c——服务端中心裁切
// 与 CSS object-fit: cover 的方形裁切数学等价，任何宽高比都不产生二次裁切；16:9 后缀只留给
// 模糊背景（wide），否则非宽屏封面会被「CDN 裁 16:9 → CSS 再裁方」双重裁切丢失内容。
export type ThumbSize = 'sm' | 'md' | 'lg' | 'wide';
const THUMB_SUFFIX: Record<ThumbSize, string> = {
  sm: '@256w_256h_1c.webp', // 行封面 44px / 播放条 46px（方形槽位），2~3x DPI 下仍过采样
  md: '@480w_480h_1c.webp', // 列表头图 88px / 解析弹窗头图 104px（方形槽位）
  lg: '@540w_540h_1c.webp', // 正在播放大卡片 240px：2x DPI 需 480，留 540 扛 225% 缩放
  wide: '@960w_540h_1c.webp', // 正在播放模糊背景（全窗 16:9，重度模糊下分辨率无关紧要）
};
/** 只升级已知图床，覆盖头像、原图回退、GIF 与协议相对地址。 */
export function imageUrl(source: string | null | undefined): string {
  if (!source) return '';
  try {
    const url = new URL(source.startsWith('//') ? `https:${source}` : source);
    if ((url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com')) &&
        (url.protocol === 'http:' || url.protocol === 'https:')) {
      url.protocol = 'https:';
      return url.href;
    }
  } catch { /* 非 URL 图源维持原值，由组件失败回退。 */ }
  return source;
}

export function thumbUrl(cover: string | null | undefined, size: ThumbSize): string {
  const original = imageUrl(cover);
  if (!original) return '';
  try {
    const url = new URL(original);
    if (!url.hostname.endsWith('.hdslb.com') && url.hostname !== 'hdslb.com') return original;
    if (!url.pathname.startsWith('/bfs/')) return original;
    if (size === 'lg' && /\.gif$/i.test(url.pathname)) return original;
    // 只处理路径后缀，保留 query/hash，避免把缩略参数加在查询值中。
    url.pathname = url.pathname.split('@')[0] + THUMB_SUFFIX[size];
    return url.href;
  } catch { return original; }
}
