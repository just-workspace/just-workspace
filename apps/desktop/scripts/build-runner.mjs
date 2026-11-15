// 원격 데스크톱 화면 러너 번들 — src/runner/remote-runner.ts + livekit-client → dist/renderer/remote-runner.js 하나.
// 러너 창은 샌드박스·contextIsolation 이라 import 가 안 된다 → IIFE 로 묶는다. copy-renderer.mjs 다음에 돈다.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [path.join(root, 'src', 'runner', 'remote-runner.ts')],
  outfile: path.join(root, 'dist', 'renderer', 'remote-runner.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('runner → dist/renderer/remote-runner.js');
