// 带原图回退的缩略封面：展示层走 @后缀 缩略图（见 util.thumbUrl 的实测依据），
// 个别图源对后缀变体 404 / 未来风控变化时，一次性回退到快照里的原图 URL。
// 回退状态按封面 URL 记（failedFor），换曲目自然失效，无需手动重置。
import { useState } from 'react';
import { thumbUrl, type ThumbSize } from '../util';

interface Props {
  cover: string | null | undefined;
  size?: ThumbSize;
  className: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
}

export default function ThumbImg({ cover, size = 'md', className, alt = '', loading }: Props) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const original = cover ?? '';
  const failed = failedFor === original;
  const src = failed ? original : thumbUrl(cover, size);
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading={loading}
      onError={() => {
        if (src !== original) setFailedFor(original);
      }}
    />
  );
}
