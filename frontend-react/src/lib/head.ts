/**
 * 문서 head — `useHead({ title })`(최소: 제목·link).
 *
 * 사용: useHead({ title: `${t('nav.chat')} | ${appName}` })
 *
 * 제목은 가장 늦게 렌더된(가장 안쪽·가장 최근) 호출이 우선한다. 해당 화면이 언마운트되면 바깥 호출의 제목으로
 * 복원된다(unhead 와 동일한 스택 규칙). 제목을 지정하지 않은 화면에는 App 이 런타임 브랜딩 이름을 적용한다.
 *
 * 순서는 effect 실행 순서가 아니라 **첫 렌더 순서(id)** 로 결정한다. React 는 자식 effect 를 부모보다 먼저
 * 실행하므로, effect 순서로 스택을 구성하면 첫 마운트(직접 진입·새로고침) 시 App 의 앱 이름이 페이지 제목을 덮어쓴다.
 * 렌더는 부모 → 자식 순이고 나중에 마운트된 화면이 더 큰 id 를 받으므로 id 가 곧 스택 순서이다.
 * link 도 동일한 순서로 <head> 내에 정렬한다(동일 rel 이면 뒤의 항목이 우선 — 예: 배지 파비콘).
 */
import { useEffect, useRef } from 'react'

interface Entry { id: number; title?: string }
const stack: Entry[] = []
let seq = 0

function apply() {
  let top: Entry | undefined
  for (const e of stack) {
    if (e.title != null && (!top || e.id > top.id)) top = e
  }
  if (top && typeof document !== 'undefined') document.title = top.title!
}

/** useHead 가 삽입한 link 들을 id(렌더 순서) 순으로 <head> 끝에 재정렬한다 */
function orderLinks() {
  if (typeof document === 'undefined') return
  const els = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[data-head-id]'))
  const sorted = [...els].sort((a, b) => Number(a.dataset.headId) - Number(b.dataset.headId))
  if (sorted.every((el, i) => el === els[i])) return
  for (const el of sorted) document.head.appendChild(el)
}

/** 테스트용 — 스택 초기화 */
export function _resetHead() {
  stack.length = 0
}

export interface HeadLink { rel: string; href: string; type?: string; key?: string }

export interface HeadInput {
  title?: string | null
  link?: HeadLink[]
}

export function useHead(input: HeadInput) {
  const idRef = useRef<number>(0)
  if (!idRef.current) idRef.current = ++seq
  const title = input.title ?? undefined

  useEffect(() => {
    const id = idRef.current
    stack.push({ id, title })
    apply()
    return () => {
      const i = stack.findIndex(e => e.id === id)
      if (i >= 0) stack.splice(i, 1)
      apply()
    }
    // 등록·해제는 마운트 단위. 제목 변경은 아래 effect 가 갱신한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const e = stack.find(x => x.id === idRef.current)
    if (e) { e.title = title; apply() }
  }, [title])

  const linkKey = JSON.stringify(input.link ?? [])
  useEffect(() => {
    const links = input.link ?? []
    const els: HTMLLinkElement[] = []
    for (const l of links) {
      const el = document.createElement('link')
      el.rel = l.rel
      el.href = l.href
      if (l.type) el.type = l.type
      if (l.key) el.setAttribute('data-head-key', l.key)
      el.dataset.headId = String(idRef.current)
      document.head.appendChild(el)
      els.push(el)
    }
    if (els.length) orderLinks()
    return () => { for (const el of els) el.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey])
}
