// 内联 SVG 图标集：线性风格，currentColor 着色
interface IconProps {
  size?: number;
}

const base = (size?: number) => ({
  width: size ?? 18,
  height: size ?? 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconPlay = ({ size }: IconProps) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.52.86l10.5-6.5a1 1 0 0 0 0-1.72L9.52 4.64A1 1 0 0 0 8 5.5z" />
  </svg>
);

export const IconPause = ({ size }: IconProps) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <rect x="6" y="4.5" width="4.2" height="15" rx="1.4" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4" />
  </svg>
);

export const IconPrev = ({ size }: IconProps) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M7 5.5a1.2 1.2 0 0 1 2.4 0v13a1.2 1.2 0 0 1-2.4 0z" />
    <path d="M18.3 5.2a1 1 0 0 1 1.7.8v12a1 1 0 0 1-1.7.8l-8.3-6a1 1 0 0 1 0-1.6z" />
  </svg>
);

export const IconNext = ({ size }: IconProps) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M17 5.5a1.2 1.2 0 0 0-2.4 0v13a1.2 1.2 0 0 0 2.4 0z" />
    <path d="M5.7 5.2a1 1 0 0 0-1.7.8v12a1 1 0 0 0 1.7.8l8.3-6a1 1 0 0 0 0-1.6z" />
  </svg>
);

export const IconVolume = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M11 5 6.5 8.5H3.5a.8.8 0 0 0-.8.8v5.4c0 .44.36.8.8.8h3L11 19z" fill="currentColor" stroke="none" />
    <path d="M14.5 9a4 4 0 0 1 0 6" />
    <path d="M17 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);

export const IconVolumeMuted = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M11 5 6.5 8.5H3.5a.8.8 0 0 0-.8.8v5.4c0 .44.36.8.8.8h3L11 19z" fill="currentColor" stroke="none" />
    <path d="m15 9.5 5.5 5.5M20.5 9.5 15 15" />
  </svg>
);

export const IconOrder = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 7h11M4 12h8M4 17h11" />
    <path d="m17.5 14.5 2.5 2.5-2.5 2.5" />
  </svg>
);

export const IconLoop = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 12a5 5 0 0 1 5-5h9" />
    <path d="m15.5 4.5 2.8 2.5-2.8 2.5" />
    <path d="M20 12a5 5 0 0 1-5 5H6" />
    <path d="m8.5 19.5-2.8-2.5 2.8-2.5" />
  </svg>
);

export const IconOne = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 12a5 5 0 0 1 5-5h9" />
    <path d="m15.5 4.5 2.8 2.5-2.8 2.5" />
    <path d="M20 12a5 5 0 0 1-5 5H6" />
    <path d="m8.5 19.5-2.8-2.5 2.8-2.5" />
    <path d="M11.4 10.2l1.6-.9v5.4" strokeWidth={2.2} />
  </svg>
);

export const IconRandom = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 6h3.5c1.8 0 3 1 4 2.5l3.5 7c.9 1.5 2.1 2.5 3.9 2.5H20" />
    <path d="m17.5 15.5 2.8 2.5-2.8 2.5" />
    <path d="M4 18h3.5c1.8 0 3-1 4-2.5l.9-1.8" />
    <path d="M13.6 9.3l1.4-2.8c.9-1.5 2.1-2.5 3.9-2.5H20" />
    <path d="m17.5 1.5 2.8 2.5-2.8 2.5" />
  </svg>
);

export const IconPlus = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconTrash = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9L17.5 7" />
    <path d="M10 11v5M14 11v5" />
  </svg>
);

export const IconX = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const IconExternal = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M19 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.5" />
  </svg>
);

export const IconMusic = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="7" cy="17.5" r="3" />
    <circle cx="18" cy="15.5" r="3" />
    <path d="M10 17.5V6.5a1 1 0 0 1 .8-1l9-1.8a1 1 0 0 1 1.2 1v10.8" />
  </svg>
);

export const IconQueue = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 6h12M4 11h12M4 16h7" />
    <path d="M17 12v6.5" />
    <circle cx="19" cy="19" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconArrowUp = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="m6 14 6-6 6 6" />
  </svg>
);

export const IconArrowDown = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="m6 10 6 6 6-6" />
  </svg>
);

export const IconLocate = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
  </svg>
);

export const IconSearch = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

export const IconMore = ({ size }: IconProps) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <circle cx="5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="19" cy="12" r="1.7" />
  </svg>
);

export const IconHeart = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 20.2s-7.3-4.6-9-9C1.8 8.3 3.8 5.2 7 5.2c1.9 0 3.7 1.1 5 2.9 1.3-1.8 3.1-2.9 5-2.9 3.2 0 5.2 3.1 4 6-1.7 4.4-9 9-9 9z" />
  </svg>
);

export const IconHeartFilled = ({ size }: IconProps) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M12 20.2s-7.3-4.6-9-9C1.8 8.3 3.8 5.2 7 5.2c1.9 0 3.7 1.1 5 2.9 1.3-1.8 3.1-2.9 5-2.9 3.2 0 5.2 3.1 4 6-1.7 4.4-9 9-9 9z" />
  </svg>
);

// 最近播放：逆时针回转的时钟（history）
export const IconHistory = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M1 4v6h6" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    <path d="M12 6v6l4 2" />
  </svg>
);

// 设置：齿轮
export const IconSettings = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </svg>
);

// 品牌 logo：bm 手写单色标（描边白，跟随 currentColor），来自 design bm-mark-white.svg
export const LogoMark = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth={44} strokeLinecap="round" strokeLinejoin="round">
      <path d="M128 170V282C128 316 151 338 184 338C219 338 242 313 242 281C242 248 219 226 186 226C153 226 128 250 128 282" />
      <path d="M284 326V255C284 235 297 223 315 223C334 223 347 235 347 255V326M347 255C347 235 360 223 378 223C397 223 410 235 410 255V326" />
    </g>
  </svg>
);

// 品牌完整瓷片：渐变底 + bm 标，用于空状态展示
export const LogoTile = ({ size = 96 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="bm-tile" x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="#F36AA1" />
        <stop offset="1" stopColor="#AD65DC" />
      </linearGradient>
    </defs>
    <rect x="16" y="16" width="480" height="480" rx={112} fill="url(#bm-tile)" />
    <g stroke="#fff" strokeWidth={44} strokeLinecap="round" strokeLinejoin="round">
      <path d="M128 170V282C128 316 151 338 184 338C219 338 242 313 242 281C242 248 219 226 186 226C153 226 128 250 128 282" />
      <path d="M284 326V255C284 235 297 223 315 223C334 223 347 235 347 255V326M347 255C347 235 360 223 378 223C397 223 410 235 410 255V326" />
    </g>
  </svg>
);
