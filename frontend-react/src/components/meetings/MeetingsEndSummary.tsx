/**
 * 회의 결과 데스크톱 오른쪽 stage 의 "이번 회의" 요약 카드. 폭 440.
 *  로그인 사용자: 호스트 · 참가(n명 · 손님 n) · 채팅(n개 메시지) · 아바타 줄 · [회의 채팅 보기 outline][캘린더 일정 ghost].
 *  손님:        참가 · 시각 · 아바타 줄만 표시(버튼 없음).
 * 값이 없는 줄·버튼은 표시하지 않는다(채팅 채널이 없는 회의는 [회의 채팅 보기] 없음 — 회의 내 채팅은 퇴장 시 소멸한다).
 * 참가·채팅 수는 본 화면이 관측한 값(useMeetingSessionStats), 호스트·채널·캘린더는 /api/meetings/rooms/{name}/summary 에서 조회한다.
 *   참고: 시안의 "파일 2" 는 회의 채팅에 파일이 없어 제외하였다.
 */
import type { ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { UiCard } from '~/components/ui/Card'
import { UiCardHeader } from '~/components/ui/CardHeader'
import { UiCardTitle } from '~/components/ui/CardTitle'
import { UiCardContent } from '~/components/ui/CardContent'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiButton } from '~/components/ui/Button'
import { UiTrans } from '~/components/ui/Trans'
import type { MeetingSessionPerson } from '~/composables/useMeetingSessionStats'

export interface MeetingsEndSummaryProps {
  /** 손님 형태(참가·시각만 표시, 버튼 없음) */
  guest?: boolean
  /** 호스트 이름 */
  hostName?: string
  /** 참가 인원(본인 포함) */
  participants?: number
  /** 관측된 참가자(아바타 줄 · 손님 수) */
  people?: MeetingSessionPerson[]
  /** 회의 채팅 메시지 수 */
  chats?: number
  /** 시각 "15:00–15:58"(손님 줄) */
  timeRange?: string
  /** [회의 채팅 보기] — 미지정 시 버튼 미표시 */
  onOpenChat?: () => void
  /** [캘린더 일정] — 미지정 시 버튼 미표시 */
  onOpenCalendar?: () => void
  /** [녹화 파일] — 해당 회의에서 녹화한 경우에만 표시 */
  onOpenRecordings?: () => void
}

/** 아바타 줄 최대 개수 */
const MAX_AVATARS = 8

const num = (n: number) => <span className="font-mono">{n}</span>

/** "이번 회의" 요약 카드 */
export function MeetingsEndSummary({ guest = false, hostName, participants, people = [], chats, timeRange, onOpenChat, onOpenCalendar, onOpenRecordings }: MeetingsEndSummaryProps) {
  const { t } = useI18n()
  const guests = people.filter(p => p.guest).length
  const count = Math.max(participants ?? 0, people.length)
  const rows: Array<{ k: string; label: string; value: ReactNode }> = []
  if (!guest && hostName) rows.push({ k: 'host', label: t('meetings.summary.host'), value: hostName })
  if (count > 0) {
    rows.push({
      k: 'people',
      label: t('meetings.summary.participants'),
      value: (
        <>
          <UiTrans k="meetings.summary.peopleVal" slots={{ num: num(count) }} />
          {!guest && guests > 0 && <> · <UiTrans k="meetings.summary.guestsVal" slots={{ num: num(guests) }} /></>}
        </>
      ),
    })
  }
  if (guest && timeRange) rows.push({ k: 'time', label: t('meetings.summary.time'), value: <span className="font-mono">{timeRange}</span> })
  if (!guest && chats !== undefined) {
    rows.push({ k: 'chat', label: t('meetings.summary.chat'), value: <UiTrans k="meetings.summary.chatVal" slots={{ num: num(chats) }} /> })
  }

  return (
    <UiCard className="w-[440px] max-w-full">
      <UiCardHeader>
        <UiCardTitle>{t('meetings.summary.title')}</UiCardTitle>
      </UiCardHeader>
      <UiCardContent className="flex flex-col gap-4 text-[13px]">
        {rows.length > 0 && (
          <dl className="grid gap-x-3 gap-y-2" style={{ gridTemplateColumns: '72px 1fr' }}>
            {rows.map(r => (
              <div key={r.k} className="contents">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="min-w-0 truncate">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {people.length > 0 && (
          <div className="flex -space-x-1.5" aria-label={people.map(p => p.name).join(', ')}>
            {people.slice(0, MAX_AVATARS).map(p => (
              <UiAvatar key={p.id} alt={p.name} fallback={(p.name || '?').charAt(0)} textSize={11} className="h-8 w-8 ring-2 ring-card" />
            ))}
            {people.length > MAX_AVATARS && (
              <span className="grid h-8 w-8 place-items-center rounded-full bg-muted font-mono text-[11px] ring-2 ring-card">+{people.length - MAX_AVATARS}</span>
            )}
          </div>
        )}
        {!guest && (onOpenChat || onOpenCalendar || onOpenRecordings) && (
          <div className="flex gap-2">
            {onOpenChat && <UiButton variant="outline" size="sm" onClick={onOpenChat}>{t('meetings.summary.openChat')}</UiButton>}
            {onOpenCalendar && <UiButton variant="ghost" size="sm" onClick={onOpenCalendar}>{t('meetings.summary.calendar')}</UiButton>}
            {onOpenRecordings && <UiButton variant="ghost" size="sm" onClick={onOpenRecordings}>{t('meetings.recordings.menu')}</UiButton>}
          </div>
        )}
      </UiCardContent>
    </UiCard>
  )
}

export default MeetingsEndSummary
