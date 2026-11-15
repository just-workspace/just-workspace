// 네이티브 애드온(native/jw_native_audio.node) 빌드 — node-gyp + MSVC. cmake 불필요.
//
//   node scripts/native-build.mjs                 # Electron 헤더(package.json devDependencies.electron 버전)로 빌드 — 배포용
//   node scripts/native-build.mjs --runtime node  # 이 Node 로 빌드 — 테스트 하네스용(N-API 라 결과 바이너리는 둘 다 Electron·Node 에서 로드된다)
//   node scripts/native-build.mjs --clean         # build/ 지우고 다시
//
// 필요한 도구(Windows): Visual Studio Build Tools 2022 "C++ 데스크톱 개발" 워크로드(MSVC v143 + Windows 11 SDK), Python 3.
//   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
// node-gyp 는 devDependency(13.x). Electron 헤더는 https://electronjs.org/headers 에서 node-gyp 가 내려받아 ~/.cache/node-gyp 에 둔다.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'native');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const runtime = opt('--runtime', 'electron');
const clean = args.includes('--clean');

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = (pkg.devDependencies?.electron || '').replace(/^[^\d]*/, '');
if (runtime === 'electron' && !electronVersion) {
  console.error('devDependencies.electron 버전을 못 읽었다');
  process.exit(2);
}

if (clean) rmSync(path.join(nativeDir, 'build'), { recursive: true, force: true });

const gyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
if (!existsSync(gyp)) {
  console.error('node-gyp 가 없다 — apps/desktop 에서 npm install 먼저');
  process.exit(2);
}
const gypArgs = [gyp, 'rebuild', '--release', `--arch=${process.arch}`];
if (runtime === 'electron') {
  gypArgs.push(`--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers');
}
console.log(`[native-build] runtime=${runtime}${runtime === 'electron' ? ` electron=${electronVersion}` : ` node=${process.version}`} arch=${process.arch}`);
const r = spawnSync(process.execPath, gypArgs, { cwd: nativeDir, stdio: 'inherit', env: { ...process.env, npm_config_msvs_version: process.env.npm_config_msvs_version || '2022' } });
if (r.status !== 0) {
  console.error('[native-build] 실패');
  process.exit(r.status ?? 1);
}
const out = path.join(nativeDir, 'build', 'Release', 'jw_native_audio.node');
console.log(`[native-build] ok → ${path.relative(root, out)} (${existsSync(out) ? Math.round(require_size(out) / 1024) + ' KB' : 'missing'})`);

function require_size(p) {
  return readFileSync(p).byteLength;
}
