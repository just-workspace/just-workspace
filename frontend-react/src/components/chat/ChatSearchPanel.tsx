/**
 * 메시지 검색 패널 자리(chatStore.showSearchPanel · chat.tsx 의 panel === 'search').
 * 내용은 ChatSearchResults(모바일 전체 화면) — 검색칸은 헤더(ChatSearchBox).
 * 예전 이름으로 불러도 같은 화면이 나오게 감싼다. (옛 GET /messages/search 판은 Vue 원본 ChatSearchPanel.vue 에 남아 있다.)
 */
import { ChatSearchResults } from './ChatSearchResults'

/** 메시지 검색 패널 = 검색 결과 화면 */
export function ChatSearchPanel() {
  return <ChatSearchResults />
}

export default ChatSearchPanel
