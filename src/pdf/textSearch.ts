import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { FindHit, HitRect } from '../types';
import { uid } from '../types';

/** pdf.js TextItem 中我们用到的字段（根类型入口未导出该类型，这里按结构声明） */
export interface TextItem {
  str: string;
  /** 当前文本矩阵：[a,b,c,d,e,f]，(e,f) 为基线起点，单位为点 */
  transform: number[];
  /** 整串沿基线方向的推进宽度（点） */
  width: number;
  height: number;
  hasEOL: boolean;
}

export interface TextContent {
  items: Array<TextItem | { type: string }>;
}

/**
 * 纯本地文本查找：
 * - 搜索仅在单页内进行（不跨页）；
 * - 查询与页面文本中的连续空白（含换行、为排版拉宽的空白 item）统一折叠为一个空格后再匹配；
 * - 相邻 text item 的跨边界空格仅在“确有分隔”时补入：前项结尾有显式空白、前项标记 hasEOL，
 *   或两 item 方向夹角 / 基线垂直偏移 / 沿基线间距超过阈值时插入一个空格；
 *   否则视为同一连续词直接拼接（修复被 pdf.js 拆成多个 item 的中文连续词漏检）；
 * - 命中可跨相邻 pdf.js text item，但每个命中只按实际命中的字形范围生成候选框，
 *   间隔的未命中文字不会被框入。
 */

/** 跨 item 连续判定阈值（见 itemsContinuous） */
const MAX_ANGLE_DEG = 5;
/** 基线垂直偏移 / 沿基线投影间距均不超过较小文字高度的 0.2 倍 */
const GAP_RATIO = 0.2;

interface Unit {
  /** 归一化后的码元（普通字符或单个空格） */
  ch: string;
  /** 来源 item 序号；-1 表示 item 边界处补入的分隔空格 */
  item: number;
  /** 在来源 item 中的码点序号；空白处为 -1 */
  indexInItem: number;
}

export interface PageText {
  page: number;
  units: Unit[];
  /** 与 units 等长的归一化文本 */
  normalized: string;
  items: TextItem[];
  /** items 中含非空白文字的 item 数量 */
  textItemCount: number;
}

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

/** item 的文字高度：优先用 height（未缩放设备单位），缺失时回退为 transform 的纵向基向量长度 */
function itemFontHeight(it: TextItem): number {
  const fromHeight = it.height;
  if (Number.isFinite(fromHeight) && fromHeight > 0) return fromHeight;
  return Math.hypot(it.transform[2], it.transform[3]) || 1;
}

/**
 * 判定两个相邻 text item 是否属于同一连续词（前项 prev 后紧跟当前项 cur），
 * 以下条件必须同时成立才在归一化文本中直接拼接、不补空格：
 * 1. 前项未标记 hasEOL（hasEOL 为 true 表示 pdf.js 认为此处有换行 / 硬分隔）；
 * 2. 两 item 基线方向夹角不超过 5°；
 * 3. 当前项基线起点相对前项基线的垂直偏移不超过较小文字高度的 0.2 倍；
 * 4. 前项基线终点到当前项基线起点沿基线方向的投影间距（gap，负值为重叠）不超过该高度的 0.2 倍。
 */
export function itemsContinuous(prev: TextItem, cur: TextItem): boolean {
  if (prev.hasEOL) return false;

  const t = prev.transform;
  const prevBx = t[0];
  const prevBy = t[1];
  const prevBLen = Math.hypot(prevBx, prevBy);
  if (!(prevBLen > 0)) return false;
  const ux = prevBx / prevBLen;
  const uy = prevBy / prevBLen;

  const ct = cur.transform;
  const curBx = ct[0];
  const curBy = ct[1];
  const curBLen = Math.hypot(curBx, curBy);
  if (!(curBLen > 0)) return false;

  // 方向夹角（点积 -> cos，归一化到 [0,1] 防浮点越界）
  const dot = (prevBx * curBx + prevBy * curBy) / (prevBLen * curBLen);
  const cos = clamp(dot, -1, 1);
  const angleDeg = (Math.acos(cos) * 180) / Math.PI;
  if (angleDeg > MAX_ANGLE_DEG) return false;

  const h = Math.min(itemFontHeight(prev), itemFontHeight(cur));
  if (!(h > 0)) return false;
  // 阈值自身按坐标尺度放大一个机器精度量级，使“恰好 0.2 倍字高”的边界不受浮点误差影响
  const eps = 1e-9 * Math.max(1, Math.abs(t[4]), Math.abs(t[5]), prev.width, h);
  const maxGap = GAP_RATIO * h + eps;

  // 当前项基线起点相对于前项基线起点的位移
  const dx = ct[4] - t[4];
  const dy = ct[5] - t[5];

  // 垂直于基线方向的偏移（不同行 / 上下错开）
  const perp = Math.abs(dy * ux - dx * uy);
  if (perp > maxGap) return false;

  // 沿基线方向：前项终点推进 prev.width 后到当前项起点的投影间距
  const gap = dx * ux + dy * uy - prev.width;
  if (gap > maxGap) return false;

  return true;
}

/** 构建单页归一化文本与 归一化字符 -> (item, item 内码点偏移) 的映射 */
export function buildPageText(page: number, content: TextContent): PageText {
  const items = content.items.filter((it): it is TextItem => 'str' in it);
  const units: Unit[] = [];
  let textItemCount = 0;

  for (let i = 0; i < items.length; i += 1) {
    const str = items[i].str;
    const prevUnit = units[units.length - 1];
    const prevEndedWithText = prevUnit && prevUnit.item >= 0 && prevUnit.indexInItem >= 0;
    // 当前 item 以文字开头，且上一个有效码元是“上个 item 的文字”时，需要决定 item 边界是否补空格：
    // 仅当存在显式分隔（前项结尾有空白 / hasEOL）或几何上不连续（方向、垂直偏移或沿基间距超阈值）
    // 时补一个空格；否则按同一连续词直接拼接（如被 pdf.js 拆开的「保」「密」可被「保密」命中）。
    // 中间夹着空白 item、或前项内部空白折叠出的空格已承担分隔，不会走到这里。
    const firstCp = str.length > 0 ? String.fromCodePoint(str.codePointAt(0)!) : '';
    const startsWithText = firstCp.length > 0 && !isWhitespace(firstCp);
    if (startsWithText && prevEndedWithText) {
      const prevItem = items[prevUnit!.item];
      const prevEndsWithWhitespace = /\s$/u.test(prevItem.str);
      if (prevEndsWithWhitespace || !itemsContinuous(prevItem, items[i])) {
        units.push({ ch: ' ', item: -1, indexInItem: -1 });
      }
    }
    let pendingSpace = false;
    let addedFromItem = false;
    // 按码点迭代（兼容 emoji 等代理对）
    let cpIndex = 0;
    for (let j = 0; j < str.length; ) {
      const cp = str.codePointAt(j)!;
      const ch = String.fromCodePoint(cp);
      const step = ch.length;
      if (isWhitespace(ch)) {
        pendingSpace = true; // 连续空白折叠
        cpIndex += 1;
        j += step;
        continue;
      }
      if (pendingSpace) {
        units.push({ ch: ' ', item: i, indexInItem: -1 });
        pendingSpace = false;
      }
      units.push({ ch, item: i, indexInItem: cpIndex });
      addedFromItem = true;
      cpIndex += 1;
      j += step;
    }
    // 末尾挂起的显式空白（含换行）折叠为一个分隔空格保留：
    // 含文字 item 的结尾空白表示它与后续内容确有分隔；纯空白 item 自身也承担一次分隔。
    // 前一码元已是空格时不重复添加，保证整体仍折叠为一个空格；整页结尾的空白后面再无内容，不保留。
    const isLastItem = i === items.length - 1;
    if (pendingSpace && !isLastItem && units.length > 0 && units[units.length - 1].ch !== ' ') {
      units.push({ ch: ' ', item: i, indexInItem: -1 });
    }
    if (addedFromItem) textItemCount += 1;
  }

  return {
    page,
    units,
    normalized: units.map((u) => u.ch).join(''),
    items,
    textItemCount,
  };
}

/** 按同样的规则归一化查询词；返回 null 表示空白词 */
export function normalizeQuery(q: string): string | null {
  const collapsed = q.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

/** 换行分隔的多个查询词，去空、去重并保持输入顺序 */
export function parseQueries(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/\r?\n|\r/)) {
    const q = normalizeQuery(raw);
    if (q && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
  }
  return out;
}

/* ---------------- 命中几何 ---------------- */

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), max);

/**
 * 计算某 item 内码点子区间 [cpStart, cpEnd) 在“未旋转 PDF 页面坐标”下的轴对齐包围盒。
 * item.transform 为当前文本矩阵（点），(t[4],t[5]) 是基线起点，
 * (t[0],t[1]) 为基线方向基向量，(t[2],t[3]) 为高度方向基向量，
 * item.width 是整个字符串沿基线方向的推进长度（点）。
 * 按字符数线性比例分配宽度（与 pdf.js 文本层 canvasWidth 缩放同一模型），
 * 四角取轴对齐包围盒，因此对旋转文本同样成立。
 */
function itemCharRangeRect(
  item: TextItem,
  cpStart: number,
  cpEnd: number,
  pageWidth: number,
  pageHeight: number,
): HitRect {
  const t = item.transform;
  const len = [...item.str].length || 1;
  const bx = t[0];
  const by = t[1];
  const vx = t[2];
  const vy = t[3];
  const blen = Math.hypot(bx, by) || 1;
  const fontH = Math.hypot(vx, vy) || 1;
  const ux = bx / blen;
  const uy = by / blen;

  const startAdvance = item.width * (cpStart / len);
  const endAdvance = Math.max(item.width * (cpEnd / len), startAdvance);

  // 纵向覆盖整个字形盒：基线上方约一个字号、下方约 0.28 个字号，
  // 再加少量外扩，避免衬线 / 抗锯齿边缘露出
  const up = 1.02 * fontH;
  const down = 0.28 * fontH;
  const pad = 0.02 * fontH;

  const p0x = t[4] + ux * (startAdvance - pad);
  const p0y = t[5] + uy * (startAdvance - pad);
  const p1x = t[4] + ux * (endAdvance + pad);
  const p1y = t[5] + uy * (endAdvance + pad);

  const corners = [
    [p0x + (vx * up) / fontH, p0y + (vy * up) / fontH],
    [p1x + (vx * up) / fontH, p1y + (vy * up) / fontH],
    [p0x - (vx * down) / fontH, p0y - (vy * down) / fontH],
    [p1x - (vx * down) / fontH, p1y - (vy * down) / fontH],
  ];

  return {
    x1: clamp(Math.min(...corners.map((c) => c[0])), 0, pageWidth),
    y1: clamp(Math.min(...corners.map((c) => c[1])), 0, pageHeight),
    x2: clamp(Math.max(...corners.map((c) => c[0])), 0, pageWidth),
    y2: clamp(Math.max(...corners.map((c) => c[1])), 0, pageHeight),
  };
}

/**
 * 把归一化文本上的一个区间 [start,end) 转换成按 item 切分的候选框。
 * item 边界补入的分隔空格（item === -1）及 item 内空白不产生框，
 * 因此同一行中间未命中的间隔文字（含被 pdf.js 拉宽的空白 item）不会被遮住。
 */
function intervalToRects(pt: PageText, start: number, end: number, pageWidth: number, pageHeight: number): HitRect[] {
  const ranges = new Map<number, { lo: number; hi: number }>();
  for (let k = start; k < end; k += 1) {
    const u = pt.units[k];
    if (u.item < 0 || u.indexInItem < 0 || isWhitespace(u.ch)) continue;
    const r = ranges.get(u.item);
    if (r) {
      r.lo = Math.min(r.lo, u.indexInItem);
      r.hi = Math.max(r.hi, u.indexInItem);
    } else {
      ranges.set(u.item, { lo: u.indexInItem, hi: u.indexInItem });
    }
  }

  const rects: HitRect[] = [];
  for (const [itemIdx, r] of ranges) {
    const item = pt.items[itemIdx];
    if (!item || item.width <= 0) continue;
    rects.push(itemCharRangeRect(item, r.lo, r.hi + 1, pageWidth, pageHeight));
  }
  return rects;
}

function makeSnippet(text: string, start: number, end: number): string {
  const chars = [...text]; // 码点数组
  const R = 14;
  const lo = Math.max(0, start - R);
  const hi = Math.min(chars.length, end + R);
  return `${lo > 0 ? '…' : ''}${chars.slice(lo, start).join('')}【${chars.slice(start, end).join('')}】${chars.slice(end, hi).join('')}${hi < chars.length ? '…' : ''}`;
}

export interface PageSearchResult {
  hits: FindHit[];
  noText: boolean;
}

/** 单页（已提取或缓存）查找全部查询词的全部命中（索引均为码点序号） */
export function searchBuiltPageText(
  pt: PageText,
  pageWidth: number,
  pageHeight: number,
  queries: string[],
): PageSearchResult {
  if (pt.textItemCount === 0) return { hits: [], noText: true };

  const hits: FindHit[] = [];
  for (const query of queries) {
    const queryLen = [...query].length;
    let from = 0;
    for (;;) {
      const idx = cpIndexOf(pt.normalized, query, from);
      if (idx < 0) break;
      const rects = intervalToRects(pt, idx, idx + queryLen, pageWidth, pageHeight);
      if (rects.length > 0) {
        hits.push({
          id: uid(),
          query,
          page: pt.page,
          start: idx,
          end: idx + queryLen,
          rects,
          snippet: makeSnippet(pt.normalized, idx, idx + queryLen),
        });
      }
      from = idx + Math.max(1, queryLen);
    }
  }

  // 同位置多词重叠时只保留一条（先按区间长度排序，去重保留最先生成者）
  hits.sort((a, b) => a.start - b.start || a.end - b.end || a.query.length - b.query.length);
  const seen = new Set<string>();
  const out: FindHit[] = [];
  for (const h of hits) {
    const key = `${h.start}:${h.end}:${rectKey(h.rects)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(h);
    }
  }
  return { hits: out, noText: false };
}

/** 码点意义上的 indexOf；from 与返回值均为码点序号 */
function cpIndexOf(text: string, query: string, from: number): number {
  const textChars = [...text];
  const queryChars = [...query];
  outer: for (let i = Math.max(0, from); i + queryChars.length <= textChars.length; i += 1) {
    for (let j = 0; j < queryChars.length; j += 1) {
      if (textChars[i + j] !== queryChars[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 坐标按 0.01 点取整生成稳定键，用于“与已有遮盖坐标相同则跳过” */
export function rectKey(rects: HitRect[]): string {
  return rects
    .map((r) => `${r.x1.toFixed(2)},${r.y1.toFixed(2)},${r.x2.toFixed(2)},${r.y2.toFixed(2)}`)
    .join('|');
}

export interface ScanCallbacks {
  onProgress?(done: number, total: number): void;
  shouldCancel?(): boolean;
}

/**
 * 逐页提取文本并搜索（纯本地）。pageTextCache 按页码缓存解析结果，
 * 重复搜索同一文档时不重复调用 getTextContent；每页之间让出事件循环以更新进度并响应取消。
 */
export async function scanDocument(
  pdf: PDFDocumentProxy,
  queries: string[],
  cache: Map<number, PageText>,
  cb: ScanCallbacks = {},
): Promise<{ hitsByPage: Map<number, FindHit[]>; noTextPages: number[]; cancelled: boolean }> {
  const hitsByPage = new Map<number, FindHit[]>();
  const noTextPages: number[] = [];
  const total = pdf.numPages;

  for (let n = 1; n <= total; n += 1) {
    if (cb.shouldCancel?.()) return { hitsByPage, noTextPages, cancelled: true };

    const proxy: PDFPageProxy = await pdf.getPage(n);
    const base = proxy.getViewport({ scale: 1 });

    let pt = cache.get(n);
    if (!pt) {
      const content: TextContent = await proxy.getTextContent();
      pt = buildPageText(n, content);
      cache.set(n, pt);
    }

    const result = searchBuiltPageText(pt, base.width, base.height, queries);
    if (result.noText) noTextPages.push(n);
    else if (result.hits.length > 0) hitsByPage.set(n, result.hits);

    cb.onProgress?.(n, total);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { hitsByPage, noTextPages, cancelled: false };
}
