/**
 * 문서 메타(현재 호출처 없음).
 * React: const { meta, bind, patch } = useDocMeta()  — meta 는 렌더 시점 값(바뀌면 다시 그린다).
 *
 * 문서의 페이지 설정 — 용지·여백·단·테마·워터마크.
 *
 * 이 값들은 문서에 속하므로 Yjs 문서 안의 `meta` 맵에 넣는다. 그래야 같이 보는 사람에게도
 * 같은 종이 위에 보이고, 저장·버전 기록에도 본문과 함께 실려 간다.
 *
 * 반대로 확대율·보기 모드·마지막에 고른 색 같은 건 **보는 사람 것**이라 동기화하면 안 된다.
 * 남이 웹 모양으로 바꿨다고 내 화면까지 바뀌면 곤란하다. LOCAL_KEYS 가 그 경계다.
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
  /** 머리글·바닥글. 페이지가 하나로 이어져 있으므로 종이 위아래에 한 번씩 그린다. */
  header: string
  footer: string

  // ── 아래는 보는 사람 것(동기화하지 않음) ──
  view: 'print' | 'web'
  lastColor: string
  lastHighlight: string
  /** 브라우저 맞춤법 검사(빨간 물결). 사람마다 언어 설정이 달라 문서에 묶지 않는다. */
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

    /** Y.Doc 이 준비된 뒤 한 번 부른다. */
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
     * 테마를 고르면 글꼴·크기·줄간격이 한 벌로 따라온다. Word 의 "문서 서식" 갤러리와 같다.
     * 개별 항목을 따로 바꾸면 그 항목만 덮어쓴다.
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
          ymeta.current.set(k, v)      // observe 가 meta 에 반영한다
        }
      }
    }

    return { bind, patch }
  }, [])

  return { meta, ...fns }
}
