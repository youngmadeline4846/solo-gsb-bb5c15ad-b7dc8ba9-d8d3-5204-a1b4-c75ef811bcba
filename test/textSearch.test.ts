import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPageText,
  searchBuiltPageText,
  normalizeQuery,
  parseQueries,
  scanDocument,
  itemsContinuous,
  type TextItem,
  type TextContent,
} from '../src/pdf/textSearch.ts';

/* ---------------- 测试夹具 ---------------- */

const PAGE_W = 300;
const PAGE_H = 200;
const FONT = 12;

interface ItemOpts {
  /** 基线起点（transform 的 e、f，默认 PDF 页面坐标，y 向上） */
  x?: number;
  y?: number;
  /** 水平排版时 transform 的整字宽 / 字高，默认均为字号 12 */
  size?: number;
  /** 沿基线推进宽度；默认按 CJK 整字宽 = 字号 × 码点数 */
  width?: number;
  height?: number;
  /** 绕起点逆时针旋转角度（度），0 为从左向右的横排文字 */
  angleDeg?: number;
  hasEOL?: boolean;
}

/** 生成一个横排（可选旋转）TextItem：transform [a,b,c,d,e,f]，横排时 d 为负、y 向上 */
function item(str: string, opts: ItemOpts = {}): TextItem {
  const size = opts.size ?? FONT;
  const a = (opts.angleDeg ?? 0) * (Math.PI / 180);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cps = [...str].length;
  return {
    str,
    transform: [size * cos, size * sin, size * sin, -size * cos, opts.x ?? 0, opts.y ?? 0],
    width: opts.width ?? size * cps,
    height: opts.height ?? size,
    hasEOL: opts.hasEOL ?? false,
  };
}

function contentOf(...items: Array<TextItem | { type: string }>): TextContent {
  return { items };
}

const mark = (it: { type: string }) => it;

/* ---------------- 连续（无空格拼接）边界 ---------------- */

test('相邻 item 几何连续且无 EOL：跨 item 中文连续词直接拼接（“保”+“密”可被“保密”命中）', () => {
  // “保”占 12 点，“密”起点正好在 x=12，基线平齐
  const c = contentOf(item('保', { x: 0, y: 100 }), item('密', { x: 12, y: 100 }));
  const pt = buildPageText(1, c);

  assert.equal(pt.normalized, '保密');
  assert.equal(pt.textItemCount, 2);
  assert.deepEqual(
    pt.units.map((u) => [u.item, u.indexInItem]),
    [
      [0, 0],
      [1, 0],
    ],
  );

  const res = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密']);
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].start, 0);
  assert.equal(res.hits[0].end, 2);
  assert.equal(res.hits[0].snippet, '【保密】');
});

test('跨 item 命中框仍只覆盖各自实际字符（两个 item 各一个框，不遮盖间隙）', () => {
  const c = contentOf(item('保', { x: 0, y: 100 }), item('密', { x: 12, y: 100 }));
  const pt = buildPageText(1, c);
  const res = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密']);
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].rects.length, 2);

  // “保”的框整体位于 x≈12 左侧，“密”的框整体位于 x≈12 右侧（仅 0.02 字号的外扩）
  const pad = 0.02 * FONT + 1e-6;
  assert.ok(res.hits[0].rects[0].x2 <= 12 + pad, `左框不应跨过间隙：${JSON.stringify(res.hits[0].rects[0])}`);
  assert.ok(res.hits[0].rects[1].x1 >= 12 - pad, `右框不应跨过间隙：${JSON.stringify(res.hits[0].rects[1])}`);
});

test('方向夹角恰好 5° 且其余项达标：仍判定连续', () => {
  const a = item('保', { x: 0, y: 100 });
  const b = item('密', { x: 12, y: 100, angleDeg: 5 });
  assert.equal(itemsContinuous(a, b), true);
  const pt = buildPageText(1, contentOf(a, b));
  assert.equal(pt.normalized, '保密');
});

test('方向夹角 6°（超过 5°）：保留一个空格', () => {
  const a = item('保', { x: 0, y: 100 });
  const b = item('密', { x: 12, y: 100, angleDeg: 6 });
  assert.equal(itemsContinuous(a, b), false);
  const pt = buildPageText(1, contentOf(a, b));
  assert.equal(pt.normalized, '保 密');
  assert.equal(searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密']).hits.length, 0);
  assert.equal(searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保 密']).hits.length, 1);
});

test('基线垂直偏移恰好为较小字高的 0.2 倍：连续；超过则分隔', () => {
  const max = 0.2 * FONT; // 2.4

  const at = item('保', { x: 0, y: 100 });
  const bt = item('密', { x: 12, y: 100 + max });
  assert.equal(itemsContinuous(at, bt), true);
  assert.equal(buildPageText(1, contentOf(at, bt)).normalized, '保密');

  const a2 = item('保', { x: 0, y: 100 });
  const b2 = item('密', { x: 12, y: 100 + max + 0.1 });
  assert.equal(itemsContinuous(a2, b2), false);
  assert.equal(buildPageText(1, contentOf(a2, b2)).normalized, '保 密');
});

test('沿基线投影间距恰好为较小字高的 0.2 倍：连续；0.21 倍则分隔；负间距（重叠）连续', () => {
  const max = 0.2 * FONT; // 2.4

  const at = item('保', { x: 0, y: 100 });
  const bt = item('密', { x: 12 + max, y: 100 });
  assert.equal(itemsContinuous(at, bt), true);
  assert.equal(buildPageText(1, contentOf(at, bt)).normalized, '保密');

  const a2 = item('保', { x: 0, y: 100 });
  const b2 = item('密', { x: 12 + max + 0.12, y: 100 });
  assert.equal(itemsContinuous(a2, b2), false);
  assert.equal(buildPageText(1, contentOf(a2, b2)).normalized, '保 密');

  // 前项推进到 x=12，当前项 x=11（字形重叠 1 点）：gap=-1，连续
  const a3 = item('保', { x: 0, y: 100 });
  const b3 = item('密', { x: 11, y: 100 });
  assert.equal(itemsContinuous(a3, b3), true);
  assert.equal(buildPageText(1, contentOf(a3, b3)).normalized, '保密');
});

test('垂直偏移 / 沿基间距均以两 item 中较小的字高为准', () => {
  // 前项 20 高，当前项 12 高：阈值取 0.2*12=2.4，而非 0.2*20=4
  const big = item('保', { x: 0, y: 100, size: 20, width: 20, height: 20 });
  const small = item('密', { x: 20, y: 100 + 3, size: 12, height: 12 });
  assert.equal(itemsContinuous(big, small), false);
  assert.equal(buildPageText(1, contentOf(big, small)).normalized, '保 密');

  // 偏移 2.4（恰为较小字高的 0.2 倍）：连续
  const small2 = item('密', { x: 20, y: 100 + 2.4, size: 12, height: 12 });
  assert.equal(itemsContinuous(big, small2), true);
});

test('前项标记 hasEOL：即使几何连续也保留空格', () => {
  const a = item('保', { x: 0, y: 100, hasEOL: true });
  const b = item('密', { x: 12, y: 100 });
  assert.equal(itemsContinuous(a, b), false);
  assert.equal(buildPageText(1, contentOf(a, b)).normalized, '保 密');
});

/* ---------------- 分隔（保留空格）边界 ---------------- */

test('前项含结尾显式空白：即使几何连续也保留一个空格', () => {
  const c = contentOf(item('保 ', { x: 0, y: 100 }), item('密', { x: 24, y: 100 }));
  const pt = buildPageText(1, c);
  assert.equal(pt.normalized, '保 密');
});

test('当前项以显式空白开头：保留一个空格', () => {
  const c = contentOf(item('保', { x: 0, y: 100 }), item(' 密', { x: 12, y: 100 }));
  const pt = buildPageText(1, c);
  assert.equal(pt.normalized, '保 密');
});

test('中间夹空白 item：折叠为恰好一个空格（与是否几何连续无关）', () => {
  // “保”和“密”几何上正好相邻，中间却夹着一个宽空白 item —— 仍只保留一个空格
  const c = contentOf(
    item('保', { x: 0, y: 100 }),
    item(' ', { x: 12, y: 100, width: 0.01 }),
    item('密', { x: 24, y: 100 }),
  );
  const pt = buildPageText(1, c);
  assert.equal(pt.normalized, '保 密');
  // 分隔空格由中间的空白 item 承担（item 序号 1），而非在 item 边界处补入（-1）
  assert.deepEqual(
    pt.units.filter((u) => u.ch === ' ').map((u) => u.item),
    [1],
  );
});

test('连续多个空白 item / 多空白字符合并折叠为一个空格，且首尾不留空格', () => {
  const c = contentOf(
    item('   ', { x: 0, y: 100 }),
    item('保', { x: 0, y: 100 }),
    item('  ', { x: 12, y: 100 }),
    item(' ', { x: 20, y: 100 }),
    item('密', { x: 30, y: 100 }),
    item(' ', { x: 42, y: 100 }),
  );
  const pt = buildPageText(1, c);
  assert.equal(pt.normalized, '保 密');
});

test('item 内部换行（\\n）按一个空格折叠', () => {
  const pt = buildPageText(1, contentOf(item('保\n密', { x: 0, y: 100 })));
  assert.equal(pt.normalized, '保 密');
});

test('正常分属两词的相邻文字 item（同一行但间隔明显）仍以一个空格分隔', () => {
  // “保”推进到 12，“密”起点 30，gap=18 > 2.4
  const pt = buildPageText(1, contentOf(item('保', { x: 0, y: 100 }), item('密', { x: 30, y: 100 })));
  assert.equal(pt.normalized, '保 密');
});

/* ---------------- 命中几何：只框实际字符 ---------------- */

test('跨 item 短语命中：间隔的空白 item 不产生框，命中框只覆盖两侧实际字形', () => {
  // 两个文字 item 被一个拉宽的空白 item 隔开（归一化折叠为一个空格）。
  // 查询「保密 机密」中的空格命中该空白单元，但 intervalToRects 不为空白生成框，
  // 因此中间的空白区域不会被遮住。
  const c = contentOf(
    item('保密', { x: 0, y: 100, width: 24 }),
    item(' ', { x: 24, y: 100, width: 60 }),
    item('机密', { x: 84, y: 100, width: 24 }),
  );
  const pt = buildPageText(1, c);
  assert.equal(pt.normalized, '保密 机密');

  const res = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密 机密']);
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].rects.length, 2);

  const pad = 0.02 * FONT + 1e-6;
  // “保密”的框右缘约在 x=24，不延伸进空白区域
  assert.ok(res.hits[0].rects[0].x2 <= 24 + pad, `左框不应覆盖间隔空白：${JSON.stringify(res.hits[0].rects[0])}`);
  // “机密”的框左缘约在 x=84
  assert.ok(res.hits[0].rects[1].x1 >= 84 - pad, `右框不应覆盖间隔空白：${JSON.stringify(res.hits[0].rects[1])}`);
});

/* ---------------- 查询归一化 / 解析 / 同页搜索 ---------------- */

test('normalizeQuery：空白折叠、去首尾空白；纯空白返回 null', () => {
  assert.equal(normalizeQuery('  a\t\tb\n c '), 'a b c');
  assert.equal(normalizeQuery('保密'), '保密');
  assert.equal(normalizeQuery('   \n\t '), null);
  assert.equal(normalizeQuery(''), null);
});

test('parseQueries：换行分隔、去空词、去重并保持顺序', () => {
  assert.deepEqual(parseQueries('保密\n\n 保 密 \n保密\n秘密\n'), ['保密', '保 密', '秘密']);
  assert.deepEqual(parseQueries('\n  \n'), []);
});

test('搜索不跨页：连续词被分页拆开时另一页查不到（页内可跨 item）', async () => {
  const page1 = contentOf(item('保', { x: 0, y: 100 }));
  const page2 = contentOf(item('密', { x: 0, y: 100 }));
  const fakePdf = makeFakePdf([
    { width: PAGE_W, height: PAGE_H, content: page1 },
    { width: PAGE_W, height: PAGE_H, content: page2 },
  ]);

  const cache = new Map();
  const { hitsByPage } = await scanDocument(fakePdf, ['保密'], cache, {});
  assert.equal(hitsByPage.size, 0);

  // 同页几何连续的两个 item 仍可命中
  const { hitsByPage: hits2 } = await scanDocument(
    makeFakePdf([{ width: PAGE_W, height: PAGE_H, content: contentOf(item('保', { x: 0, y: 100 }), item('密', { x: 12, y: 100 })) }]),
    ['保密'],
    new Map(),
    {},
  );
  assert.equal(hits2.get(1)?.length ?? 0, 1);
});

test('scanDocument 分页进度与取消：取消后保留已扫描页结果', async () => {
  const mk = (ch: string) => contentOf(item(ch, { x: 0, y: 100 }));
  const fakePdf = makeFakePdf([
    { width: PAGE_W, height: PAGE_H, content: mk('保密文件') },
    { width: PAGE_W, height: PAGE_H, content: mk('无关文字') },
    { width: PAGE_W, height: PAGE_H, content: mk('保密事项') },
  ]);

  const progress: Array<[number, number]> = [];
  const { hitsByPage, cancelled } = await scanDocument(fakePdf, ['保密'], new Map(), {
    onProgress: (done, total) => progress.push([done, total]),
    shouldCancel: () => progress.length >= 1, // 第 1 页扫完后取消
  });
  assert.equal(cancelled, true);
  assert.deepEqual([...hitsByPage.keys()], [1]);
  assert.deepEqual(progress, [[1, 3]]);
});

test('无文字页标记 noText，且不产生命中', async () => {
  const fakePdf = makeFakePdf([
    { width: PAGE_W, height: PAGE_H, content: contentOf(mark({ type: 'image' })) },
    { width: PAGE_W, height: PAGE_H, content: contentOf(item('保密', { x: 0, y: 100 })) },
  ]);
  const { hitsByPage, noTextPages } = await scanDocument(fakePdf, ['保密'], new Map(), {});
  assert.deepEqual(noTextPages, [1]);
  assert.deepEqual([...hitsByPage.keys()], [2]);
});

test('同位置多词重叠命中去重，不同位置全部保留', () => {
  const pt = buildPageText(1, contentOf(item('保密保密', { x: 0, y: 100 })));
  const res = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密', '保密保密']);
  // “保密”2 处 + “保密保密”1 处，区间互不相同 -> 共 3 条
  assert.equal(res.hits.length, 3);

  // 完全相同的查询重复传入（parseQueries 已去重，这里直接验证同区间去重键稳定）
  const res2 = searchBuiltPageText(pt, PAGE_W, PAGE_H, ['保密']);
  assert.equal(res2.hits.length, 2);
});

/* ---------------- 测试用最小 pdf 代理 ---------------- */

interface FakePage {
  width: number;
  height: number;
  content: TextContent;
}

function makeFakePdf(pages: FakePage[]) {
  return {
    numPages: pages.length,
    getPage: async (n: number) => ({
      getViewport: () => ({ width: pages[n - 1].width, height: pages[n - 1].height }),
      getTextContent: async () => pages[n - 1].content,
    }),
  } as unknown as Parameters<typeof scanDocument>[0];
}
