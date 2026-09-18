import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// 使用 Vite 打包的本地 worker，避免任何外部 CDN 请求
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
