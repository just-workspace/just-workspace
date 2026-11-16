/**
 * 채팅 알림 키워드(설정 › 채팅) 입력 규칙 — 서버 app/me/prefs.py normalize_keywords 와 동일 기준.
 * 앞뒤·연속 공백 정리, 대소문자 무시 중복은 무시, 최대 20개·40자.
 */
import { MAX_CHAT_KEYWORDS } from '~/composables/useUserPrefs'

export const KEYWORD_MAX_LEN = 40

/** 키워드 추가 — 앞뒤 공백·연속 공백 정리, 대소문자 무시 중복이면 목록 유지. 결과 목록 또는 오류 키 반환 */
export function addKeyword(list: string[], raw: string): { list: string[]; error?: 'full' | 'long' } {
  const w = raw.split(/\s+/).filter(Boolean).join(' ')
  if (!w) return { list }
  if (w.length > KEYWORD_MAX_LEN) return { list, error: 'long' }
  if (list.some(k => k.toLocaleLowerCase() === w.toLocaleLowerCase())) return { list }
  if (list.length >= MAX_CHAT_KEYWORDS) return { list, error: 'full' }
  return { list: [...list, w] }
}

