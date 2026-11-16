// 프로토콜·어휘 검증기 — 클라이언트(엄격)·에이전트(관대) 양쪽 규칙
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FONT_KEYS, LIMITS, cleanText, fnv1a, fontFamilyCss, gradientCss, validateBgLayer, validateClientMsg, validateGradient, validateNode,
  validateServerMsg, validateStyle, type MsgReject,
} from '../protocol/vocab.ts'

const node = (o: Record<string, unknown> = {}) => ({ id: 5, p: 0, k: 'box', x: 1, y: 2, w: 30, h: 40, ...o })
const snap = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({ t: 'snapshot', seq: 1, iseq: 0, ms: 3, doc: { cw: 100, ch: 100, vw: 100, vh: 100, sx: 0, sy: 0, url: 'http://x/', title: 't' }, nodes, ...extra })

test('엄격: 모르는 메시지 종류는 거부', () => {
  const rej: MsgReject = { why: '', rejectedNodes: 0 }
  assert.equal(validateServerMsg({ t: 'eval', code: 'alert(1)' }, rej), undefined)
  assert.match(rej.why, /모르는 메시지/)
  assert.equal(validateServerMsg(null), undefined)
  assert.equal(validateServerMsg([1, 2]), undefined)
})

test('엄격: 모르는 최상위 필드가 있으면 메시지 전체 거부', () => {
  assert.equal(validateServerMsg({ t: 'tick', seq: 1, iseq: 0, ms: 1, html: '<b>' }), undefined)
  assert.ok(validateServerMsg({ t: 'tick', seq: 1, iseq: 0, ms: 1 }))
})

test('엄격: 노드의 모르는 필드·틀린 값은 그 노드만 거부하고 센다', () => {
  const rej: MsgReject = { why: '', rejectedNodes: 0 }
  const m = validateServerMsg(snap([node(), node({ id: 6, href: 'javascript:alert(1)' }), node({ id: 7, s: { bg: 'url(x)' } }), node({ id: 8, s: { onclick: 'x' } })]), rej)
  assert.ok(m && m.t === 'snapshot')
  assert.equal(m.nodes.length, 1)
  assert.equal(rej.rejectedNodes, 3)
})

test('엄격: 색은 rgb()/rgba() 만 — 이름·hex·var()·url() 거부', () => {
  for (const c of ['red', '#fff', 'var(--x)', 'url(/x)', 'rgb(1,2,3)', 'rgb(1, 2, 3); background:url(x)', 'rgba(1, 2, 3, 2)']) {
    assert.equal(validateNode(node({ s: { bg: c } }), { strict: true }), undefined, c)
  }
  assert.ok(validateNode(node({ s: { bg: 'rgba(1, 2, 3, 0.5)' } }), { strict: true }))
})

test('관대(에이전트): 틀린 값은 그 키만 떨어뜨린다', () => {
  const v = validateNode(node({ s: { bg: 'url(/exfil)', c: 'rgb(1, 2, 3)', zzz: 1 }, evil: 1 }))!
  assert.deepEqual(v.s, { c: 'rgb(1, 2, 3)' })
  assert.equal((v as unknown as Record<string, unknown>).evil, undefined)
})

test('텍스트: 제어·bidi·zero-width 문자는 지운다(엄격은 섞여 오면 거부)', () => {
  assert.equal(cleanText('a\u202Eevil\u202C\u200Bb\u0000'), 'aevilb')
  const run = { x: 0, y: 0, w: 1, h: 1, t: 'a\u202Eb' }
  assert.equal(validateNode(node({ k: 'text', runs: [run] }), { strict: true }), undefined)
  assert.equal(validateNode(node({ k: 'text', runs: [run] }))!.runs![0].t, 'ab')
})

test('SVG: 기하 허용목록만 — use·image·foreignObject·animate·script 는 어휘에 없다', () => {
  for (const k of ['use', 'image', 'foreignObject', 'animate', 'set', 'script', 'a', 'filter']) {
    assert.equal(validateNode(node({ k: 'svg', g: [{ k, st: {} }] }), { strict: true }), undefined, k)
  }
  assert.equal(validateNode(node({ k: 'svg', g: [{ k: 'path', d: 'M0 0 L url(x)', st: {} }] }), { strict: true }), undefined)
  assert.equal(validateNode(node({ k: 'svg', g: [{ k: 'path', d: 'M 0 0 L 10 10', st: { f: 'url(#x)' } }] }), { strict: true }), undefined)
  assert.ok(validateNode(node({ k: 'svg', g: [{ k: 'g', ch: [{ k: 'path', d: 'M 0 0 L 10 10', st: { s: 'rgb(0, 0, 0)', sw: 2, tr: 'rotate(45 10 10)' } }], st: {} }] }), { strict: true }))
  assert.equal(validateNode(node({ k: 'svg', g: [{ k: 'path', d: 'M0 0', st: { tr: 'url(x)' } }] }), { strict: true }), undefined)
})

test('그라디언트: 숫자·rgb·키워드만, CSS 로 되돌려도 url() 이 생길 수 없다', () => {
  const g = validateGradient({ k: 'lin', a: 90, st: [['rgb(255, 0, 0)'], ['rgba(0, 0, 255, 0.5)', 50, '%']] }, { strict: true })!
  assert.equal(gradientCss(g), 'linear-gradient(90deg, rgb(255, 0, 0), rgba(0, 0, 255, 0.5) 50%)')
  const r = validateGradient({ k: 'rad', sh: 'circle', sz: 'farthest-corner', at: [30, '%', 50, '%'], st: [['rgb(1, 2, 3)', 0, 'px'], ['rgb(4, 5, 6)', 70, '%']], rep: true }, { strict: true })!
  assert.equal(gradientCss(r), 'repeating-radial-gradient(circle farthest-corner at 30% 50%, rgb(1, 2, 3) 0px, rgb(4, 5, 6) 70%)')
  for (const bad of [
    { k: 'lin', a: 'url(x)', st: [['rgb(1, 2, 3)']] },
    { k: 'lin', a: 0, st: [['url(/x)']] },
    { k: 'lin', a: 0, st: [['rgb(1, 2, 3)', 5, 'em']] },
    { k: 'con', a: 0, st: [['rgb(1, 2, 3)']] },
    { k: 'lin', a: 0, st: [['rgb(1, 2, 3)']], img: 'x' },
  ]) assert.equal(validateGradient(bad, { strict: true }), undefined, JSON.stringify(bad))
  // 배경 레이어: 이미지(sha) 또는 그라디언트 하나만
  assert.equal(validateBgLayer({ i: 'a'.repeat(64), g: g }, { strict: true }), undefined)
  assert.equal(validateBgLayer({ i: '/exfil' }, { strict: true }), undefined)
  assert.ok(validateBgLayer({ g, sz: [20, 'px', 20, 'px'], rp: 'repeat-x', ps: [0, '%', 50, '%'] }, { strict: true }))
})

test('스타일: cursor 는 키워드만, 폰트는 고정 키만', () => {
  assert.equal(validateStyle({ cur: 'url(/x), auto' }, { strict: true }), undefined)
  assert.equal(validateStyle({ pf: ['Arial'] }, { strict: true }), undefined)
  assert.equal(validateStyle({ pf: ['lsans', 'evil"font'] }, { strict: true }), undefined)
  assert.deepEqual(validateStyle({ pf: ['lsans', 'cjks'], cur: 'pointer' }, { strict: true }), { pf: ['lsans', 'cjks'], cur: 'pointer' })
  // 폰트 CSS 는 키로부터만 생성
  assert.equal(fontFamilyCss(['lmono', 'cjkm']), '"jw-lmono", "jw-cjkm", "jw-dsans", "jw-cjks"')
  for (const k of FONT_KEYS) assert.match(k, /^[a-z]+$/)
})

test('메시지 상한: 노드 수·런 수', () => {
  const big = Array.from({ length: LIMITS.maxNodes + 1 }, (_, i) => node({ id: i + 1 }))
  assert.equal(validateServerMsg(snap(big)), undefined)
  const runs = Array.from({ length: LIMITS.maxRunsPerText + 1 }, () => ({ x: 0, y: 0, w: 1, h: 1, t: 'a' }))
  assert.equal(validateNode(node({ k: 'text', runs }), { strict: true }), undefined)
})

test('알림·대화상자·val 검증', () => {
  assert.ok(validateServerMsg({ t: 'notice', k: 'download', id: 'a'.repeat(32), name: 'x.txt', size: 10 }))
  assert.equal(validateServerMsg({ t: 'notice', k: 'download', id: '../etc' }), undefined)
  assert.equal(validateServerMsg({ t: 'notice', k: 'eval' }), undefined)
  assert.ok(validateServerMsg({ t: 'dialog', id: 1, k: 'confirm', msg: '지울까요?' }))
  assert.equal(validateServerMsg({ t: 'dialog', id: 1, k: 'confirm', msg: 'x\u202Ey' }), undefined)
  assert.ok(validateServerMsg({ t: 'val', id: 3, iseq: 9, vh: fnv1a('abc'), n: 3, ss: 3, se: 3, v: 'abc' }))
  assert.equal(validateServerMsg({ t: 'val', id: 3, iseq: 9, vh: -1, n: 3, ss: 3, se: 3 }), undefined)
})

test('클라이언트 메시지(에이전트 쪽 엄격): 모르는 필드·범위 밖 거부', () => {
  assert.ok(validateClientMsg({ t: 'mouse', type: 'down', id: 3, rx: 1, ry: 2, button: 'left', clicks: 1, seq: 1 }))
  assert.equal(validateClientMsg({ t: 'mouse', type: 'down', id: 3, rx: 1, ry: 2, seq: 1, x: 5 }), undefined)
  assert.equal(validateClientMsg({ t: 'mouse', type: 'teleport', id: 3, rx: 1, ry: 2, seq: 1 }), undefined)
  assert.equal(validateClientMsg({ t: 'key', type: 'down', key: 'a'.repeat(40), code: 'KeyA', vk: 65, seq: 1 }), undefined)
  assert.equal(validateClientMsg({ t: 'paste', text: 'x'.repeat(LIMITS.maxPasteChars + 1), seq: 1 }), undefined)
  assert.equal(validateClientMsg({ t: 'eval', code: '1' }), undefined)
  assert.ok(validateClientMsg({ t: 'chooser', id: 'b'.repeat(32), cancel: true }))
  assert.equal(validateClientMsg({ t: 'chooser', id: 'x', cancel: true }), undefined)
})

test('fnv1a: 양쪽이 같은 값', () => {
  assert.equal(fnv1a(''), 0x811c9dc5)
  assert.equal(fnv1a('한글'), fnv1a('한글'))
  assert.notEqual(fnv1a('ab'), fnv1a('ba'))
})
