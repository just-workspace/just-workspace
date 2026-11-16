#!/usr/bin/env node
/**
 * 미러 클라이언트 동기화 — rbi/mirror 의 원본(protocol/vocab.ts · client/src/*.ts)을 frontend-react/src/lib/rbiMirror/ 로 복사한다.
 *
 * 복사 방식의 이유: frontend-react 이미지는 자체 폴더만 빌드 문맥으로 사용한다(Dockerfile COPY . .). 원본은 여기 하나이며 사본은 생성물이다.
 * 사본 최상단에 "생성됨" 머리말이 추가되고, import 경로만 변경된다('../../protocol/vocab' → './vocab').
 * 원본 수정 시: node rbi/mirror/scripts/sync-client.mjs  (불일치 시 rbi/mirror 의 test/sync.test.ts 와 frontend vitest 가 실패한다)
 *   --check 이면 기록하지 않고 상이하면 종료 코드 1.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dest = path.resolve(root, '../../frontend-react/src/lib/rbiMirror')
const FILES = [
  ['protocol/vocab.ts', 'vocab.ts'],
  ['client/src/mirror-client.ts', 'mirror-client.ts'],
  ['client/src/local-echo.ts', 'local-echo.ts'],
]
const HEADER = '// ★ 생성됨 — 손으로 고치지 말 것. 원본: rbi/mirror/{SRC} · 동기화: node rbi/mirror/scripts/sync-client.mjs\n'

export function render(src) {
  const body = fs.readFileSync(path.join(root, src), 'utf8').replace(/\r\n/g, '\n')
    .replace(/from '\.\.\/\.\.\/protocol\/vocab'/g, "from './vocab'")
    .replace(/from '\.\/local-echo'/g, "from './local-echo'")
  return HEADER.replace('{SRC}', src) + body
}

const check = process.argv.includes('--check')
let diff = 0
fs.mkdirSync(dest, { recursive: true })
for (const [src, out] of FILES) {
  const want = render(src)
  const file = path.join(dest, out)
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : ''
  if (have === want) continue
  diff++
  if (check) console.error(`어긋남: ${path.relative(process.cwd(), file)} ← ${src}`)
  else { fs.writeFileSync(file, want); console.log(`synced ${out}`) }
}
if (check && diff) process.exit(1)
if (!check && !diff) console.log('이미 같음')
