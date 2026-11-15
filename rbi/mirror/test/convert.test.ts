// 원시 레코드 → 어휘: 작성자 문자열(폰트 이름·url·비밀번호)이 남지 않는지, 종류별 변환
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPUTED_STYLE_ALLOWLIST, validateNode } from '../protocol/vocab.ts'
import { convert, synthId, type ConvertDeps } from '../agent/src/convert.ts'
import type { RawRec } from '../agent/src/page/collector.ts'
import type { FontInfo } from '../agent/src/fonts.ts'

function cs(over: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    display: 'block', visibility: 'visible', opacity: '1', 'overflow-x': 'visible', 'overflow-y': 'visible', position: 'static', 'z-index': 'auto',
    'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'background-size': 'auto', 'background-position-x': '0%', 'background-position-y': '0%', 'background-repeat': 'repeat',
    color: 'rgb(34, 34, 34)', 'font-family': '"Evil Corp Sans", Arial', 'font-size': '14px', 'font-weight': '400', 'font-style': 'normal',
    'text-decoration-line': 'none', 'text-decoration-color': 'rgb(34, 34, 34)', 'text-transform': 'none', 'letter-spacing': 'normal', 'text-align': 'start', 'white-space': 'normal',
    'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
    'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none',
    'border-top-color': 'rgb(0, 0, 0)', 'border-right-color': 'rgb(0, 0, 0)', 'border-bottom-color': 'rgb(0, 0, 0)', 'border-left-color': 'rgb(0, 0, 0)',
    'border-top-left-radius': '0px', 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px',
    'box-shadow': 'none', cursor: 'auto', 'outline-width': '0px', 'outline-style': 'none', 'outline-color': 'rgb(0, 0, 0)', 'pointer-events': 'auto', 'user-select': 'auto',
    transform: 'none', fill: 'rgb(0, 0, 0)', stroke: 'none', 'stroke-width': '1px', 'stroke-dasharray': 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter',
    'fill-opacity': '1', 'stroke-opacity': '1', 'text-anchor': 'start', ...over,
  }
  return COMPUTED_STYLE_ALLOWLIST.map(k => base[k] ?? '')
}

function deps(raw: Record<number, RawRec> = {}, opts: { sha?: (u: string) => string | undefined; font?: Partial<FontInfo> } = {}) {
  const calls = { urls: [] as string[], rasters: [] as string[], hosts: [] as number[] }
  const d: ConvertDeps = {
    shaFor: u => { calls.urls.push(u); return opts.sha?.(u) },
    font: () => ({ keys: ['lsans', 'cjks'], custom: false, icon: false, resolved: true, ...opts.font }),
    raster: (_id, key) => { calls.rasters.push(key); return undefined },
    raw: id => raw[id],
    iconHost: (id, set) => { if (set !== undefined) calls.hosts.push(id); return undefined },
  }
  return { d, calls }
}

test('상자: 계산값 → 어휘, 작성자 폰트 이름·url 은 나가지 않는다', () => {
  const rec: RawRec = { i: 2, p: 0, t: 'e', n: 'div', o: 1, r: [10, 20, 100, 50], cs: cs({ 'background-image': 'url("http://127.0.0.1:7100/exfil?bg")', 'background-color': 'rgb(255, 0, 0)', cursor: 'url("/exfil?c"), pointer', 'box-shadow': 'rgb(0, 0, 0) 0px 2px 8px 0px' }) }
  const { d, calls } = deps()
  const n = convert(rec, d).node!
  assert.equal(n.k, 'box'); assert.equal(n.x, 10); assert.equal(n.s!.bg, 'rgb(255, 0, 0)')
  assert.equal(n.s!.cur, undefined)
  assert.deepEqual(calls.urls, ['http://127.0.0.1:7100/exfil?bg'])
  const j = JSON.stringify(n)
  assert.doesNotMatch(j, /exfil|Evil Corp|url\(/)
  assert.ok(validateNode(n, { strict: true }))
})

test('텍스트: 부모 계산값 + 원격이 실제로 쓴 폰트 키', () => {
  const parent: RawRec = { i: 2, p: 0, t: 'e', n: 'p', o: 1, r: [0, 0, 200, 20], cs: cs({ color: 'rgb(1, 2, 3)', 'font-weight': '700', 'pointer-events': 'none', cursor: 'pointer' }) }
  const rec: RawRec = { i: 3, p: 2, t: 'x', o: 1, r: [0, 0, 80, 16], tx: [[0, 0, 80, 16, '안녕 hello']], ps: 2 }
  const { d } = deps({ 2: parent })
  const n = convert(rec, d).node!
  assert.equal(n.k, 'text'); assert.equal(n.runs![0].t, '안녕 hello')
  assert.deepEqual(n.s!.pf, ['lsans', 'cjks']); assert.equal(n.s!.c, 'rgb(1, 2, 3)'); assert.equal(n.s!.fw, 700)
  assert.equal(n.s!.pe, true); assert.equal(n.s!.cur, 'pointer')
})

test('비밀번호 위젯: 값은 수집기가 길이만 준다 — 마스킹 문자만', () => {
  const rec: RawRec = { i: 4, p: 0, t: 'e', n: 'input', o: 1, r: [0, 0, 120, 24], cs: cs(), a: { type: 'password', ph: '비밀번호' }, w: { n: 7 } }
  const { d } = deps()
  const n = convert(rec, d).node!
  assert.equal(n.k, 'widget'); assert.equal(n.wk, 'password'); assert.equal(n.wv, '•••••••')
})

test('select·checkbox·range·button', () => {
  const { d } = deps()
  assert.equal(convert({ i: 5, p: 0, t: 'e', n: 'select', o: 1, r: [0, 0, 80, 20], cs: cs(), w: { so: 'switch' } }, d).node!.wopt, 'switch')
  assert.equal(convert({ i: 6, p: 0, t: 'e', n: 'input', o: 1, r: [0, 0, 13, 13], cs: cs(), a: { type: 'checkbox' }, w: { c: true } }, d).node!.wc, true)
  assert.equal(convert({ i: 7, p: 0, t: 'e', n: 'input', o: 1, r: [0, 0, 100, 16], cs: cs(), a: { type: 'range' }, w: { v: '0.25' } }, d).node!.wr, 0.25)
  assert.equal(convert({ i: 8, p: 0, t: 'e', n: 'input', o: 1, r: [0, 0, 60, 20], cs: cs(), a: { type: 'submit', val: '로그인' } }, d).node!.wv, '로그인')
})

test('img: 자산 sha 가 준비되면 a, 아니면 비워 두고 요청', () => {
  const SHA = 'c'.repeat(64)
  const { d, calls } = deps({}, { sha: u => (u === 'http://p/i.png' ? SHA : undefined) })
  assert.equal(convert({ i: 9, p: 0, t: 'e', n: 'img', o: 1, r: [0, 0, 48, 48], cs: cs(), a: { src: 'http://p/i.png' } }, d).node!.a, SHA)
  assert.equal(convert({ i: 10, p: 0, t: 'e', n: 'img', o: 1, r: [0, 0, 48, 48], cs: cs(), a: { src: 'javascript:alert(1)' } }, d).node!.a, undefined)
  assert.deepEqual(calls.urls, ['http://p/i.png'])
})

test('inset: canvas·iframe·object·shadow host', () => {
  const { d } = deps()
  for (const [n, ik] of [['canvas', 'canvas'], ['iframe', 'iframe'], ['object', 'embed'], ['video', 'video']] as const) {
    const v = convert({ i: 11, p: 0, t: 'e', n, o: 1, r: [0, 0, 300, 150], cs: cs() }, d).node!
    assert.equal(v.k, 'inset'); assert.equal(v.ik, ik)
  }
  assert.equal(convert({ i: 12, p: 0, t: 'e', n: 'div', o: 1, r: [0, 0, 50, 50], cs: cs(), sh: 1 }, d).node!.ik, 'other')
})

test('svg: 기하·칠하기 숫자만', () => {
  const { d } = deps()
  const v = convert({
    i: 13, p: 0, t: 'e', n: 'svg', o: 1, r: [0, 0, 100, 100], cs: cs(), a: { vb: '0 0 100 100' },
    g: [{ n: 'path', a: { d: 'M 0 0 L 10 10', transform: 'url(#x)' }, p: ['none', 'rgb(44, 106, 160)', '2px', 'none', 'round', 'miter', '1', '1', '14px', '400', 'Arial', 'start'] }],
  }, d).node!
  assert.equal(v.k, 'svg'); assert.deepEqual(v.vb, [0, 0, 100, 100])
  const g = v.g![0] as { k: string; st: Record<string, unknown> }
  assert.equal(g.k, 'path'); assert.equal(g.st.s, 'rgb(44, 106, 160)'); assert.equal(g.st.tr, undefined); assert.equal(g.st.lc, 'round')
})

test('아이콘 폰트 의사 요소(사용자 영역 글리프) → 래스터 img', () => {
  const { d, calls } = deps()
  const v = convert({ i: 14, p: 0, t: 'e', n: 'i', o: 1, r: [0, 0, 13, 13], cs: cs(), pb: ['', 'FontAwesome', '13px', '400', 'rgb(42, 157, 58)'] }, d).node!
  assert.equal(v.k, 'img'); assert.equal(v.a, undefined)
  assert.equal(calls.rasters.length, 1)
})

test('보통 의사 요소 글자 → 합성 텍스트 자식', () => {
  const { d } = deps()
  const c = convert({ i: 15, p: 0, t: 'e', n: 'li', o: 1, r: [0, 0, 100, 20], cs: cs(), pb: ['» ', '"Evil"', '14px', '400', 'rgb(0, 0, 0)'] }, d)
  assert.equal(c.extra.length, 1)
  assert.equal(c.extra[0].id, synthId(15, 'b')); assert.equal(c.extra[0].p, 15); assert.equal(c.extra[0].runs![0].t, '» ')
  assert.doesNotMatch(JSON.stringify(c.extra), /Evil/)
})

test('아이콘 글자 텍스트 노드는 보내지 않고 부모를 래스터로 표시', () => {
  const parent: RawRec = { i: 20, p: 0, t: 'e', n: 'span', o: 1, r: [0, 0, 16, 16], cs: cs() }
  const { d, calls } = deps({ 20: parent }, { font: { icon: true } })
  const c = convert({ i: 21, p: 20, t: 'x', o: 1, r: [0, 0, 16, 16], tx: [[0, 0, 16, 16, '']], ps: 20 }, d)
  assert.equal(c.node, undefined)
  assert.deepEqual(calls.hosts, [20])
})

test('fixed·z-index·지역 변환', () => {
  const { d } = deps()
  const v = convert({ i: 30, p: 0, t: 'e', n: 'div', o: 1e6 + 3, r: [5, 6, 10, 10], cs: cs({ position: 'fixed', 'z-index': '1050' }), fr: 1, m: [0.7071, 0.7071, -0.7071, 0.7071] }, d).node!
  assert.equal(v.fx, true); assert.equal(v.zi, 1050); assert.deepEqual(v.m, [0.7071, 0.7071, -0.7071, 0.7071]); assert.equal(v.o, 1e6 + 3)
})
