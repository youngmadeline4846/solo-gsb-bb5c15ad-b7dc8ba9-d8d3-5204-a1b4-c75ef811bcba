import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjs } from './pdf/pdfjs';
import type { FindHit, HitRect, RedactionBox, RedactionMap, Tool } from './types';
import { uid } from './types';
import { useUndoable } from './state/useUndoable';
import { exportRedactedPdf } from './pdf/exportPdf';
import {
  PageText,
  parseQueries,
  rectKey,
  scanDocument,
} from './pdf/textSearch';
import { Toolbar } from './components/Toolbar';
import { PageList } from './components/PageList';
import { PageCanvas } from './components/PageCanvas';
import { FindPanel, type FindStatus } from './components/FindPanel';

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('');
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [zoom, setZoom] = useState(1.25);
  const [rotation, setRotation] = useState(0);
  const [tool, setTool] = useState<Tool>('draw');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- 文本查找遮盖 ----
  const [findOpen, setFindOpen] = useState(false);
  const [queryInput, setQueryInput] = useState('');
  const [findHits, setFindHits] = useState<Map<number, FindHit[]>>(new Map());
  const [checkedHits, setCheckedHits] = useState<Set<string>>(new Set());
  const [findStatus, setFindStatus] = useState<FindStatus>({ kind: 'idle' });
  const [noTextPages, setNoTextPages] = useState<number[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [appliedCount, setAppliedCount] = useState(0);
  const [lastQueryCount, setLastQueryCount] = useState(0);
  const [firstQuery, setFirstQuery] = useState('');
  const scanToken = useRef(0);
  const cancelToken = useRef(0);
  const pageTextCache = useRef<Map<number, PageText>>(new Map());

  const {
    value: redactions,
    set: setRedactions,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
  } = useUndoable<RedactionMap>({});

  const numPages = doc?.numPages ?? 0;
  const boxesForPage = redactions[pageNum] ?? [];
  const totalBoxes = Object.values(redactions).reduce((sum, list) => sum + list.length, 0);

  // 供搜索 / 批量应用回调读取最新遮盖集合，避免闭包过期
  const redactionsRef = useRef(redactions);
  redactionsRef.current = redactions;
  const findHitsRef = useRef(findHits);
  findHitsRef.current = findHits;

  const openFile = useCallback(
    async (file: File) => {
      setError(null);
      scanToken.current += 1; // 中止进行中的查找扫描
      cancelToken.current += 1;
      try {
        const data = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data }).promise;
        void doc?.destroy();
        setDoc(pdf);
        setFileName(file.name);
        setPageNum(1);
        setRotation(0);
        setSelectedId(null);
        reset({});
        pageTextCache.current = new Map();
        setFindHits(new Map());
        setCheckedHits(new Set());
        setNoTextPages([]);
        setSkippedCount(0);
        setAppliedCount(0);
        setFindStatus({ kind: 'idle' });
      } catch {
        setError('无法解析该文件，请确认是有效的 PDF。');
      }
    },
    [doc, reset],
  );

  // 当前页面对象
  useEffect(() => {
    if (!doc) {
      setPage(null);
      return;
    }
    let cancelled = false;
    doc.getPage(pageNum).then(
      (p) => {
        if (!cancelled) setPage(p);
      },
      () => setError('读取页面失败。'),
    );
    return () => {
      cancelled = true;
    };
  }, [doc, pageNum]);

  // 键盘快捷键：撤销 / 重做 / 删除选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!doc) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !typing && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && !typing && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !typing) {
        e.preventDefault();
        deleteBox(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 拖拽 PDF 文件到窗口即可导入
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
        void openFile(file);
      } else {
        setError('请拖入 PDF 文件。');
      }
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
    };
  }, [openFile]);

  const mutatePage = (pageNo: number, fn: (boxes: RedactionBox[]) => RedactionBox[]) => {
    const next = fn(redactions[pageNo] ?? []);
    const map = { ...redactions };
    if (next.length === 0) delete map[pageNo];
    else map[pageNo] = next;
    setRedactions(map);
  };

  const addBox = (box: RedactionBox) => {
    mutatePage(pageNum, (boxes) => [...boxes, box]);
    setSelectedId(box.id);
  };

  const changeBox = (box: RedactionBox) => {
    mutatePage(pageNum, (boxes) => boxes.map((b) => (b.id === box.id ? box : b)));
  };

  const deleteBox = (id: string) => {
    mutatePage(pageNum, (boxes) => boxes.filter((b) => b.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const clearPage = () => {
    if (boxesForPage.length === 0) return;
    mutatePage(pageNum, () => []);
    setSelectedId(null);
  };

  // ================= 文本查找遮盖 =================

  /** 过滤掉与已有遮盖坐标相同的候选；返回剩余命中与跳过数量 */
  const filterExisting = (
    hits: Map<number, FindHit[]>,
    map: RedactionMap,
  ): { kept: Map<number, FindHit[]>; skipped: number } => {
    const kept = new Map<number, FindHit[]>();
    let skipped = 0;
    for (const [p, list] of hits) {
      const existing = new Set((map[p] ?? []).map((b) => rectKey([b])));
      const remain: FindHit[] = [];
      for (const h of list) {
        const fresh = h.rects.filter((r) => !existing.has(rectKey([r])));
        if (fresh.length === 0) {
          skipped += 1;
          continue;
        }
        remain.push(fresh.length < h.rects.length ? { ...h, rects: fresh } : h);
      }
      if (remain.length > 0) kept.set(p, remain);
    }
    return { kept, skipped };
  };

  const runSearch = useCallback(async () => {
    if (!doc) return;
    const queries = parseQueries(queryInput);
    if (queries.length === 0) {
      setFindStatus({ kind: 'empty-query' });
      setFindHits(new Map());
      setCheckedHits(new Set());
      setNoTextPages([]);
      setSkippedCount(0);
      setAppliedCount(0);
      return;
    }

    const token = scanToken.current + 1;
    scanToken.current = token;
    cancelToken.current = token; // 新搜索默认未取消
    setAppliedCount(0);
    setFindStatus({ kind: 'scanning', done: 0, total: doc.numPages });
    setFindHits(new Map());
    setCheckedHits(new Set());
    setNoTextPages([]);
    setSkippedCount(0);

    try {
      const { hitsByPage, noTextPages: emptyPages, cancelled } = await scanDocument(
        doc,
        queries,
        pageTextCache.current,
        {
          onProgress: (done, total) => {
            if (scanToken.current === token) setFindStatus({ kind: 'scanning', done, total });
          },
          shouldCancel: () => cancelToken.current !== token,
        },
      );
      if (scanToken.current !== token) return; // 已被新搜索 / 关闭文档取代

      // 与已有遮盖坐标相同的候选直接跳过
      const { kept, skipped } = filterExisting(hitsByPage, redactionsRef.current);
      const total = [...kept.values()].reduce((s, l) => s + l.length, 0);

      setFindHits(kept);
      setNoTextPages(emptyPages);
      setSkippedCount(skipped);
      // 默认全部勾选
      setCheckedHits(new Set([...kept.values()].flat().map((h) => h.id)));
      setLastQueryCount(queries.length);
      setFirstQuery(queries[0]);
      setFindStatus(cancelled ? { kind: 'cancelled', partial: total > 0 } : { kind: 'done' });
    } catch {
      if (scanToken.current === token) {
        setFindStatus({ kind: 'error', message: '文字提取失败，请重试。' });
      }
    }
  }, [doc, queryInput]);

  const cancelSearch = useCallback(() => {
    cancelToken.current += 1; // scanDocument 在下一页边界退出并回传部分结果
  }, []);

  const toggleHit = useCallback((id: string) => {
    setCheckedHits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePage = useCallback((p: number, on: boolean) => {
    const ids = new Set((findHitsRef.current.get(p) ?? []).map((h) => h.id));
    setCheckedHits((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback((on: boolean) => {
    const all = [...findHitsRef.current.values()].flat().map((h) => h.id);
    setCheckedHits(on ? new Set(all) : new Set());
  }, []);

  /**
   * 把勾选的候选一次加入遮盖：与已有遮盖 / 本批其他候选坐标相同的矩形跳过，
   * 整批只提交一次 setRedactions，因此只有一条撤销记录。
   */
  const applyChecked = useCallback(() => {
    const base = redactionsRef.current;
    const hits = findHitsRef.current;
    // 每页已知坐标键（已有遮盖 + 本批新增），用于防重复
    const keysByPage = new Map<number, Set<string>>();
    for (const p of Object.keys(base)) {
      keysByPage.set(Number(p), new Set((base[Number(p)] ?? []).map((b) => rectKey([b]))));
    }

    const additions = new Map<number, RedactionBox[]>();
    const consumed = new Set<string>();

    for (const list of hits.values()) {
      for (const h of list) {
        if (!checkedHits.has(h.id)) continue;
        let keySet = keysByPage.get(h.page);
        if (!keySet) {
          keySet = new Set();
          keysByPage.set(h.page, keySet);
        }
        const fresh: HitRect[] = [];
        for (const r of h.rects) {
          const k = rectKey([r]);
          if (keySet.has(k)) continue;
          keySet.add(k);
          fresh.push(r);
        }
        if (fresh.length === 0) continue;
        const pageAdds = additions.get(h.page) ?? [];
        for (const r of fresh) {
          pageAdds.push({ id: uid(), x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
        }
        additions.set(h.page, pageAdds);
        consumed.add(h.id);
      }
    }

    if (consumed.size === 0) return;

    const next: RedactionMap = { ...base };
    for (const [p, boxes] of additions) {
      next[p] = [...(base[p] ?? []), ...boxes];
    }
    setRedactions(next); // 整批仅一条撤销记录

    // 已完整加入的命中从候选列表移除；勾选集合同步清理
    const remaining = new Map<number, FindHit[]>();
    for (const [p, list] of hits) {
      const rest = list.filter((h) => !consumed.has(h.id));
      if (rest.length > 0) remaining.set(p, rest);
    }
    setFindHits(remaining);
    setCheckedHits((prev) => {
      const nextSet = new Set(prev);
      for (const id of consumed) nextSet.delete(id);
      return nextSet;
    });
    setAppliedCount((n) => n + consumed.size);
  }, [checkedHits, setRedactions]);

  /** 关闭面板时取消进行中的扫描（已完成的结果保留在状态中） */
  const closeFind = useCallback(() => {
    scanToken.current += 1;
    cancelToken.current += 1;
    setFindOpen(false);
  }, []);

  const zoomIn = () => setZoom((z) => ZOOM_LEVELS.find((l) => l > z + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
  const zoomOut = () => setZoom((z) => [...ZOOM_LEVELS].reverse().find((l) => l < z - 0.001) ?? ZOOM_LEVELS[0]);

  /** 当前页查找候选 -> 画布高亮（坐标为 PDF 页面坐标，缩放/旋转由 PageCanvas 换算） */
  const currentHighlights = useMemo(
    () =>
      (findHits.get(pageNum) ?? []).map((h) => ({
        id: h.id,
        rects: h.rects,
        checked: checkedHits.has(h.id),
      })),
    [findHits, checkedHits, pageNum],
  );

  const totalCandidates = useMemo(
    () => [...findHits.values()].reduce((s, l) => s + l.length, 0),
    [findHits],
  );

  const onExport = async () => {
    if (!doc || exporting) return;
    setExporting(true);
    setProgress({ done: 0, total: doc.numPages });
    setError(null);
    try {
      await exportRedactedPdf(doc, redactions, fileName, (done, total) =>
        setProgress({ done, total }),
      );
    } catch {
      setError('导出失败，请重试。');
    } finally {
      setExporting(false);
      setProgress(null);
    }
  };

  return (
    <div className="app">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = '';
        }}
      />

      <Toolbar
        hasDoc={!!doc}
        tool={tool}
        zoom={zoom}
        pageNum={pageNum}
        numPages={numPages}
        canUndo={canUndo}
        canRedo={canRedo}
        exporting={exporting}
        findOpen={findOpen}
        onOpen={() => fileInputRef.current?.click()}
        onToolChange={setTool}
        onToggleFind={() => setFindOpen((v) => !v)}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onRotate={() => setRotation((r) => (r + 90) % 360)}
        onPrevPage={() => setPageNum((n) => Math.max(1, n - 1))}
        onNextPage={() => setPageNum((n) => Math.min(numPages, n + 1))}
        onUndo={undo}
        onRedo={redo}
        onClearPage={clearPage}
        onExport={() => void onExport()}
      />

      {error && <div className="error-bar">{error}</div>}
      {progress && (
        <div className="progress-bar">
          正在按 144 DPI 栅格化并烧入遮盖：第 {progress.done} / {progress.total} 页
        </div>
      )}

      {doc ? (
        <div className="main">
          <PageList pdf={doc} current={pageNum} redactions={redactions} onSelect={setPageNum} />
          <div className="viewer">
            {page && (
              <PageCanvas
                page={page}
                zoom={zoom}
                rotation={rotation}
                tool={tool}
                boxes={boxesForPage}
                selectedId={selectedId}
                highlights={currentHighlights}
                onSelect={setSelectedId}
                onAdd={addBox}
                onChange={changeBox}
              />
            )}
          </div>
          {findOpen && (
            <FindPanel
              queryInput={queryInput}
              onQueryInputChange={setQueryInput}
              onSearch={() => void runSearch()}
              onCancel={cancelSearch}
              scanning={findStatus.kind === 'scanning'}
              status={findStatus}
              hitsByPage={findHits}
              checked={checkedHits}
              onToggle={toggleHit}
              onTogglePage={togglePage}
              onToggleAll={toggleAll}
              onApply={applyChecked}
              onClose={closeFind}
              onJump={setPageNum}
              currentPage={pageNum}
              queryCount={lastQueryCount}
              firstQuery={firstQuery}
              noTextPages={noTextPages}
              skippedCount={skippedCount}
              appliedCount={appliedCount}
            />
          )}
        </div>
      ) : (
        <div className="empty">
          <div className="empty-card">
            <h1>PDF 安全遮盖台</h1>
            <p>在浏览器本地对 PDF 进行不可逆遮盖：所有处理均在本机完成，文件不会上传到任何服务器。</p>
            <button className="primary big" onClick={() => fileInputRef.current?.click()}>
              选择 PDF 文件
            </button>
            <p className="hint">也可以将 PDF 文件直接拖入窗口</p>
          </div>
        </div>
      )}

      <footer className="status-bar">
        <span>{doc ? fileName : '未打开文件'}</span>
        {doc && (
          <>
            <span>本页遮盖 {boxesForPage.length} 处</span>
            <span>全文共 {totalBoxes} 处</span>
            {findOpen && totalCandidates > 0 && <span>查找候选 {totalCandidates} 处</span>}
            <span>导出分辨率 144 DPI · 纯本地处理</span>
          </>
        )}
      </footer>
    </div>
  );
}
