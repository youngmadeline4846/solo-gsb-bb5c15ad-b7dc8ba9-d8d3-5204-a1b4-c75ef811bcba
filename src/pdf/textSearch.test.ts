import { describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  buildPageText,
  itemsAreContinuous,
  normalizeQuery,
  parseQueries,
  scanDocument,
  searchBuiltPageText,
  type TextItem,
} from './textSearch';

/**
 * 构造一个水平文字 item：字号 12，基线方向 (1,0)，基线起点默认 (100,700)。
 * width 按每字符一个字号计算，可用 over 覆盖任意字段。
 */
const F = 12;
const PAGE_W = 612;
const PAGE_H = 792;

function ti(str: string, over: Partial<TextItem> = {}): TextItem {
  return {
    str,
    transform: [F, 0, 0, F, 100, 700],
    width: [...str].length * F,
    height: F,
    hasEOL: false,
    ...over,
  };
}

/** 基线起点在 (x, y) 的水平 item */
function tiAt(str: string, x: number, y = 700, over: Partial<TextItem> = {}): TextItem {
  return ti(str, { transform: [F, 0, 0, F, x, y], ...over });
}

/** 基线方向旋转 deg 度的 item（基线起点在 (x,y)） */
function tiRot(str: string, deg: number, x: number, y = 700): TextItem {
  const rad = (deg * Math.PI) / 180;
  const c = F * Math.cos(rad);
  const s = F * Math.sin(rad);
  return ti(str, { transform: [c, s, -s, c, x, y] });
}

function contentOf(...items: TextItem[]) {
  return { items };
}

function searchNormalized(normalizedItems: TextItem[], query: string) {
  const pt = buildPageText(1, contentOf(...normalizedItems));
  return { pt, result: searchBuiltPageText(pt, PAGE_W, PAGE_H, [query]) };
}

describe('跨 TextItem 连续词（不插入空格）', () => {
  it('同向同基线、零间距的相邻 item 归一化为连续文本，“保密”可命中', () => {
    const { pt, result } = searchNormalized(
      [tiAt('保', 100), tiAt('密', 112)], // 保 的基线终点即 密 的起点
      '保密',
    );
    expect(pt.normalized).toBe('保密');
    expect(result.noText).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].query).toBe('保密');
    expect(result.hits[0].snippet).toContain('【保密】');
  });

  it('间距在较小字高 0.2 倍以内仍视为连续', () => {
    const gap = 0.2 * F - 0.01;
    const { pt, result } = searchNormalized([tiAt('保', 100), tiAt('密', 112 + gap)], '保密');
    expect(pt.normalized).toBe('保密');
    expect(result.hits).toHaveLength(1);
  });

  it('轻微重叠（负间距）也视为连续', () => {
    const { pt, result } = searchNormalized([tiAt('保', 100), tiAt('密', 111)], '保密');
    expect(pt.normalized).toBe('保密');
    expect(result.hits).toHaveLength(1);
  });

  it('基线垂直偏移在 0.2 倍字高以内（含恰达阈值）仍视为连续', () => {
    const limit = 0.2 * F;
    // 恰达阈值：perp 与阈值由同一表达式算出，应判定为连续（不超过）
    const exact = itemsAreContinuous(tiAt('保', 100), tiAt('密', 112, 700 + limit));
    expect(exact).toBe(true);
    const { pt } = searchNormalized([tiAt('保', 100), tiAt('密', 112, 700 + limit - 0.01)], '保密');
    expect(pt.normalized).toBe('保密');
  });

  it('方向夹角 5° 以内视为连续', () => {
    const { pt } = searchNormalized([tiAt('保', 100), tiRot('密', 4.9, 112)], '保密');
    expect(pt.normalized).toBe('保密');
  });

  it('旋转 90° 的竖排文本同样按基线几何判定连续', () => {
    // 基线方向 (0,1)：前一 item 终点 (100,112)，后一 item 起点与之衔接
    const a = ti('保', { transform: [0, F, -F, 0, 100, 100] });
    const b = ti('密', { transform: [0, F, -F, 0, 100, 112] });
    const { pt, result } = searchNormalized([a, b], '保密');
    expect(pt.normalized).toBe('保密');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].rects).toHaveLength(2);
  });

  it('多个 item 串成的整词可整体命中', () => {
    const items = [
      tiAt('保', 100),
      tiAt('密', 112),
      tiAt('文', 124),
      tiAt('件', 136),
    ];
    const { pt, result } = searchNormalized(items, '保密文件');
    expect(pt.normalized).toBe('保密文件');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].rects).toHaveLength(4);
  });
});

describe('分隔边界（保留一个空格）', () => {
  it('前项标记 hasEOL 时插入空格，“保密”不命中、“保 密”命中', () => {
    const items = [tiAt('保', 100, 700, { hasEOL: true }), tiAt('密', 112)];
    const { pt, result } = searchNormalized(items, '保密');
    expect(pt.normalized).toBe('保 密');
    expect(result.hits).toHaveLength(0);
    const withSpace = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保 密']);
    expect(withSpace.hits).toHaveLength(1);
  });

  it('方向夹角超过 5° 时插入空格', () => {
    const { pt } = searchNormalized([tiAt('保', 100), tiRot('密', 5.1, 112)], '保密');
    expect(pt.normalized).toBe('保 密');
  });

  it('基线垂直偏移超过较小字高 0.2 倍时插入空格', () => {
    const { pt } = searchNormalized([tiAt('保', 100), tiAt('密', 112, 700 + 0.2 * F + 0.01)], '保密');
    expect(pt.normalized).toBe('保 密');
  });

  it('沿基线间距超过 0.2 倍字高时插入空格', () => {
    const { pt, result } = searchNormalized(
      [tiAt('保', 100), tiAt('密', 112 + 0.2 * F + 0.01)],
      '保密',
    );
    expect(pt.normalized).toBe('保 密');
    expect(result.hits).toHaveLength(0);
  });

  it('前项以显式空白结尾时保留一个空格（即使几何上连续）', () => {
    const items = [
      tiAt('保 ', 100, 700, { width: 2 * F }),
      tiAt('密', 100 + 2 * F),
    ];
    const { pt, result } = searchNormalized(items, '保密');
    expect(pt.normalized).toBe('保 密');
    expect(result.hits).toHaveLength(0);
  });

  it('两项之间存在纯空白 item 时保留一个空格', () => {
    const items = [
      tiAt('保', 100),
      ti('   ', { transform: [F, 0, 0, F, 112, 700], width: 3 * F }),
      tiAt('密', 200),
    ];
    const { pt, result } = searchNormalized(items, '保密');
    expect(pt.normalized).toBe('保 密');
    expect(result.hits).toHaveLength(0);
  });

  it('后项以显式空白开头时保留一个空格', () => {
    const { pt, result } = searchNormalized([tiAt('保', 100), tiAt(' 密', 112)], '保密');
    expect(pt.normalized).toBe('保 密');
    expect(result.hits).toHaveLength(0);
  });
});

describe('命中框只覆盖实际字符', () => {
  it('连续命中按 item 各出一个框，不合并、不覆盖 item 间隙', () => {
    const gap = 2; // 0.2*F 以内，连续
    const { result } = searchNormalized([tiAt('保', 100), tiAt('密', 112 + gap)], '保密');
    expect(result.hits).toHaveLength(1);
    const rects = result.hits[0].rects;
    expect(rects).toHaveLength(2);
    // 每个框约一个字宽（12 + 两侧各 0.24 外扩），不会连成一片
    expect(rects[0].x2 - rects[0].x1).toBeLessThan(F + 1);
    expect(rects[1].x2 - rects[1].x1).toBeLessThan(F + 1);
    // item 间隙（112..114）不被任何框覆盖
    expect(rects[0].x2).toBeLessThanOrEqual(112 + 0.5);
    expect(rects[1].x1).toBeGreaterThan(rects[0].x2);
  });

  it('被拉宽空白隔开的命中不会遮住中间未命中的间隔区域', () => {
    const items = [
      tiAt('保', 100),
      ti(' ', { transform: [F, 0, 0, F, 112, 700], width: 80 }),
      tiAt('密', 200),
    ];
    const { result } = searchNormalized(items, '保 密');
    expect(result.hits).toHaveLength(1);
    const rects = result.hits[0].rects;
    expect(rects).toHaveLength(2);
    expect(rects[0].x2).toBeLessThan(113);
    expect(rects[1].x1).toBeGreaterThan(199);
    // 两框之间留有 80 余点的未覆盖空隙
    expect(rects[1].x1 - rects[0].x2).toBeGreaterThan(80);
  });
});

describe('既有行为保持不变', () => {
  it('查询与页面文本的连续空白（含换行、制表符）统一折叠为一个空格匹配', () => {
    const pt = buildPageText(1, contentOf(ti('保\t　密\n文  件')));
    expect(pt.normalized).toBe('保 密 文 件');
    // 查询词经 parseQueries 归一化（与界面搜索同一管线），两个空格折叠为一个
    const queries = parseQueries('保  密\n密 文');
    const result = searchBuiltPageText(pt, PAGE_W, PAGE_H, queries);
    expect(result.hits.map((h) => h.query).sort()).toEqual(['保 密', '密 文']);
  });

  it('同位置重复命中只保留一条（去重）', () => {
    const pt = buildPageText(1, contentOf(tiAt('保', 100), tiAt('密', 112)));
    const result = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密', '保密']);
    expect(result.hits).toHaveLength(1);
  });

  it('查询词解析：去空、去重、折叠内部空白并保持顺序', () => {
    expect(parseQueries('保密\n\n  保 密 \n保密\n机密')).toEqual(['保密', '保 密', '机密']);
    expect(normalizeQuery('   ')).toBeNull();
    expect(parseQueries('\n \n')).toEqual([]);
  });

  it('无可提取文字的页面报告 noText', () => {
    const pt = buildPageText(1, contentOf(ti('   '), ti('')));
    expect(pt.textItemCount).toBe(0);
    const result = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密']);
    expect(result.noText).toBe(true);
    expect(result.hits).toHaveLength(0);
  });

  it('扫描按页独立进行：同一词在一页命中、另一页因分隔不命中', async () => {
    const pageContent = (n: number) =>
      n === 1
        ? contentOf(tiAt('保', 100), tiAt('密', 112)) // 连续 → 命中
        : contentOf(tiAt('保', 100), tiAt('密', 200)); // 间距过大 → 不命中
    const fakePdf = {
      numPages: 2,
      getPage: async (n: number) => ({
        getViewport: () => ({ width: PAGE_W, height: PAGE_H }),
        getTextContent: async () => pageContent(n),
      }),
    } as unknown as PDFDocumentProxy;

    const cache = new Map();
    const { hitsByPage, noTextPages, cancelled } = await scanDocument(fakePdf, ['保密'], cache);
    expect(cancelled).toBe(false);
    expect(noTextPages).toEqual([]);
    expect([...hitsByPage.keys()]).toEqual([1]);
    expect(hitsByPage.get(1)).toHaveLength(1);
    expect(cache.size).toBe(2); // 每页文本各缓存一次
  });
});
