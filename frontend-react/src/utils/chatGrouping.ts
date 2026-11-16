/**
 * 메시지 묶음 판정 — 순수 함수.
 * 묶음 = 동일 작성자 · 5분 이내 · 사이에 날짜 / 새 메시지 / 시스템 줄 없음.
 * 묶음의 첫 줄만 아바타·이름·시간을 표시하고, 이어지는 줄은 본문만 표시한다(시간은 호버·포커스 시 거터 내부).
 * 텍스트와 파일은 같은 묶음으로 이어진다(디스코드와 동일). 시스템 메시지는 항상 별도.
 * 답장 메시지(reply_to_id)는 항상 새 묶음 — 본문 위 답장 미리보기 줄이 아바타 자리와 이어져야 한다.
 */

/** 묶음 시간 창 — 5분 */
export const GROUP_WINDOW_MS = 5 * 60_000

export interface GroupableMessage {
  id: string
  sender?: { id: string } | null
  message_type: string
  created_at: string
  /** 인라인 답장 — 있으면 항상 새 묶음 */
  reply_to_id?: string | null
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/**
 * msg 가 직전 prev 와 같은 묶음인지 여부(= msg 가 묶음의 이어지는 줄인지).
 * firstUnreadId — "새 메시지" 구분선이 msg 바로 위에 있으면 묶지 않는다.
 */
export function continuesGroup(msg: GroupableMessage, prev: GroupableMessage | null | undefined, firstUnreadId?: string | null): boolean {
  if (!prev) return false
  if (msg.message_type === 'system' || prev.message_type === 'system') return false
  if (!msg.sender || !prev.sender || msg.sender.id !== prev.sender.id) return false
  if (!sameDay(msg.created_at, prev.created_at)) return false
  if (firstUnreadId && msg.id === firstUnreadId) return false
  if (msg.reply_to_id) return false
  const dt = new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime()
  return dt >= 0 && dt < GROUP_WINDOW_MS
}

/** 목록 전체의 "이어지는 줄" 표시(continuesGroup 을 앞에서부터 적용) */
export function groupedFlags(list: GroupableMessage[], firstUnreadId?: string | null): boolean[] {
  return list.map((m, i) => continuesGroup(m, i > 0 ? list[i - 1] : null, firstUnreadId))
}
