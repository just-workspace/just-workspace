/**
 * "예약됨" 시트.
 *  440 · 패딩 24 · 성공 타일 40 → "회의를 예약했습니다" 17/600 + 요약 13
 *  → 점선 링크 상자(mono) + [링크 복사] → [캘린더에서 보기][채널로 공유] → 안내 12 muted.
 * 즉시 시작하는 회의이면 안내 위치에 [지금 입장](primary 40) 표시.
 * "캘린더에서 보기" = 예약 날짜의 캘린더(예약 창에서 "내 캘린더에 추가"를 활성화한 경우 호스트 일정이 해당 캘린더에 존재).
 * 백엔드 미구현: 채널로 공유(회의 링크를 채널 메시지로 전송하는 API 없음) — 비활성 "준비 중".
 */
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { addToast } from '~/composables/useToast'
import { scheduleText } from '~/utils/meetingTime'
import { UiModal } from '~/components/ui/Modal'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { writeClipboard } from '~/lib/clipboard'

export interface MeetingsCreatedSheetProps {
  /** 방 이름 */
  name: string
  /** 공유 토큰(/meetings/join/{token}) */
  shareToken: string
  /** 예약 시각(ISO). null = 즉시 시작 */
  scheduledAt: string | null
  durationMinutes: number
  inviteCount: number
  /** 즉시 시작한 회의(또는 시작 10분 전 이내) → "지금 입장" */
  joinNow: boolean
  /** 캘린더에서 보기 경로(예약 날짜) */
  calendarTo?: string
  /** 내 캘린더에 일정으로 추가했는지 여부 — 요약 줄에 표시 */
  addedToCalendar?: boolean
  onClose?: () => void
  /** [지금 입장] */
  onJoin?: () => void
}

/** 회의 생성 후 "예약됨" 시트 */
export function MeetingsCreatedSheet({
  name, shareToken, scheduledAt, durationMinutes, inviteCount, joinNow, calendarTo: calendarToProp, addedToCalendar, onClose, onJoin,
}: MeetingsCreatedSheetProps) {
  const { t } = useI18n()
  const url = `${window.location.origin}/meetings/join/${shareToken}`
  const when = scheduledAt ? scheduleText(scheduledAt, durationMinutes, undefined, t) : t('meetings.created.now')
  const summary = [
    name, when,
    inviteCount ? t('meetings.created.inviteCount', { n: inviteCount }) : '',
    addedToCalendar ? t('meetings.created.addedToCalendar') : '',
  ].filter(Boolean).join(' · ')

  async function copy() {
    try {
      await writeClipboard(url)
      addToast('success', t('meetings.linkCopied'))
    } catch { /* 클립보드 미지원 */ }
  }
  const calendarTo = calendarToProp || '/calendar'

  return (
    <UiModal confirm size="440" ariaLabel={t('meetings.created.ariaLabel')} onClose={() => onClose?.()}>
      <div className="flex flex-col gap-3.5 sm:p-1">
        <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-success/15 text-success">
          <UiIcon name="check" className="h-5 w-5" strokeWidth={2.6} />
        </span>
        <div>
          <h2 className="text-[17px] font-semibold">{joinNow && !scheduledAt ? t('meetings.created.createdTitle') : t('meetings.created.scheduledTitle')}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{summary}</p>
        </div>
        <div className="flex h-10 items-center gap-1.5 rounded-md border border-dashed border-input pl-3 pr-1 font-mono text-xs">
          <span className="min-w-0 flex-1 truncate" title={url}>{url}</span>
          <UiButton size="xs" className="shrink-0 font-sans font-semibold" data-autofocus onClick={() => void copy()}>{t('meetings.list.copyLink')}</UiButton>
        </div>
        <div className="flex gap-2">
          <UiButton
            as="a"
            href={calendarTo}
            variant="outline"
            className="h-10 flex-1 text-[13px]"
            onClick={(e) => { e.preventDefault(); void navigateTo(calendarTo); onClose?.() }}
          >{t('meetings.viewInCalendar')}</UiButton>
          <UiButton variant="outline" className="h-10 flex-1 text-[13px]" disabled title={t('meetings.comingSoon')}>{t('meetings.created.shareToChannel')}</UiButton>
        </div>
        {joinNow
          ? <UiButton className="h-10 font-semibold" onClick={() => onJoin?.()}>{t('meetings.created.enterNow')}</UiButton>
          : <p className="text-xs text-muted-foreground">{t('meetings.created.joinEarlyHint')}</p>}
      </div>
    </UiModal>
  )
}

export default MeetingsCreatedSheet
