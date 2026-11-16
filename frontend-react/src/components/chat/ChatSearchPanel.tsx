/**
 * 메시지 검색 패널 영역(chatStore.showSearchPanel · chat.tsx 의 panel === 'search').
 * 내용은 ChatSearchResults(모바일 전체 화면) — 검색란은 헤더(ChatSearchBox).
 * 이전 이름으로 호출해도 동일 화면이 표시되도록 감싼 래퍼.
 */
import { ChatSearchResults } from './ChatSearchResults'

/** 메시지 검색 패널 = 검색 결과 화면 */
export function ChatSearchPanel() {
  return <ChatSearchResults />
}

export default ChatSearchPanel
