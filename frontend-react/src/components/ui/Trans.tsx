/**
 * 문구 내 버튼·링크·강조 — 번역 문자열 일부를 React 노드로 렌더링한다. 기존 i18n(vue-i18n 문법 어댑터)과 동일한 t 를 거친다.
 * (상세 설명·예시는 아래 컴포넌트 JSDoc 참조)
 */
import { Fragment, createElement, type ElementType, type ReactNode } from 'react'
import { useI18n, type TArg } from '~/i18n'

/** 슬롯 — 노드(자리 표시자) 또는 (안쪽 글자) => 노드(감싸는 태그) */
export type UiTransSlot = ReactNode | ((children: ReactNode) => ReactNode)

export interface UiTransProps {
  /** 번역 키(필수) */
  k: string
  /** 슬롯 이름 → 노드 또는 함수. 문자열의 `{이름}…{/이름}` 또는 `{이름}` 위치에 렌더링 */
  slots?: Record<string, UiTransSlot>
  /** 일반 보간 값(`{name}` → 글자) */
  values?: Record<string, unknown>
  /** 복수형 선택 수(vue-i18n `t(key, count)`) */
  count?: number
  /** 감쌀 태그(예: 'span' · 'p'). 미지정 시 Fragment */
  as?: ElementType
  /** 감싼 요소의 class(as 미지정 시 span 으로 감쌈) */
  className?: string
}

const MARK = '\u0001'

/**
 * 번역 결과 문자열(표식 포함)을 슬롯 노드 배열로 변환하는 순수 함수 — UiTrans 내부에서 사용하며, 테스트·비컴포넌트 문맥에서도 사용한다.
 * @param translate (named) => 표식이 포함된 번역 결과
 */
export function transNodes(translate: (named: Record<string, string>) => string, slots: Record<string, UiTransSlot>): ReactNode[] {
  const named: Record<string, string> = {}
  for (const name of Object.keys(slots)) {
    named[name] = `${MARK}${name}${MARK}`
    named[`/${name}`] = `${MARK}/${name}${MARK}`
  }
  const parts = translate(named).split(MARK)

  type Frame = { name: string | null; children: ReactNode[] }
  const stack: Frame[] = [{ name: null, children: [] }]
  let key = 0
  const top = () => stack[stack.length - 1]
  const textOf = (nodes: ReactNode[]): ReactNode =>
    nodes.every(n => typeof n === 'string') ? (nodes as string[]).join('') : createElement(Fragment, null, ...nodes)
  const render = (name: string, inner: ReactNode): ReactNode => {
    const s = slots[name]
    const node = typeof s === 'function' ? (s as (c: ReactNode) => ReactNode)(inner) : s
    return createElement(Fragment, { key: `s${key++}` }, node)
  }
  /** 닫히지 않은 틀 = 자리 표시자: 슬롯을 해당 위치에 두고 후속 내용은 그대로 유지 */
  const flattenOpen = (f: Frame) => {
    top().children.push(render(f.name!, ''))
    top().children.push(...f.children)
  }

  parts.forEach((p, i) => {
    if (i % 2 === 0) { if (p) top().children.push(p); return }
    if (p.startsWith('/')) {
      const name = p.slice(1)
      const at = stack.map(f => f.name).lastIndexOf(name)
      if (at <= 0) return // 짝 없는 닫는 태그는 폐기
      while (stack.length - 1 > at) flattenOpen(stack.pop()!)
      const f = stack.pop()!
      top().children.push(render(name, textOf(f.children)))
      return
    }
    stack.push({ name: p, children: [] })
  })
  while (stack.length > 1) flattenOpen(stack.pop()!)
  return stack[0].children.map(n => (typeof n === 'string' ? createElement(Fragment, { key: `t${key++}` }, n) : n))
}

/**
 * 문구 내 버튼·링크·강조 — 번역 문자열 일부를 React 노드로 렌더링한다. 기존 i18n(vue-i18n 문법 어댑터)과 동일한 t 를 거친다.
 *
 * 번역 문자열의 두 형식을 지원한다:
 *  - 감싸는 태그 `{open}미리보기로 열기{/open}` → slots.open(안쪽 글자) 를 렌더링한다(함수 슬롯).
 *  - 자리 표시자 `{link}` · `{n}` (닫는 태그 없음) → slots.link 노드를 해당 위치에 렌더링한다.
 *    함수 슬롯이면 빈 문자열로 호출된다.
 * 보간 `values`·복수 `count` 는 t(k, count, values) 그대로(vue-i18n 규칙). 슬롯 이름과 중복되는 values 는 슬롯이 우선한다.
 * 존재하지 않는 키는 키 문자열이 그대로 출력된다(t 와 동일).
 *
 * 감싸는 요소: `as` 를 지정하면 해당 태그(className 은 해당 태그에 적용), 미지정 시 Fragment(className 만 지정하면 span).
 *
 * @example <UiTrans k="office.slow" slots={{ open: (t) => <UiButton variant="link" size="xs" onClick={openPreview}>{t}</UiButton> }} />
 * @example <UiTrans k="chat.message.repliesN" as="span" slots={{ n: <span className="font-mono">3</span> }} />
 * @example <UiTrans k="files.shared" values={{ name: '민지' }} count={3} slots={{ b: (t) => <b>{t}</b> }} />
 */
export function UiTrans({ k, slots = {}, values, count, as, className }: UiTransProps) {
  const { t } = useI18n()
  const nodes = transNodes((named) => {
    const all = { ...(values ?? {}), ...named }
    return count === undefined ? t(k, all as TArg) : t(k, count, all as TArg)
  }, slots)
  const tag = as ?? (className ? 'span' : null)
  return tag ? createElement(tag, { className }, ...nodes) : createElement(Fragment, null, ...nodes)
}

export default UiTrans
