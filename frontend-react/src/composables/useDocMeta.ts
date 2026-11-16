/**
 * 문서 메타(현재 호출처 없음).
 * React: const { meta, bind, patch } = useDocMeta()  — meta 는 렌더 시점 값(변경 시 재렌더).
 *
 * 문서의 페이지 설정 — 용지·여백·단·테마·워터마크.
 *
 * 해당 값은 문서에 속하므로 Yjs 문서 내 `meta` 맵에 저장한다. 이에 따라 공동 열람자에게도
 * 동일한 용지 설정으로 표시되며, 저장·버전 기록에도 본문과 함께 포함된다.
 *
 * 반면 확대율·보기 모드·마지막 선택 색상 등은 **열람자별 설정**이므로 동기화 대상이 아니다.
 * 타 사용자가 웹 보기로 전환해도 본인 화면은 변경되지 않아야 한다. LOCAL_KEYS 가 그 경계이다.
 */
import { useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { themeById } from '~/utils/docExtensions'

export interface PageMeta {
  /** 문서 서식 테마 id */
  theme: string
  bodyFont: string
  bodySize: string
  lineHeight: string
  headingColor: string

  size: string                       // A4 / Letter / ...
  orient: 'portrait' | 'landscape'
  margin: string                     // normal / narrow / moderate / wide
  cols: number
  pageColor: string
  watermark: string
  pageBorder: boolean
  /** 머리글·바닥글. 페이지가 단일 연속 구조이므로 용지 상단·하단에 1회씩 렌더링한다. */
  header: string
  footer: string

  // ── 이하 열람자별 설정(동기화 제외) ──
  view: 'print' | 'web'
  lastColor: string
  lastHighlight: string
  /** 브라우저 맞춤법 검사(빨간 물결). 사용자별 언어 설정이 상이하므로 문서에 귀속하지 않는다. */
  spellcheck: boolean
}

const LOCAL_KEYS = new Set(['view', 'lastColor', 'lastHighlight', 'spellcheck'])

function defaults(): PageMeta {
  const t = themeById('basic')
  return {
    theme: t.id,
    bodyFont: t.bodyFont,
    bodySize: t.bodySize,
    lineHeight: t.lineHeight,
    headingColor: t.headingColor,
    size: 'A4',
    orient: 'portrait',
    margin: 'normal',
    cols: 1,
    pageColor: '',
    watermark: '',
    pageBorder: false,
    header: '',
    footer: '',
    view: 'print',
    lastColor: '#ef4444',
    lastHighlight: '#fef08a',
    spellcheck: false,
  }
}

export function useDocMeta() {
  const [meta, setMeta] = useState<PageMeta>(defaults)
  const metaRef = useRef<PageMeta>(meta)
  const ymeta = useRef<Y.Map<any> | null>(null)

  const fns = useMemo(() => {
    const assign = (k: string, v: unknown) => {
      metaRef.current = { ...metaRef.current, [k]: v } as PageMeta
      setMeta(metaRef.current)
    }

    /** Y.Doc 준비 완료 후 1회 호출한다. */
    function bind(doc: Y.Doc) {
      const ym = doc.getMap('meta')
      ymeta.current = ym
      const sync = () => {
        const stored = ym.toJSON()
        for (const [k, v] of Object.entries(stored)) {
          if (LOCAL_KEYS.has(k)) continue
          assign(k, v)
        }
      }
      sync()
      ym.observe(sync)
    }

    /**
     * 테마 선택 시 글꼴·크기·줄간격이 일괄 적용된다. Word 의 "문서 서식" 갤러리와 동일하다.
     * 개별 항목 변경 시 해당 항목만 덮어쓴다.
     */
    function patch(p: Partial<PageMeta>) {
      let next: Record<string, any> = { ...p }
      if (p.theme) {
        const t = themeById(p.theme)
        next = {
          ...next,
          bodyFont: t.bodyFont,
          bodySize: t.bodySize,
          lineHeight: t.lineHeight,
          headingColor: t.headingColor,
        }
      }
      for (const [k, v] of Object.entries(next)) {
        if (LOCAL_KEYS.has(k) || !ymeta.current) {
          assign(k, v)
        } else {
          ymeta.current.set(k, v)      // observe 가 meta 에 반영
        }
      }
    }

    return { bind, patch }
  }, [])

  return { meta, ...fns }
}
