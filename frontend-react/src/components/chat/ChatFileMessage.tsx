/**
 * 파일 메시지 한 줄. Vue 원본: frontend/components/chat/ChatFileMessage.vue
 * handover-22 부터 첨부는 텍스트와 같은 행(ChatMessage)이 그린다 — 여러 첨부 그리드 · 영상 · 소리 · 파일 카드 · 업로드 상태
 * (ChatAttachmentGrid). 이 컴포넌트는 기존 호출부(스레드 패널 등)를 위해 이름만 남긴 얇은 감싸개다.
 */
import { memo } from 'react'
import type { ChatMessage as ChatMessageT } from '~/composables/useChat'
import { ChatMessage } from './ChatMessage'

export interface ChatFileMessageProps {
  message: ChatMessageT
  /** 앞 메시지와 묶음(아바타·이름 생략) */
  grouped: boolean
  isOwn: boolean
  /** 묶음의 마지막 — 읽음 표시 */
  isLastInGroup?: boolean
  /** 스레드 패널 안 — 스레드 칩·"스레드로 답장" 없음 */
  inThread?: boolean
  onOpenThread?: (messageId: string) => void
}

export const ChatFileMessage = memo(function ChatFileMessage(props: ChatFileMessageProps) {
  return <ChatMessage {...props} />
})

export default ChatFileMessage
