/**
 * 렌더러 정적 파일을 dist 로 복사한다.
 *
 * tsc 는 .ts 만 처리한다. HTML·CSS·렌더러 JS 는 컴파일 대상이 아니므로 그대로 복사해야
 * 하며, 빌드마다 삭제 후 다시 복사해야 삭제된 파일이 잔존하지 않는다.
 */
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'renderer');
const dest = path.join(root, 'dist', 'renderer');

await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });
console.log(`renderer → ${path.relative(root, dest)}`);
