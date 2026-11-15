// 로컬 에코 — 예측 편집·해시 대조·원격 기준 재설정
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalEcho, applyOp, keyToOp } from '../client/src/local-echo.ts'
import { fnv1a } from '../protocol/vocab.ts'

test('타이핑은 바로 보이고, 원격 확인이 맞으면 match', () => {
  const e = new LocalEcho()
  e.start(7, 'ab', false, false)
  e.push(1, { k: 'ins', t: 'c' })
  e.push(2, { k: 'ins', t: 'd' })
  assert.equal(e.view().value, 'abcd')
  assert.equal(e.reconcile(7, 1, fnv1a('abc'), 3, 3, 3, 'abc'), true)
  assert.equal(e.view().value, 'abcd') // seq 2 는 아직 예측
  assert.equal(e.reconcile(7, 2, fnv1a('abcd'), 4, 4, 4, 'abcd'), true)
  assert.equal(e.stats.match, 2)
  assert.equal(e.busy, false)
})

test('원격이 값을 바꾸면(대문자화) mismatch, 원격 값 위에 남은 편집만 다시', () => {
  const e = new LocalEcho()
  e.start(1, '', false, false)
  e.push(1, { k: 'ins', t: 'a' })
  e.push(2, { k: 'ins', t: 'b' })
  assert.equal(e.reconcile(1, 1, fnv1a('A'), 1, 1, 1, 'A'), false)
  assert.equal(e.view().value, 'Ab')
  assert.equal(e.stats.mismatch, 1)
})

test('⌫·화살표·Delete', () => {
  let s = { v: 'hello', ss: 5, se: 5, comp: '', compAt: 0 }
  s = applyOp(s, { k: 'bs' }, false, false)!
  s = applyOp(s, { k: 'mv', to: 'left' }, false, false)!
  s = applyOp(s, { k: 'ins', t: 'X' }, false, false)!
  assert.equal(s.v, 'helXl')
  s = applyOp(s, { k: 'del' }, false, false)!
  assert.equal(s.v, 'helX')
  s = applyOp(s, { k: 'mv', to: 'home' }, false, false)!
  assert.equal(s.ss, 0)
})

test('한글 조합: 조합 구간을 바꿔 끼우고 확정은 삽입 — 원격 값(조합 포함)과 해시가 맞는다', () => {
  const e = new LocalEcho()
  e.start(3, '', false, false)
  e.push(1, { k: 'comp', t: 'ㅎ' }); e.push(2, { k: 'comp', t: '하' }); e.push(3, { k: 'comp', t: '한' })
  const v = e.view()
  assert.equal(v.value, '한'); assert.equal(v.comp, '한')
  assert.equal(e.reconcile(3, 3, fnv1a('한'), 1, 1, 1, '한'), true)
  e.push(4, { k: 'compend', t: '한' })
  e.push(5, { k: 'comp', t: 'ㄱ' })
  assert.equal(e.view().value, '한ㄱ')
  e.push(6, { k: 'comp', t: '그' }); e.push(7, { k: 'comp', t: '글' })
  e.push(8, { k: 'comp', t: '그' }) // 조합 중 ⌫(IME 가 처리, 결과만)
  e.push(9, { k: 'compend', t: '그' })
  assert.equal(e.view().value, '한그')
  assert.equal(e.reconcile(3, 9, fnv1a('한그'), 2, 2, 2, '한그'), true)
})

test('비밀번호 칸은 마스킹 문자로 같은 계산(원격은 길이만)', () => {
  const e = new LocalEcho()
  e.start(9, '', true, false)
  e.push(1, { k: 'ins', t: 'p' }); e.push(2, { k: 'ins', t: 'w' })
  assert.equal(e.view().value, '••')
  assert.equal(e.reconcile(9, 2, fnv1a('••'), 2, 2, 2, undefined), true)
})

test('모르는 키(Enter·Ctrl 조합) 뒤로는 예측을 멈추고 다음 확인에서 풀린다', () => {
  const e = new LocalEcho()
  e.start(2, 'x', false, false)
  e.push(1, { k: 'ins', t: 'y' })
  e.push(2, keyToOp('Enter', 0, false)!)
  e.push(3, { k: 'ins', t: 'z' })
  assert.equal(e.view().value, 'xy')
  e.reconcile(2, 3, fnv1a('xyz'), 3, 3, 3, 'xyz')
  assert.equal(e.view().value, 'xyz')
  assert.equal(keyToOp('a', 2, false)?.k, 'unknown')
  assert.equal(keyToOp('Enter', 0, true)?.k, 'ins')
  assert.equal(keyToOp('Shift', 8, false), undefined)
})

test('다른 위젯의 확인은 무시', () => {
  const e = new LocalEcho()
  e.start(1, 'a', false, false)
  assert.equal(e.reconcile(2, 1, 0, 0, 0, 0, ''), null)
})
