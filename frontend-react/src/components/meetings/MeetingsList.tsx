/**
 * 회의 목록: 카드 3버튼 → 행 + ⋮.
 *  묶음 머리 32(12/600 muted) + 카드(rounded-12) 안 행 60:
 *   시각 96(mono 12: 시작 600 / 길이·"시작 n분" muted) · 제목 14/600 + Live 칩(success 틴트 · 점 · "Live · n명") + "내가 호스트"
 *   · 메타 12(호스트 · 비밀번호 · 대기 n명) · [참여](진행 중·입장 가능) 또는 [링크 복사] · ⋮(수정·캘린더·삭제는 호스트만)
 *  모바일 행 64: 시각 52 · 제목 15/600 · 메타 · [참여](진행 중만) · ⋮ 40. 묶음 머리 bg-card.
 * 메타(시안 "호스트 박민지 · 참석 6 · 수락함"): 호스트 · 참석(초대) n · (호스트면 수락 n / 초대받았으면 내 응답).
 * ⋮: 참여 · 링크 복사 · 내 응답(수락·미정·거절, 초대받은 회의) · 수정 · 회의 종료(진행 중) · 캘린더에서 보기 · 녹화 파일(끝난 회의) · 삭제(호스트).
 */
import { useState, type MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import type { MeetingRoomInfo, MeetingRsvp } from '~/composables/useMeetings'
import { groupMeetings, type MeetingView } from '~/utils/meetingTime'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'

export interface MeetingsListProps {
  /** 방 목록(useMeetings().rooms) */
  rooms: readonly MeetingRoomInfo[]
  /** 기준 시각(1분마다 갱신) — 묶음·"시작 n분"·입장 가능 */
  now: Date
  onJoin?: (room: MeetingRoomInfo) => void
  onCopy?: (room: MeetingRoomInfo) => void
  onDelete?: (room: MeetingRoomInfo) => void
  onEdit?: (room: MeetingRoomInfo) => void
  onEnd?: (room: MeetingRoomInfo) => void
  onRsvp?: (room: MeetingRoomInfo, response: MeetingRsvp) => void
  onCalendar?: (room: MeetingRoomInfo) => void
  /** 끝난 회의 ⋮ "녹화 파일" — 미지정 시 항목 미표시 */
  onRecordings?: (room: MeetingRoomInfo) => void
}

function title(r: MeetingRoomInfo) { return r.title || r.name }

/** 회의 목록(묶음 + 행 + ⋮ 메뉴) */
export function MeetingsList({ rooms, now, onJoin, onCopy, onDelete, onEdit, onEnd, onRsvp, onCalendar, onRecordings }: MeetingsListProps) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const groups = groupMeetings(rooms, now, t)

  function meta(v: MeetingView<MeetingRoomInfo>) {
    const r = v.room
    const parts: string[] = []
    parts.push(r.is_host ? t('meetings.list.hostMe') : r.host_name ? t('meetings.list.hostName', { name: r.host_name }) : '')
    if (v.live && !isMobile) parts.push(t('meetings.list.capacity', { n: r.num_participants, max: r.max_participants }))
    if (r.invitee_count) {
      parts.push(t('meetings.list.invited', { n: r.invitee_count }))
      if (r.is_host && r.accepted_count) parts.push(t('meetings.list.acceptedN', { n: r.accepted_count }))
    }
    if (r.status === 'cancelled') parts.push(t('meetings.list.cancelled'))
    if (r.has_password && !isMobile) parts.push(t('meetings.list.password'))
    return parts.filter(Boolean).join(' · ')
  }

  /** 내 응답 표기(초대받은 회의) — 응답 전은 warning 으로 강조 */
  function myResponse(r: MeetingRoomInfo) {
    if (r.is_host || !r.my_response) return null
    const key = r.my_response === 'pending' ? 'pending' : r.my_response
    return { text: t(`meetings.rsvp.state.${key}`), tone: key === 'pending' ? 'text-warning font-semibold' : key === 'declined' ? 'text-danger' : '' }
  }

  const [menu, setMenu] = useState<{ anchor: DOMRect | null; view: MeetingView<MeetingRoomInfo> } | null>(null)
  function openMenu(e: MouseEvent<HTMLButtonElement>, view: MeetingView<MeetingRoomInfo>) {
    setMenu({ anchor: isMobile ? null : e.currentTarget.getBoundingClientRect(), view })
  }
  const menuItems: UiMenuItem[] = (() => {
    const v = menu?.view
    if (!v) return []
    const r = v.room
    const items: UiMenuItem[] = []
    if (v.joinable) items.push({ key: 'join', label: t('meetings.list.join'), icon: 'video' })
    items.push({ key: 'copy', label: t('meetings.list.copyLink'), icon: 'link', disabled: !r.share_token })
    // 내 응답 — 초대받은 회의(호스트 아님)이며 종료 전인 경우
    if (!r.is_host && r.my_response && r.meeting_id && !v.ended) {
      items.push({ key: 'rsvp-head', label: t('meetings.rsvp.mine'), heading: true, separated: true })
      for (const k of ['accepted', 'tentative', 'declined'] as const) {
        items.push({ key: `rsvp:${k}`, label: t(`meetings.rsvp.${k}`), radio: true, checked: r.my_response === k })
      }
    }
    if (r.is_host && !v.ended) {
      items.push({ key: 'edit', label: t('common.edit'), icon: 'edit', separated: true })
      if (v.live) items.push({ key: 'end', label: t('meetings.list.end'), icon: 'video-slash' })
    }
    if (r.scheduled_at) items.push({ key: 'calendar', label: t('meetings.viewInCalendar'), icon: 'calendar', separated: !(r.is_host && !v.ended) })
    if (v.ended && onRecordings) items.push({ key: 'recordings', label: t('meetings.recordings.menu'), icon: 'download', separated: !r.scheduled_at && !(r.is_host && !v.ended) })
    if (r.is_host) items.push({ key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true })
    return items
  })()
  function onMenu(key: string) {
    const r = menu?.view.room
    if (!r) return
    if (key === 'join') onJoin?.(r)
    else if (key === 'copy') onCopy?.(r)
    else if (key === 'delete') onDelete?.(r)
    else if (key === 'edit') onEdit?.(r)
    else if (key === 'end') onEnd?.(r)
    else if (key === 'calendar') onCalendar?.(r)
    else if (key === 'recordings') onRecordings?.(r)
    else if (key.startsWith('rsvp:')) onRsvp?.(r, key.slice(5) as MeetingRsvp)
  }

  return (
    <div className="flex flex-col md:gap-4">
      {groups.map(g => (
        <section key={g.key} aria-label={g.label}>
          <h2 className="flex h-8 items-center px-4 text-xs font-semibold text-muted-foreground max-md:bg-card md:px-0">{g.label}</h2>
          <ul role="list" className="md:overflow-hidden md:rounded-lg md:border md:border-border md:bg-card">
            {g.items.map((v) => {
              const resp = myResponse(v.room)
              const m = meta(v)
              return (
                <li
                  key={v.room.meeting_id || v.room.name}
                  className="flex min-h-16 items-center gap-3 border-b border-border py-2 pl-4 pr-1 md:min-h-[60px] md:gap-3.5 md:pr-2.5 md:last:border-b-0"
                >
                  <div className="w-[52px] shrink-0 font-mono text-xs leading-[1.4] md:w-24">
                    <b className="font-semibold">{v.timeText}</b><br />
                    <span className="text-muted-foreground">{isMobile ? v.durShort : v.durText}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[15px] font-semibold md:text-sm">
                      <span className={cn('min-w-0 truncate', v.room.status === 'cancelled' ? 'line-through text-muted-foreground' : '')}>{title(v.room)}</span>
                      {v.live && (
                        <span className="inline-flex h-5 shrink-0 items-center gap-[5px] rounded-[5px] bg-success/15 px-[7px] text-[11px] font-bold text-success max-md:hidden">
                          <span className="h-[7px] w-[7px] rounded-full bg-current" aria-hidden="true" />{t('meetings.list.liveCount', { n: v.room.num_participants })}
                        </span>
                      )}
                      {v.room.is_host && <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] bg-primary/15 px-1.5 text-[11px] font-semibold text-primary max-md:hidden">{t('meetings.list.iAmHost')}</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {isMobile && v.live && <>{t('meetings.list.liveCount', { n: v.room.num_participants })}{m ? ' · ' : ''}</>}{m}
                      {resp && <> · <span className={resp.tone}>{resp.text}</span></>}
                      {v.room.is_host && v.room.pending_count > 0 && <span className="font-semibold text-warning"> · {t('meetings.list.pending', { n: v.room.pending_count })}</span>}
                    </div>
                  </div>
                  {v.joinable && (v.live || !isMobile)
                    ? (
                      <UiButton
                        size="sm"
                        className="shrink-0 px-3.5 font-semibold max-md:h-9 max-md:text-sm"
                        onClick={() => onJoin?.(v.room)}
                      >{t('meetings.list.join')}</UiButton>
                    )
                    : !isMobile
                      ? (
                        <UiButton
                          variant="outline"
                          size="sm"
                          className="shrink-0 px-3 text-xs"
                          disabled={!v.room.share_token}
                          onClick={() => onCopy?.(v.room)}
                        >{t('meetings.list.copyLink')}</UiButton>
                      )
                      : null}
                  <UiIconButton
                    label={t('meetings.list.rowMenu', { name: title(v.room) })}
                    icon="more-vertical"
                    size={isMobile ? 'md' : 'sm'}
                    noTooltip={isMobile}
                    className="shrink-0 md:h-9 md:w-9"
                    onClick={e => openMenu(e, v)}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {menu && <UiMenu dense width={220} items={menuItems} anchor={menu.anchor} title={title(menu.view.room)} onSelect={onMenu} onClose={() => setMenu(null)} />}
    </div>
  )
}

export default MeetingsList
