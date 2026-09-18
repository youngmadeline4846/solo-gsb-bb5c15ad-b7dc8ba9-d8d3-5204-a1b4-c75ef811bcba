// 无额外依赖的测试运行器：用 esbuild（vite 的传递依赖，已随 npm ci 安装）把
// TS 测试文件打包成临时 ESM，再用 Node 内置的 node:test 执行，退出码反映通过情况。
// 用法：node scripts/run-tests.mjs（见 package.json 的 "test" 脚本）
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = new URL('../test/textSearch.test.ts', import.meta.url);
const outfile = join(tmpdir(), `text-search-test-${process.pid}.mjs`);

try {
  await build({
    entryPoints: [entry.pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    // 源码只用了 pdfjs-dist 的类型导入，打包后无运行时残留；保留正常的包解析
  });

  process.on('exit', () => {
    rm(outfile, { force: true }).catch(() => {});
  });

  await import(pathToFileURL(outfile).href);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
