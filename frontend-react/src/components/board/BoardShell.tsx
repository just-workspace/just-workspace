/**
 * 게시판 화면 공통 틀(시안 BD1~BD4): 왼쪽 패널 236 + 본문 열 — Vue 판 components/board/BoardShell.vue 이식.
 * 예전엔 네 페이지가 사이드바·햄버거 드로어를 각자 반복했다(06-3 지금 상태). 모바일(BM1~BM3)은 사이드바 없이
 * 상단 바 ‹ 로 "게시판 목록"(인덱스)으로 돌아간다 — 드로어는 없앴다.
 */
import type { ReactNode } from 'react'
import { BoardSidebar } from './BoardSidebar'

export interface BoardShellProps {
  children?: ReactNode
}

/** 게시판 페이지 틀(사이드바 + 본문 열) */
export function BoardShell({ children }: BoardShellProps) {
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      <BoardSidebar className="hidden md:flex" />
      <main className="flex min-w-0 flex-1 flex-col">
        {children}
      </main>
    </div>
  )
}

export default BoardShell
