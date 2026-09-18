/**
 * 遮盖框以 PDF 页面坐标（用户空间单位，1 单位 = 1/72 英寸，原点为页面左下角，
 * 基于未旋转的页面）保存，因此缩放、旋转、切换页面后位置不会漂移。
 */
export interface RedactionBox {
  id: string;
  /** 已归一化：x1 < x2, y1 < y2 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 页码（从 1 开始） -> 该页的遮盖框列表 */
export type RedactionMap = Record<number, RedactionBox[]>;

export type Tool = 'draw' | 'select';

/**
 * 文本查找的一条命中：命中词在第 page 页上实际覆盖的一个或多个候选框
 * （跨多个相邻 pdf.js text item 时为多个框，不会把间隔文字一并框入）。
 * 坐标与 RedactionBox 同为未旋转的 PDF 页面坐标。
 */
export interface FindHit {
  id: string;
  query: string;
  page: number;
  /** 命中位置在归一化页面文本中的区间，用于稳定去重 */
  start: number;
  end: number;
  rects: HitRect[];
  /** 命中上下文摘要（命中词前后各取少量字符） */
  snippet: string;
}

export interface HitRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `box-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
