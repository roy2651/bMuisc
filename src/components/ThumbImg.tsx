// HTTPS 缩略图 → HTTPS 原图 → 占位图；失败按图源/尺寸隔离。
import { useState, type ReactNode } from 'react';
import { imageUrl, thumbUrl, type ThumbSize } from '../util';
import { IconMusic } from './icons';

interface Props {
  cover: string | null | undefined;
  size?: ThumbSize;
  className: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
  dragRegion?: boolean;
  fallback?: ReactNode;
}

export default function ThumbImg({ cover, size = 'md', className, alt = '', loading, dragRegion, fallback }: Props) {
  const original = imageUrl(cover);
  const thumbnail = thumbUrl(cover, size);
  const source = `${original}\n${size}`;
  const [failure, setFailure] = useState<{ source: string; urls: string[] } | null>(null);
  const failed = failure?.source === source ? failure.urls : [];
  const src = !failed.includes(thumbnail) ? thumbnail : original;
  if (!src || failed.includes(src)) {
    return (
      <span className={`${className} empty thumb-placeholder`} role="img" aria-label={alt || '图片不可用'}
        data-tauri-drag-region={dragRegion ? '' : undefined}>
        {fallback ?? <IconMusic size={16} />}
      </span>
    );
  }
  return (
    <img key={src} className={className} src={src} alt={alt} loading={loading}
      referrerPolicy="no-referrer" data-tauri-drag-region={dragRegion ? '' : undefined}
      onError={() => setFailure((previous) => ({
        source,
        urls: [...(previous?.source === source ? previous.urls : []), src],
      }))}
    />
  );
}
