// 物理像素下校正完整窗口，不只保留一小块可拖动区域。
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface WorkArea { position: Point; size: Size }

export function clampMiniPosition(position: Point, size: Size, area: WorkArea): Point {
  const maxX = area.position.x + Math.max(0, area.size.width - size.width);
  const maxY = area.position.y + Math.max(0, area.size.height - size.height);
  return {
    x: Math.floor(Math.min(maxX, Math.max(area.position.x, position.x))),
    y: Math.floor(Math.min(maxY, Math.max(area.position.y, position.y))),
  };
}

export function parseMiniPosition(raw: string | null): Point | null {
  try {
    const p: unknown = JSON.parse(raw ?? 'null');
    if (p && typeof p === 'object' && 'x' in p && 'y' in p &&
        typeof p.x === 'number' && Number.isFinite(p.x) &&
        typeof p.y === 'number' && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  } catch { /* 损坏的偏好回退到默认位置 */ }
  return null;
}
