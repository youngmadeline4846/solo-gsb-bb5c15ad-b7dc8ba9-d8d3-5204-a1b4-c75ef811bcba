import { useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RedactionMap } from '../types';

const THUMB_WIDTH = 132;

interface Props {
  pdf: PDFDocumentProxy;
  current: number;
  redactions: RedactionMap;
  onSelect(pageNum: number): void;
}

export function PageList({ pdf, current, redactions, onSelect }: Props) {
  return (
    <aside className="page-list">
      {Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => (
        <Thumb
          key={n}
          pdf={pdf}
          pageNum={n}
          active={n === current}
          count={redactions[n]?.length ?? 0}
          onClick={() => onSelect(n)}
        />
      ))}
    </aside>
  );
}

interface ThumbProps {
  pdf: PDFDocumentProxy;
  pageNum: number;
  active: boolean;
  count: number;
  onClick(): void;
}

function Thumb({ pdf, pageNum, active, count, onClick }: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | undefined;
    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const renderTask = page.render({ canvasContext: ctx, viewport });
      task = renderTask;
      await renderTask.promise.catch(() => {
        /* 取消时忽略 */
      });
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNum]);

  return (
    <button className={`thumb${active ? ' active' : ''}`} onClick={onClick}>
      <canvas ref={canvasRef} />
      <div className="thumb-meta">
        <span>第 {pageNum} 页</span>
        {count > 0 && <span className="badge">{count} 处遮盖</span>}
      </div>
    </button>
  );
}
