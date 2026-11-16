/**
 * 파일 메시지 한 줄.
 * 첨부는 텍스트와 동일한 행(ChatMessage)이 렌더링한다 — 여러 첨부 그리드 · 영상 · 오디오 · 파일 카드 · 업로드 상태
 * (ChatAttachmentGrid). 본 컴포넌트는 기존 호출부(스레드 패널 등)를 위해 이름만 유지한 얇은 래퍼이다.
 */
import { memo } from 'react'
import type { ChatMessage as ChatMessageT } from '~/composables/useChat'
import { ChatMessage } from './ChatMessage'

export interface ChatFileMessageProps {
  message: ChatMessageT
  /** 앞 메시지와 같은 그룹(아바타·이름 생략) */
  grouped: boolean
  isOwn: boolean
  /** 그룹의 마지막 — 읽음 표시 */
  isLastInGroup?: boolean
  /** 스레드 패널 안 — 스레드 칩·"스레드로 답장" 없음 */
  inThread?: boolean
  onOpenThread?: (messageId: string) => void
}

export const ChatFileMessage = memo(function ChatFileMessage(props: ChatFileMessageProps) {
  return <ChatMessage {...props} />
})

export default ChatFileMessage
