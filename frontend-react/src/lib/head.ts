/**
 * 문서 머리 — `useHead({ title })`(최소: 제목·link).
 *
 * 사용: useHead({ title: `${t('nav.chat')} | ${appName}` })
 *
 * 제목은 가장 늦게 렌더된(가장 안쪽·가장 최근) 호출이 이긴다. 그 화면이 내려가면 바깥 호출의 제목으로
 * 돌아간다(unhead 와 같은 쌓임 규칙). 제목을 정하지 않은 화면은 App 이 런타임 브랜딩 이름을 쓴다.
 *
 * 순서는 effect 실행 순서가 아니라 **첫 렌더 순서(id)** 로 정한다. React 는 자식 effect 를 부모보다 먼저
 * 돌리므로, effect 순서로 쌓으면 첫 마운트(직접 진입·새로고침) 때 App 의 앱 이름이 페이지 제목을 덮는다.
 * 렌더는 부모 → 자식 순이고 나중에 마운트된 화면은 더 큰 id 를 받으므로 id 가 곧 쌓임 순서다.
 * link 도 같은 순서로 <head> 안에 줄 세운다(같은 rel 이면 뒤의 것이 이김 — 예: 배지 파비콘).
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

/** useHead 가 넣은 link 들을 id(렌더 순서) 순으로 <head> 끝에 다시 줄 세운다 */
function orderLinks() {
  if (typeof document === 'undefined') return
  const els = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[data-head-id]'))
  const sorted = [...els].sort((a, b) => Number(a.dataset.headId) - Number(b.dataset.headId))
  if (sorted.every((el, i) => el === els[i])) return
  for (const el of sorted) document.head.appendChild(el)
}

/** 테스트용 — 쌓임 초기화 */
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
