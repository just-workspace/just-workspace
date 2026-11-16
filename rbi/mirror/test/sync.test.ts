// frontend-react 의 미러 클라이언트 사본과 원본의 일치 여부 확인(생성물 불일치 방지). 프런트 폴더가 없으면(이미지 빌드 내) 건너뛴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const front = path.resolve(here, '../../../frontend-react/src/lib/rbiMirror')

test('미러 클라이언트 사본 = 원본(sync-client.mjs --check)', { skip: !fs.existsSync(front) }, () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, [path.resolve(here, '../scripts/sync-client.mjs'), '--check'], { stdio: 'pipe' }),
    '원본을 고쳤으면 node rbi/mirror/scripts/sync-client.mjs 를 돌릴 것')
})
