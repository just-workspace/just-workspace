// 계산된 background-image → 배경 레이어(어휘). url() 원문은 자산 sha 로만, 그라디언트는 숫자로 변환.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBackground, parseGradient, splitTop } from '../agent/src/background.ts'

const SHA = 'f'.repeat(64)
const sha = (u: string) => (u.startsWith('http://p/ok') ? SHA : undefined)

test('splitTop: 괄호 안 쉼표는 자르지 않는다', () => {
  assert.deepEqual(splitTop('linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6)), url("a,b")'), ['linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))', 'url("a,b")'])
})

test('Chromium 계산값 그라디언트(격자 배경)', () => {
  const g = parseGradient('linear-gradient(rgb(238, 238, 238) 1px, rgba(0, 0, 0, 0) 1px)')
  assert.deepEqual(g, { k: 'lin', a: 180, st: [['rgb(238, 238, 238)', 1, 'px'], ['rgba(0, 0, 0, 0)', 1, 'px']] })
  assert.deepEqual(parseGradient('linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))'), { k: 'lin', a: 90, st: [['rgb(255, 0, 0)'], ['rgb(0, 0, 255)']] })
  assert.equal((parseGradient('linear-gradient(to right, rgb(1, 2, 3), rgb(4, 5, 6))') as { a: unknown }).a, 'r')
  assert.equal((parseGradient('linear-gradient(0.25turn, rgb(1, 2, 3), rgb(4, 5, 6))') as { a: unknown }).a, 90)
  const r = parseGradient('radial-gradient(circle at 30% 50%, rgb(255, 255, 0) 0%, rgb(0, 128, 0) 70%)')
  assert.deepEqual(r, { k: 'rad', sh: 'circle', sz: 'farthest-corner', at: [30, '%', 50, '%'], st: [['rgb(255, 255, 0)', 0, '%'], ['rgb(0, 128, 0)', 70, '%']] })
  assert.deepEqual((parseGradient('radial-gradient(150px 80px at 10px 20px, rgb(1, 2, 3), rgb(4, 5, 6))') as { sz: unknown }).sz, [150, 'px', 80, 'px'])
  assert.ok(parseGradient('repeating-linear-gradient(45deg, rgb(0, 0, 0) 0px, rgb(0, 0, 0) 5px, rgb(255, 255, 255) 5px, rgb(255, 255, 255) 10px)')?.rep)
  // 위치가 2개인 정지점은 2개로 분리
  assert.equal(parseGradient('linear-gradient(rgb(1, 2, 3) 10% 20%, rgb(4, 5, 6))')!.st.length, 3)
})

test('못 읽는 것은 버린다(conic·calc·새 색 공간·url 섞기)', () => {
  assert.equal(parseGradient('conic-gradient(rgb(255, 0, 0), rgb(0, 0, 255))'), undefined)
  assert.equal(parseGradient('linear-gradient(calc(10deg + 5deg), rgb(1, 2, 3), rgb(4, 5, 6))'), undefined)
  assert.equal(parseGradient('linear-gradient(oklch(0.5 0.1 20), rgb(4, 5, 6))'), undefined)
  assert.equal(parseGradient('linear-gradient(url(/exfil), rgb(4, 5, 6))'), undefined)
})

test('레이어: url() 은 준비된 자산 sha 만, 나머지 url 은 사라진다 — 원문은 어디에도 없다', () => {
  const r = parseBackground('linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255)), url("http://127.0.0.1:7100/exfil?grad-url"), url("http://p/ok.png")',
    '20px 20px, auto, cover', '0%, 0%, 50%', '0%, 0%, 50%', 'repeat, no-repeat, no-repeat', sha)
  assert.equal(r.layers.length, 2)
  assert.ok(r.layers[0].g)
  assert.equal(r.layers[1].i, SHA)
  assert.deepEqual(r.urls, ['http://127.0.0.1:7100/exfil?grad-url', 'http://p/ok.png'])
  assert.doesNotMatch(JSON.stringify(r.layers), /exfil|url\(|http/)
  assert.deepEqual(r.layers[0].sz, [20, 'px', 20, 'px'])
  assert.equal(r.layers[1].rp, 'no-repeat')
})

test('javascript:·상대 url 은 자산 요청도 하지 않는다', () => {
  const r = parseBackground('url("javascript:alert(1)"), url("about:blank")', '', '', '', '', () => SHA)
  assert.equal(r.layers.length, 0)
  assert.deepEqual(r.urls, [])
})

test('버린 그라디언트는 첫 색을 대신 색으로', () => {
  const r = parseBackground('conic-gradient(rgb(255, 0, 0), rgb(0, 0, 255))', '', '', '', '', sha)
  assert.equal(r.fallbackColor, 'rgb(255, 0, 0)')
})
