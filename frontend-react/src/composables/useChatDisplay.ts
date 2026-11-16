/**
 * 채팅 메시지 표시 — 설정 › 채팅 "메시지 표시"(cozy/compact) + 묶음 간격, 모바일은 별도.
 * 터치 기기에서는 compact 를 비활성화한다(원칙: 터치 목표 44). 값은 개인 설정(/api/me/prefs chat.message_display · chat.group_gap).
 */
import { useStore } from 'zustand'
import { useIsMobile } from '~/composables/useIsMobile'
import { effectiveChatDisplay, userPrefsStore } from '~/composables/useUserPrefs'
import type { ChatRowDisplay } from '~/components/chat/ChatMessageRow'

function isCoarse(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
}

export function useChatDisplay(): { display: ChatRowDisplay; gap: number } {
  const isMobile = useIsMobile()
  const pref = useStore(userPrefsStore, s => s.prefs.chatMessageDisplay)
  const gap = useStore(userPrefsStore, s => s.prefs.chatGroupGap)
  if (isMobile) return { display: 'mobile', gap: 12 }
  return { display: effectiveChatDisplay(pref, isCoarse()), gap }
}
