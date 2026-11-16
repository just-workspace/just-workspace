// lib/rbiMirror(생성된 사본): 엄격 검증기·로컬 에코·원본과의 동일성
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { validateServerMsg, validateNode, gradientCss, fontFamilyCss, fnv1a, type MsgReject } from '~/lib/rbiMirror/vocab'
import { LocalEcho } from '~/lib/rbiMirror/local-echo'

describe('rbiMirror 어휘 검증(클라이언트 엄격)', () => {
  it('모르는 메시지·필드는 거부', () => {
    expect(validateServerMsg({ t: 'eval', code: 'x' })).toBeUndefined()
    expect(validateServerMsg({ t: 'tick', seq: 1, iseq: 0, ms: 1, extra: 1 })).toBeUndefined()
    expect(validateServerMsg({ t: 'tick', seq: 1, iseq: 0, ms: 1 })).toBeTruthy()
  })
  it('노드: url·이름 색·모르는 필드 거부, 셈', () => {
    const rej: MsgReject = { why: '', rejectedNodes: 0 }
    const m = validateServerMsg({
      t: 'patch', seq: 2, iseq: 1, ms: 1, del: [],
      add: [{ id: 1, p: 0, k: 'box', x: 0, y: 0, w: 1, h: 1 }, { id: 2, p: 0, k: 'box', x: 0, y: 0, w: 1, h: 1, s: { bg: 'url(/x)' } }, { id: 3, p: 0, k: 'img', x: 0, y: 0, w: 1, h: 1, src: '/exfil' }],
      upd: [],
    }, rej)
    expect(m && m.t === 'patch' && m.add.length).toBe(1)
    expect(rej.rejectedNodes).toBe(2)
    expect(validateNode({ id: 1, p: 0, k: 'text', x: 0, y: 0, w: 1, h: 1, runs: [{ x: 0, y: 0, w: 1, h: 1, t: 'a‮b' }] }, { strict: true })).toBeUndefined()
  })
  it('그라디언트·폰트 CSS 는 검증된 숫자·키에서만', () => {
    expect(gradientCss({ k: 'lin', a: 'r', st: [['rgb(1, 2, 3)'], ['rgba(0, 0, 0, 0)', 50, '%']] })).toBe('linear-gradient(to right, rgb(1, 2, 3), rgba(0, 0, 0, 0) 50%)')
    expect(fontFamilyCss(['cjks'])).toBe('"jw-cjks", "jw-dsans"')
  })
})

describe('로컬 에코', () => {
  it('예측 → 원격 확인(해시) 일치', () => {
    const e = new LocalEcho()
    e.start(5, '', false, false)
    e.push(1, { k: 'ins', t: '한' })
    expect(e.view().value).toBe('한')
    expect(e.reconcile(5, 1, fnv1a('한'), 1, 1, 1, '한')).toBe(true)
  })
})

describe('사본 = 원본(rbi/mirror)', () => {
  const root = path.resolve(__dirname, '../../../rbi/mirror')
  const files: [string, string][] = [['protocol/vocab.ts', 'vocab.ts'], ['client/src/mirror-client.ts', 'mirror-client.ts'], ['client/src/local-echo.ts', 'local-echo.ts']]
  it.skipIf(!fs.existsSync(root))('sync-client.mjs 로 만든 그대로', () => {
    for (const [src, out] of files) {
      const body = fs.readFileSync(path.join(root, src), 'utf8').replace(/\r\n/g, '\n').replace(/from '\.\.\/\.\.\/protocol\/vocab'/g, "from './vocab'")
      const want = `// ★ 생성됨 — 손으로 고치지 말 것. 원본: rbi/mirror/${src} · 동기화: node rbi/mirror/scripts/sync-client.mjs\n` + body
      const have = fs.readFileSync(path.resolve(__dirname, '../../src/lib/rbiMirror', out), 'utf8').replace(/\r\n/g, '\n')
      expect(have, `${out} 가 원본과 다르다 — node rbi/mirror/scripts/sync-client.mjs`).toBe(want)
    }
  })
})
