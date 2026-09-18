import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { HitRect, RedactionBox, Tool } from '../types';
import { uid } from '../types';

/** 视口（CSS 像素）坐标系中的矩形 */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 小于该尺寸（视口像素）的框视为误触 */
const MIN_SIZE = 4;

type DragState =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; id: string; rect: Rect; startX: number; startY: number }
  | { kind: 'resize'; id: string; handle: Handle; rect: Rect };

interface Draft {
  /** null 表示正在绘制新框 */
  id: string | null;
  rect: Rect;
}

interface Highlight {
  id: string;
  rects: HitRect[];
  checked: boolean;
}

interface Props {
  page: PDFPageProxy;
  zoom: number;
  /** 用户附加的旋转角度（0/90/180/270），叠加在页面自身旋转之上 */
  rotation: number;
  tool: Tool;
  boxes: RedactionBox[];
  selectedId: string | null;
  /** 文本查找候选（PDF 页面坐标），画布上高亮显示，不参与交互 */
  highlights: Highlight[];
  onSelect(id: string | null): void;
  onAdd(box: RedactionBox): void;
  onChange(box: RedactionBox): void;
}

function normalizeRect(r: Rect): Rect {
  return {
    left: r.width >= 0 ? r.left : r.left + r.width,
    top: r.height >= 0 ? r.top : r.top + r.height,
    width: Math.abs(r.width),
    height: Math.abs(r.height),
  };
}

function applyHandle(r: Rect, handle: Handle, x: number, y: number): Rect {
  let left = r.left;
  let top = r.top;
  let right = r.left + r.width;
  let bottom = r.top + r.height;
  if (handle.includes('w')) left = x;
  if (handle.includes('e')) right = x;
  if (handle.includes('n')) top = y;
  if (handle.includes('s')) bottom = y;
  return normalizeRect({ left, top, width: right - left, height: bottom - top });
}

export function PageCanvas({
  page,
  zoom,
  rotation,
  tool,
  boxes,
  selectedId,
  highlights,
  onSelect,
  onAdd,
  onChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  // 所有坐标换算都经过 viewport：缩放 / 旋转不会改变已保存的页面坐标
  const viewport = useMemo(
    () => page.getViewport({ scale: zoom, rotation: (page.rotate + rotation) % 360 }),
    [page, zoom, rotation],
  );

  // 渲染 PDF 页面到底层 canvas（高分屏按 devicePixelRatio 超采样）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    task.promise.catch(() => {
      /* 渲染被取消（缩放/翻页）时忽略 */
    });
    return () => task.cancel();
  }, [page, viewport]);

  /** 页面坐标 -> 视口矩形（用于显示） */
  const boxToRect = (b: RedactionBox): Rect => {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([b.x1, b.y1, b.x2, b.y2]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  };

  /** 查找候选框（PDF 页面坐标） -> 视口矩形 */
  const hitRectToRect = (r: HitRect): Rect => {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x1, r.y1, r.x2, r.y2]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  };

  /** 视口矩形 -> 页面坐标（用于保存） */
  const rectToBox = (r: Rect, id: string): RedactionBox => {
    const [ax, ay] = viewport.convertToPdfPoint(r.left, r.top);
    const [bx, by] = viewport.convertToPdfPoint(r.left + r.width, r.top + r.height);
    return {
      id,
      x1: Math.min(ax, bx),
      y1: Math.min(ay, by),
      x2: Math.max(ax, bx),
      y2: Math.max(ay, by),
    };
  };

  const localPoint = (clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // 拖拽过程监听在 window 上，指针移出页面区域也能继续
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const p = localPoint(e.clientX, e.clientY);
      if (drag.kind === 'draw') {
        setDraft({
          id: null,
          rect: normalizeRect({
            left: drag.startX,
            top: drag.startY,
            width: p.x - drag.startX,
            height: p.y - drag.startY,
          }),
        });
      } else if (drag.kind === 'move') {
        setDraft({
          id: drag.id,
          rect: {
            ...drag.rect,
            left: drag.rect.left + p.x - drag.startX,
            top: drag.rect.top + p.y - drag.startY,
          },
        });
      } else {
        setDraft({
          id: drag.id,
          rect: applyHandle(drag.rect, drag.handle, p.x, p.y),
        });
      }
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const d = draftRef.current;
      setDraft(null);
      if (!d || d.rect.width < MIN_SIZE || d.rect.height < MIN_SIZE) return;
      // 拖拽结束时才把结果换算回页面坐标并提交（产生一条撤销记录）
      if (drag.kind === 'draw') {
        onAdd(rectToBox(d.rect, uid()));
      } else {
        onChange(rectToBox(d.rect, drag.id));
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  });

  const startDraw = (e: React.PointerEvent) => {
    if (tool !== 'draw' || e.button !== 0) return;
    const p = localPoint(e.clientX, e.clientY);
    dragRef.current = { kind: 'draw', startX: p.x, startY: p.y };
    setDraft({ id: null, rect: { left: p.x, top: p.y, width: 0, height: 0 } });
  };

  const startMove = (e: React.PointerEvent, box: RedactionBox) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    onSelect(box.id);
    const p = localPoint(e.clientX, e.clientY);
    const rect = boxToRect(box);
    dragRef.current = { kind: 'move', id: box.id, rect, startX: p.x, startY: p.y };
    setDraft({ id: box.id, rect });
  };

  const startResize = (e: React.PointerEvent, box: RedactionBox, handle: Handle) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    onSelect(box.id);
    const rect = boxToRect(box);
    dragRef.current = { kind: 'resize', id: box.id, handle, rect };
    setDraft({ id: box.id, rect });
  };

  return (
    <div
      className={`page-stage tool-${tool}`}
      style={{ width: viewport.width, height: viewport.height }}
      onPointerDown={tool === 'draw' ? startDraw : () => onSelect(null)}
    >
      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay">
        {highlights.map((h) =>
          h.rects.map((r, i) => {
            const vr = hitRectToRect(r);
            return (
              <div
                key={`${h.id}-${i}`}
                className={`find-highlight${h.checked ? ' checked' : ''}`}
                style={{ left: vr.left, top: vr.top, width: vr.width, height: vr.height }}
              />
            );
          }),
        )}
        {boxes.map((b) => {
          const r = draft && draft.id === b.id ? draft.rect : boxToRect(b);
          const selected = b.id === selectedId;
          return (
            <div
              key={b.id}
              className={`redaction-box${selected ? ' selected' : ''}`}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              onPointerDown={(e) => startMove(e, b)}
              title="遮盖区域"
            >
              {selected &&
                tool === 'select' &&
                HANDLES.map((h) => (
                  <span
                    key={h}
                    className={`handle handle-${h}`}
                    onPointerDown={(e) => startResize(e, b, h)}
                  />
                ))}
            </div>
          );
        })}
        {draft && draft.id === null && (
          <div
            className="redaction-box drafting"
            style={{
              left: draft.rect.left,
              top: draft.rect.top,
              width: draft.rect.width,
              height: draft.rect.height,
            }}
          />
        )}
      </div>
    </div>
  );
}
