/**
 * 채널 탭 — 회의.
 *  (진행 중인 채널 통화가 있는 경우) success 띠: StatusDot live · "채널 통화 진행 중 · mm:ss" + 참여자 · [참여](sm)
 *  "예정" · "지난 회의" 그룹 = 헤더 12/600 muted + UiCard 내부 행 min-h-14:
 *    w-24 mono(굵은 일시 / muted 길이) · 제목 14/600 + 보조 12 muted(호스트) · [링크 복사](outline xs) · UiMenu(캘린더에서 보기 · 링크 복사 · 수정)
 *  하단 [+ 이 채널로 회의 예약](outline sm) → 회의 예약 창(MeetingsInviteModal). 생성 시 이 채널에 연결된다(channel_id).
 * 지난 회의 [회의록] 버튼 — 회의록 기능이 없어 제외했다. 지난 회의 "참가 n"도 기록이 없어 호스트만 표시한다.
 * 서버: GET /api/chat/channels/{id}/meetings (items = 예정·진행 중, past = 지난 회의 10개)
 */
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { addToast } from '~/composables/useToast'
import { useChat } from '~/composables/useChat'
import { openRoom } from '~/composables/useMeetingCall'
import { fetchRooms, meetingsStore, updateRoom, type MeetingRoomInfo, type MeetingUpdate } from '~/composables/useMeetings'
import { fetchMeetingGroups, type ChannelMeetingItem } from '~/composables/useChannelTabs'
import { MeetingsInviteModal, type MeetingCreatePayload } from '~/components/meetings/MeetingsInviteModal'
import { UiButton } from '~/components/ui/Button'
import { UiTrans } from '~/components/ui/Trans'
import { UiCard } from '~/components/ui/Card'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { writeClipboard } from '~/lib/clipboard'

export interface ChatChannelMeetingsTabProps {
  channelId: string
  /** 회의 생성 완료 — 탭 숫자 갱신 */
  onChanged?: () => void
}

const p2 = (n: number) => String(n).padStart(2, '0')
function when(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
function calendarPath(iso?: string | null) {
  if (!iso) return '/calendar'
  const d = new Date(iso)
  return `/calendar?date=${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}
function elapsed(sinceSec: number | null, now: number) {
  if (!sinceSec) return '00:00'
  const s = Math.max(0, Math.floor(now / 1000 - sinceSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${p2(m)}:${p2(s % 60)}` : `${p2(m)}:${p2(s % 60)}`
}

/** 채널 회의 탭 */
export function ChatChannelMeetingsTab({ channelId, onChanged }: ChatChannelMeetingsTabProps) {
  const { t } = useI18n()
  const chat = useChat()
  const call = chat.callStates[channelId]

  const [items, setItems] = useState<ChannelMeetingItem[]>([])
  const [past, setPast] = useState<ChannelMeetingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async () => {
    setLoading(true); setFailed(false)
    try {
      const r = await fetchMeetingGroups(channelId)
      setItems(r.items); setPast(r.past)
    } catch { setFailed(true) } finally { setLoading(false) }
  }, [channelId])
  useEffect(() => { void load() }, [load])

  // 통화 경과 시계
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!call) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [call])

  async function copyLink(m: ChannelMeetingItem) {
    try {
      await writeClipboard(new URL(m.join_path, window.location.origin).toString())
      addToast('success', t('chat.tabs.linkCopied'))
    } catch { addToast('error', t('chat.tabs.copyFailed')) }
  }

  // ── 예약 · 수정 ──
  const [mode, setMode] = useState<'schedule' | 'edit' | null>(null)
  const [editing, setEditing] = useState<MeetingRoomInfo | null>(null)
  const [busy, setBusy] = useState(false)
  async function create(p: MeetingCreatePayload) {
    setBusy(true)
    try {
      await $fetch('/api/meetings/rooms', {
        method: 'POST',
        credentials: 'include',
        body: {
          name: p.name, max_participants: 10, invitees: p.invitees, scheduled_at: p.scheduled_at,
          duration_minutes: p.duration_minutes || 60, password: p.password || null, waiting_room: p.waiting_room,
          description: null, add_to_calendar: p.add_to_calendar, channel_id: channelId,
        },
      })
      setMode(null)
      addToast('success', t('chat.tabs.meetingCreated'))
      await load()
      onChanged?.()
    } catch (e: any) {
      addToast('error', (typeof e?.data?.detail === 'string' && e.data.detail) || t('chat.tabs.meetingCreateFailed'))
    } finally { setBusy(false) }
  }
  async function startEdit(m: ChannelMeetingItem) {
    await fetchRooms()
    const room = meetingsStore.getState().rooms.find(r => r.meeting_id === m.id) as MeetingRoomInfo | undefined
    if (!room) { addToast('info', t('chat.tabs.meetingEditUnavailable')); return }
    setEditing(room); setMode('edit')
  }
  async function update(patch: MeetingUpdate) {
    if (!editing) return
    setBusy(true)
    try {
      await updateRoom(editing.name, patch)
      addToast('success', t('meetings.edit.saved'))
      setMode(null); setEditing(null)
      await load()
    } catch (e: any) {
      addToast('error', (typeof e?.data?.detail === 'string' && e.data.detail) || t('meetings.edit.saveFail'))
    } finally { setBusy(false) }
  }

  function menuOf(m: ChannelMeetingItem, isPast: boolean): UiMenuItem[] {
    const out: UiMenuItem[] = [
      { key: 'cal', label: t('chat.tabs.viewCalendar'), icon: 'calendar' },
      { key: 'copy', label: t('chat.tabs.copyLink'), icon: 'link' },
    ]
    if (m.is_host && !isPast) out.push({ key: 'edit', label: t('chat.tabs.editMeeting'), icon: 'edit' })
    return out
  }
  function onMenu(m: ChannelMeetingItem, key: string) {
    if (key === 'cal') void navigateTo(calendarPath(m.scheduled_at || m.started_at))
    else if (key === 'copy') void copyLink(m)
    else if (key === 'edit') void startEdit(m)
  }

  const groups = [
    { key: 'up', title: t('chat.tabs.upcoming'), list: items, isPast: false },
    { key: 'past', title: t('chat.tabs.past'), list: past, isPast: true },
  ].filter(g => g.list.length)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
      <div className="flex flex-col gap-4" style={{ maxWidth: 880 }}>
        {call && (
          <div className="flex items-center gap-3 rounded-lg border border-success/40 bg-success/10 px-4 py-3">
            <UiStatusDot status="live" />
            <div className="min-w-0 flex-1">
              <UiTrans k="chat.tabs.callLive" as="div" className="text-sm font-semibold" slots={{ elapsed: <span className="font-mono">{elapsed(call.since, now)}</span> }} />
              <div className="truncate text-xs text-muted-foreground">{t('chat.tabs.callWho', { names: call.names.join('·') })}</div>
            </div>
            <UiButton size="sm" onClick={() => openRoom(`chan-${channelId}`)}>{t('chat.tabs.join')}</UiButton>
          </div>
        )}

        {loading
          ? <UiSkeleton preset="list" rows={3} />
          : failed
            ? <UiErrorTile placement="panel" title={t('chat.tabs.listFailed')} onRetry={() => { void load() }} />
            : !groups.length
              ? <UiEmptyState variant="panel" icon="video" title={t('chat.tabs.noMeetings')} description={t('chat.tabs.noMeetingsHint')} />
              : groups.map(g => (
                <div key={g.key}>
                  <p className="pb-1.5 text-xs font-semibold text-muted-foreground">{g.title}</p>
                  <UiCard>
                    {g.list.map(m => {
                      const len = g.isPast ? (m.actual_minutes ?? m.duration_minutes) : m.duration_minutes
                      const live = m.status === 'live'
                      return (
                        <div key={m.id} className="flex min-h-14 items-center gap-4 border-b border-border px-4 last:border-b-0">
                          <div className="w-24 shrink-0 font-mono text-xs leading-snug">
                            <b className="font-semibold">{live ? t('chat.tabs.liveNow') : when(g.isPast ? (m.started_at || m.scheduled_at) : m.scheduled_at)}</b><br />
                            <span className="text-muted-foreground">{len ? t('chat.tabs.minutesN', { n: len }) : ''}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{m.title}</div>
                            <div className="truncate text-xs text-muted-foreground">{m.host_name ? t('chat.tabs.hostBy', { name: m.host_name }) : ''}</div>
                          </div>
                          {!g.isPast && (
                            live
                              ? <UiButton variant="outline" size="xs" onClick={() => { void navigateTo(m.join_path) }}>{t('chat.tabs.join')}</UiButton>
                              : <UiButton variant="outline" size="xs" onClick={() => { void copyLink(m) }}>{t('chat.tabs.copyLink')}</UiButton>
                          )}
                          <UiMenu label={t('chat.tabs.meetingMenu', { title: m.title })} items={menuOf(m, g.isPast)} onSelect={(k) => onMenu(m, k)} />
                        </div>
                      )
                    })}
                  </UiCard>
                </div>
              ))}

        <UiButton variant="outline" size="sm" icon="plus" className="self-start" onClick={() => setMode('schedule')}>
          {t('chat.tabs.scheduleHere')}
        </UiButton>
      </div>

      {mode && (
        <MeetingsInviteModal
          mode={mode}
          busy={busy}
          room={mode === 'edit' ? editing : null}
          onClose={() => { setMode(null); setEditing(null) }}
          onCreate={(p) => { void create(p) }}
          onUpdate={(p) => { void update(p) }}
        />
      )}
    </div>
  )
}

export default ChatChannelMeetingsTab
