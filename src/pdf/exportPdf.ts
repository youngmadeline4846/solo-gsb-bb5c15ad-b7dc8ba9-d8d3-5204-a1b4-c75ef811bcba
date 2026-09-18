import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RedactionMap } from '../types';

/** 导出栅格化分辨率：144 DPI（PDF 用户空间为 72 DPI，故缩放系数为 2） */
export const EXPORT_DPI = 144;

/**
 * 安全导出：
 * 1. 每页按 144 DPI 栅格化为位图（原始文字、矢量对象全部消失）；
 * 2. 遮盖区域以纯黑矩形烧入位图；
 * 3. 用 pdf-lib 生成全新 PDF，每页只包含一张位图，页面尺寸与原页保持一致。
 * 因此导出的 PDF 不再保留被遮区域的可复制文字或任何原始页面对象。
 */
export async function exportRedactedPdf(
  pdf: PDFDocumentProxy,
  redactions: RedactionMap,
  sourceName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const out = await PDFDocument.create();
  const scale = EXPORT_DPI / 72;

  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    // 原始页面尺寸（点），包含页面自身旋转，保证导出后各页尺寸不变
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // 烧入纯黑遮盖（页面坐标 -> 位图像素坐标）
    const boxes = redactions[n] ?? [];
    ctx.fillStyle = '#000000';
    for (const b of boxes) {
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([b.x1, b.y1, b.x2, b.y2]);
      ctx.fillRect(
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.abs(x2 - x1),
        Math.abs(y2 - y1),
      );
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error(`第 ${n} 页栅格化失败`);

    const png = await out.embedPng(await blob.arrayBuffer());
    const newPage = out.addPage([base.width, base.height]);
    newPage.drawImage(png, { x: 0, y: 0, width: base.width, height: base.height });

    onProgress?.(n, pdf.numPages);
  }

  const bytes = await out.save();
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sourceName.replace(/\.pdf$/i, '') || 'document'}_已遮盖.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
