/**
 * 게시판 커맨드 바 44("파일과 같은 h-11 bg-card") — Vue 판 components/board/BoardCommandBar.vue 이식.
 *  왼쪽(children: 이름+설명 / 경로 / "새 글 · 게시판" + 임시 저장), 오른쪽(actions: 검색 200 + 글쓰기 / 편집 ⋯ / 취소 올리기).
 *  searchPlaceholder 를 주면 검색 입력(시안 200×32, Enter 로 결과 화면)을 그린다.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { UiIcon } from '~/components/ui/Icon'

export interface BoardCommandBarProps {
  /** 검색 입력 자리표시 — "이 게시판에서 검색" / "모든 게시판에서 검색" */
  searchPlaceholder?: string
  searchValue?: string
  /** Enter — 다듬은 검색어 */
  onSearch?: (q: string) => void
  /** 왼쪽 내용(Vue 기본 슬롯) */
  children?: ReactNode
  /** 오른쪽 끝(Vue #actions) */
  actions?: ReactNode
}

/** 게시판 커맨드 바(데스크톱 전용, md↑) */
export function BoardCommandBar({ searchPlaceholder, searchValue, onSearch, children, actions }: BoardCommandBarProps) {
  const [q, setQ] = useState(searchValue ?? '')
  // watch(() => props.searchValue)
  useEffect(() => { setQ(searchValue ?? '') }, [searchValue])

  return (
    <div className="hidden h-11 shrink-0 items-center gap-2 border-b border-border bg-card pl-4 pr-2.5 text-[13px] md:flex">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {children}
      </div>
      {searchPlaceholder && (
        <form role="search" className="relative w-[200px] shrink-0" onSubmit={(e) => { e.preventDefault(); onSearch?.(q.trim()) }}>
          <UiIcon name="search" className="pointer-events-none absolute left-2 top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            type="search"
            autoComplete="off"
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs text-foreground outline-hidden placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35"
          />
        </form>
      )}
      {actions}
    </div>
  )
}

export default BoardCommandBar
