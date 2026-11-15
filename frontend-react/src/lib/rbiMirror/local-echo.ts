// ★ 생성됨 — 손으로 고치지 말 것. 원본: rbi/mirror/client/src/local-echo.ts · 동기화: node rbi/mirror/scripts/sync-client.mjs
/**
 * 로컬 에코(typeahead) — 포커스된 입력칸에 친 글자를 원격 왕복을 기다리지 않고 바로 그린다(Menlo 의 lecho 와 같은 생각).
 *
 * 모델: 원격이 마지막으로 알려 준 상태(base = 값·선택) 위에, 아직 원격이 적용했다고 확인하지 않은 편집(pending)을 차례로 얹은 것이 화면이다.
 * 원격의 val{iseq, vh} 가 오면:
 *   1) iseq 까지의 편집을 이전 base 에 얹은 "예측값" 의 해시(fnv1a)를 원격 해시와 대조한다 — 맞으면 match, 틀리면 mismatch(원격이 값을 바꿨다: 마스크·자동완성·대문자화…).
 *   2) 어느 쪽이든 원격 상태를 새 base 로 삼고(원격이 진실), iseq 뒤의 편집만 다시 얹는다.
 * 모르는 키(Enter·위아래·Tab·Ctrl 조합·Shift 선택…)가 끼면 그 뒤 예측은 멈춘다(suspended) — 다음 val 이 오면 원격 상태로 돌아간다.
 * 비밀번호 칸은 값 대신 마스킹 문자열(•)로 같은 계산을 한다(원격도 길이만 알려 준다).
 * 조합(IME): 조합 중 글자는 caret 자리에 "임시 구간" 으로 끼워 넣는다(원격 값도 조합 글자를 포함한다). 확정되면 일반 삽입.
 */
import { fnv1a } from './vocab'

export type EchoOp =
  | { k: 'ins'; t: string }
  | { k: 'bs' }
  | { k: 'del' }
  | { k: 'mv'; to: 'left' | 'right' | 'home' | 'end' }
  | { k: 'comp'; t: string }
  | { k: 'compend'; t: string }
  | { k: 'unknown' }

export interface EchoState { v: string; ss: number; se: number; comp: string; compAt: number }

export interface EchoView { before: string; comp: string; selected: string; after: string; caret: boolean; value: string }

const MASK = '•'

export function applyOp(s: EchoState, op: EchoOp, mask: boolean, multiline: boolean): EchoState | null {
  const v = s.v
  let ss = Math.min(s.ss, v.length), se = Math.min(Math.max(s.se, ss), v.length)
  switch (op.k) {
    case 'ins': {
      let t = mask ? MASK.repeat([...op.t].length) : op.t
      if (!multiline) t = t.replace(/[\r\n]+/g, ' ')
      // 조합 중이었다면 조합 구간을 지우고 넣는다
      const base = s.comp ? v.slice(0, s.compAt) + v.slice(s.compAt + s.comp.length) : v
      if (s.comp) { ss = se = s.compAt }
      const nv = base.slice(0, ss) + t + base.slice(se)
      const c = ss + t.length
      return { v: nv, ss: c, se: c, comp: '', compAt: 0 }
    }
    case 'bs': {
      if (s.comp) return null
      if (se > ss) return { v: v.slice(0, ss) + v.slice(se), ss, se: ss, comp: '', compAt: 0 }
      if (ss === 0) return { ...s, ss, se }
      // 서로게이트 쌍 한 글자
      const back = ss >= 2 && /[\uDC00-\uDFFF]/.test(v[ss - 1]) && /[\uD800-\uDBFF]/.test(v[ss - 2]) ? 2 : 1
      return { v: v.slice(0, ss - back) + v.slice(ss), ss: ss - back, se: ss - back, comp: '', compAt: 0 }
    }
    case 'del': {
      if (s.comp) return null
      if (se > ss) return { v: v.slice(0, ss) + v.slice(se), ss, se: ss, comp: '', compAt: 0 }
      if (ss >= v.length) return { ...s, ss, se }
      const fwd = /[\uD800-\uDBFF]/.test(v[ss]) && ss + 1 < v.length ? 2 : 1
      return { v: v.slice(0, ss) + v.slice(ss + fwd), ss, se: ss, comp: '', compAt: 0 }
    }
    case 'mv': {
      if (s.comp) return null
      let c = ss
      if (op.to === 'left') c = se > ss ? ss : Math.max(0, ss - 1)
      else if (op.to === 'right') c = se > ss ? se : Math.min(v.length, se + 1)
      else if (op.to === 'home') { if (multiline) return null; c = 0 }
      else if (op.to === 'end') { if (multiline) return null; c = v.length }
      return { v, ss: c, se: c, comp: '', compAt: 0 }
    }
    case 'comp': {
      const t = mask ? MASK.repeat([...op.t].length) : op.t
      // 앞 조합 구간을 바꿔 끼운다
      const at = s.comp ? s.compAt : ss
      const base = s.comp ? v.slice(0, s.compAt) + v.slice(s.compAt + s.comp.length) : v.slice(0, ss) + v.slice(se)
      const nv = base.slice(0, at) + t + base.slice(at)
      return { v: nv, ss: at + t.length, se: at + t.length, comp: t, compAt: at }
    }
    case 'compend': return applyOp(s, { k: 'ins', t: op.t }, mask, multiline)
    case 'unknown': return null
  }
}

export class LocalEcho {
  /** 화면에 보이는 위젯 id(0 = 없음) */
  id = 0
  private base: EchoState = { v: '', ss: 0, se: 0, comp: '', compAt: 0 }
  private pending: { seq: number; op: EchoOp }[] = []
  private suspendedAt = 0
  stats = { match: 0, mismatch: 0, ops: 0, suspended: 0 }

  constructor(public mask = false, public multiline = false) {}

  /** 위젯에 포커스 — 원격 표시값으로 시작(caret 은 끝, 다음 val 이 바로잡는다) */
  start(id: number, value: string, mask: boolean, multiline: boolean): void {
    if (this.id === id) return
    this.id = id
    this.mask = mask
    this.multiline = multiline
    this.base = { v: value, ss: value.length, se: value.length, comp: '', compAt: 0 }
    this.pending = []
    this.suspendedAt = 0
  }
  stop(): void { this.id = 0; this.pending = []; this.suspendedAt = 0 }

  /** 편집 하나(이미 원격으로 보냈고 seq 를 받았다) */
  push(seq: number, op: EchoOp): void {
    if (!this.id) return
    this.stats.ops++
    if (op.k === 'unknown') { if (!this.suspendedAt) { this.suspendedAt = seq; this.stats.suspended++ } }
    this.pending.push({ seq, op })
    if (this.pending.length > 500) this.pending.shift()
  }

  /** 원격 확인 — 해시 대조 후 원격 상태로 다시 기준을 잡는다. 맞았으면 true */
  reconcile(id: number, iseq: number, vh: number, n: number, ss: number, se: number, v: string | undefined): boolean | null {
    if (id !== this.id) return null
    let pred: EchoState | null = this.base
    let predictable = true
    const keep: { seq: number; op: EchoOp }[] = []
    for (const p of this.pending) {
      if (p.seq <= iseq) {
        if (pred) { const nx = applyOp(pred, p.op, this.mask, this.multiline); if (!nx) predictable = false; pred = nx }
      } else keep.push(p)
    }
    const remoteV = v !== undefined ? v : MASK.repeat(n)
    let ok: boolean | null = null
    if (predictable && pred) {
      ok = fnv1a(pred.v) === vh
      if (ok) this.stats.match++; else this.stats.mismatch++
    }
    // 원격이 진실 — 조합 중이면 원격 값에 조합 구간이 들어 있다(그 위치는 caret 앞으로 본다)
    const comp = pred && pred.comp && ok ? pred.comp : ''
    this.base = { v: remoteV, ss: Math.min(ss, remoteV.length), se: Math.min(se, remoteV.length), comp, compAt: comp ? Math.max(0, Math.min(ss, remoteV.length) - comp.length) : 0 }
    this.pending = keep
    if (this.suspendedAt && this.suspendedAt <= iseq) this.suspendedAt = 0
    return ok
  }

  /** 지금 그릴 것 — 예측할 수 없으면 원격 기준값 그대로 */
  view(): EchoView {
    let s: EchoState | null = this.base
    for (const p of this.pending) {
      if (this.suspendedAt && p.seq >= this.suspendedAt) break
      const nx = applyOp(s!, p.op, this.mask, this.multiline)
      if (!nx) break
      s = nx
    }
    const st = s!
    const a = Math.min(st.ss, st.se), b = Math.max(st.ss, st.se)
    if (st.comp) {
      return { before: st.v.slice(0, st.compAt), comp: st.comp, selected: '', after: st.v.slice(st.compAt + st.comp.length), caret: true, value: st.v }
    }
    return { before: st.v.slice(0, a), comp: '', selected: st.v.slice(a, b), after: st.v.slice(b), caret: a === b, value: st.v }
  }

  get busy(): boolean { return this.pending.length > 0 }
}

/** 키 → 로컬 에코 편집(모르면 unknown) */
export function keyToOp(key: string, mods: number, multiline: boolean): EchoOp | undefined {
  const ctrl = (mods & 2) !== 0 || (mods & 4) !== 0, shift = (mods & 8) !== 0, alt = (mods & 1) !== 0
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'CapsLock' || key === 'HangulMode' || key === 'HanjaMode' || key === 'Process') return undefined
  if (ctrl || alt) return { k: 'unknown' }
  switch (key) {
    case 'Backspace': return shift ? { k: 'unknown' } : { k: 'bs' }
    case 'Delete': return shift ? { k: 'unknown' } : { k: 'del' }
    case 'ArrowLeft': return shift ? { k: 'unknown' } : { k: 'mv', to: 'left' }
    case 'ArrowRight': return shift ? { k: 'unknown' } : { k: 'mv', to: 'right' }
    case 'Home': return shift ? { k: 'unknown' } : { k: 'mv', to: 'home' }
    case 'End': return shift ? { k: 'unknown' } : { k: 'mv', to: 'end' }
    case 'Enter': return multiline ? { k: 'ins', t: '\n' } : { k: 'unknown' }
    default: return { k: 'unknown' }
  }
}
