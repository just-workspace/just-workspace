/**
 * 회의.
 *  머리: 회의 24/700 + "진행 중 n · 오늘 예정 n" · [지금 시작](outline 40) [회의 예약](primary 40) — 폭 1100.
 *  목록: 진행 중 · 예정(날짜별) · 지난 묶음의 행 + ⋮. 모바일은 FAB → [지금 시작 / 회의 예약] 시트.
 *  생성 → "예약됨" 시트(링크 복사 · 캘린더 · 채널 공유, 지금 시작이면 "지금 입장"). 동일 이름 409 는 이름 칸 아래 안내.
 *  행 ⋮: 수정(동일 예약 창, PATCH) · 회의 종료 · 내 응답(RSVP) · 캘린더에서 보기(해당 날짜).
 *  알림의 회의 초대 수락/거절(useNotifications.runAction)·새 초대 알림 수신 시 목록을 재조회한다.
 * 회의는 동일 탭의 회의 화면으로 연다(미니 통화 창).
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useSiteConfig, siteConfigStore } from '~/composables/useSiteConfig'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { NOTIFICATION_EVENT, NOTIFICATION_ACTION_EVENT } from '~/composables/useNotifications'
import {
  useMeetings, fetchRooms, createRoom, deleteRoom, updateRoom, endRoom, rsvpMeeting,
  type MeetingRoomInfo, type MeetingRsvp, type MeetingUpdate,
} from '~/composables/useMeetings'
import { openRoom } from '~/composables/useMeetingCall'
import { meetingCounts, viewOf } from '~/utils/meetingTime'
import { meetingJoinPath } from '~/components/meetings/prejoin'
import type { UiMenuItem } from '~/components/ui/Menu'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiFab } from '~/components/ui/Fab'
import { UiMenu } from '~/components/ui/Menu'
import { MeetingsList } from '~/components/meetings/MeetingsList'
import { MeetingsRecordingsModal } from '~/components/meetings/MeetingsRecordingsModal'
import { MeetingsInviteModal, type MeetingCreatePayload } from '~/components/meetings/MeetingsInviteModal'
import { MeetingsCreatedSheet } from '~/components/meetings/MeetingsCreatedSheet'
import { writeClipboard } from '~/lib/clipboard'

// 알림(회의 초대 수락/거절 버튼 · 새 초대) 연동 — 회의 관련 알림이면 목록을 재조회한다
function isMeetingNotif(n: any) {
  return n?.type === 'meeting_invite' || (n?.action_url || n?.link || '').startsWith('/meetings')
}
function is409(e: any) { return e?.statusCode === 409 || e?.status === 409 || e?.response?.status === 409 }

/** 캘린더에서 보기 — 예약 날짜의 캘린더(호스트는 add_to_calendar 로 생성한 일정, 초대 대상자는 초대 일정이 해당 캘린더에 존재) */
function calendarPath(scheduledAt?: string | null) {
  if (!scheduledAt) return '/calendar'
  const d = new Date(scheduledAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `/calendar?date=${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 회의 목록 페이지 */
export default function MeetingsIndexPage() {
  const { t } = useI18n()
  const { appName, demoMode } = useSiteConfig()
  useHead({ title: `${t('nav.meetings')} | ${appName}` })
  // 상단바 = "워크스페이스 / 회의" — 목록은 세 번째 단 없음
  useBreadcrumb('')

  const { user } = useAuth()
  const { rooms, loading, error } = useMeetings()

  useEffect(() => {
    function onNotifAction(e: Event) {
      const d = (e as CustomEvent).detail
      if (isMeetingNotif(d?.notification) || String(d?.action?.url || '').startsWith('/api/meetings/')) void fetchRooms()
    }
    function onNotif(e: Event) { if (isMeetingNotif((e as CustomEvent).detail)) void fetchRooms() }
    window.addEventListener(NOTIFICATION_ACTION_EVENT, onNotifAction)
    window.addEventListener(NOTIFICATION_EVENT, onNotif)
    return () => {
      window.removeEventListener(NOTIFICATION_ACTION_EVENT, onNotifAction)
      window.removeEventListener(NOTIFICATION_EVENT, onNotif)
    }
  }, [])

  // 1분마다 "시작 n분"·입장 가능 여부를 재계산하고, 30초마다 방 목록(참가자 수)을 재조회한다
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (siteConfigStore.getState().demoMode) return
    void fetchRooms()
    const tick = setInterval(() => { setNow(new Date()) }, 60_000)
    const poll = setInterval(() => { if (!document.hidden) void fetchRooms() }, 30_000)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [])

  const counts = meetingCounts(rooms, now)

  // 회의는 동일 탭의 회의 화면으로 연다(기존 팝업 → 미니 통화 창 지원 목적). 다른 화면으로 이동하면 셸이 미니 창을 표시한다.
  // 호스트 여부는 주소로 전달하지 않는다 — 토큰을 발급하는 백엔드가 반환한다.
  function openMeetingWindow(roomName: string, shareToken: string) {
    void openRoom(roomName, shareToken ? { st: shareToken } : undefined)
  }

  // ── 만들기 ──
  const [createMode, setCreateMode] = useState<'schedule' | 'now' | 'edit' | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ room: MeetingRoomInfo; payload: MeetingCreatePayload } | null>(null)
  const [editing, setEditing] = useState<MeetingRoomInfo | null>(null)
  const [recordingsOf, setRecordingsOf] = useState<MeetingRoomInfo | null>(null)
  const [nameConflict, setNameConflict] = useState('')

  async function handleCreate(payload: MeetingCreatePayload) {
    setCreating(true)
    setNameConflict('')
    try {
      const room = await createRoom(payload.name, {
        invitees: payload.invitees,
        scheduled_at: payload.scheduled_at,
        duration_minutes: payload.duration_minutes,
        password: payload.password,
        waiting_room: payload.waiting_room,
        add_to_calendar: payload.add_to_calendar,
      })
      setCreateMode(null)
      setCreated({ room, payload })
    } catch (e: any) {
      // 동일 이름의 회의를 다른 사용자가 보유하면 409 — 창을 닫지 않고 이름 칸에 안내를 표시한다
      if (is409(e)) setNameConflict(t('meetings.index.nameTaken'))
      else addToast('error', (typeof e?.data?.detail === 'string' && e.data.detail) || t('meetings.index.createFail'))
    } finally {
      setCreating(false)
    }
  }

  function closeCreate() {
    setCreateMode(null)
    setEditing(null)
    setNameConflict('')
  }

  // ── 수정(예약 창 재사용) ──
  function handleEdit(room: MeetingRoomInfo) {
    setEditing(room)
    setNameConflict('')
    setCreateMode('edit')
  }
  async function handleUpdate(patch: MeetingUpdate) {
    const r = editing
    if (!r) return
    setCreating(true)
    try {
      await updateRoom(r.name, patch)
      addToast('success', t('meetings.edit.saved'))
      closeCreate()
    } catch (e: any) {
      addToast('error', (typeof e?.data?.detail === 'string' && e.data.detail) || t('meetings.edit.saveFail'))
    } finally {
      setCreating(false)
    }
  }

  async function handleEnd(room: MeetingRoomInfo) {
    if (!await confirmBox(t('meetings.index.endConfirm', { name: room.title || room.name }), { danger: true, confirmLabel: t('meetings.list.end') })) return
    try { await endRoom(room.name) }
    catch (e: any) { addToast('error', (typeof e?.data?.detail === 'string' && e.data.detail) || t('meetings.index.endFail')) }
  }

  async function handleRsvp(room: MeetingRoomInfo, response: MeetingRsvp) {
    if (!room.meeting_id) return
    try {
      await rsvpMeeting(room.meeting_id, response)
      addToast('success', t(`meetings.rsvp.done.${response}`))
    } catch (e: any) {
      addToast('error', (typeof e?.data?.detail === 'string' && e.data.detail) || t('meetings.rsvp.failed'))
      void fetchRooms()
    }
  }

  function handleCalendar(room: MeetingRoomInfo) { void navigateTo(calendarPath(room.scheduled_at)) }
  const createdJoinNow = created
    ? viewOf({ ...created.room, scheduled_at: created.payload.scheduled_at, duration_minutes: created.payload.duration_minutes }, now).joinable
    : false
  function joinCreated() {
    const c = created
    if (!c) return
    setCreated(null)
    openMeetingWindow(c.room.name, c.room.share_token)
  }

  // ── 행 동작 ──
  function handleJoin(room: MeetingRoomInfo) {
    if (!user) return
    const path = meetingJoinPath(room)
    if (path) { void navigateTo(path); return }
    openMeetingWindow(room.name, room.share_token || '')
  }

  async function handleCopy(room: MeetingRoomInfo) {
    if (!room.share_token) return
    try {
      await writeClipboard(`${window.location.origin}/meetings/join/${room.share_token}`)
      addToast('success', t('meetings.linkCopied'))
    } catch { /* 클립보드 미지원 */ }
  }

  async function handleDelete(room: MeetingRoomInfo) {
    if (!await confirmBox(t('meetings.index.deleteConfirm', { name: room.title || room.name }), { danger: true, confirmLabel: t('common.delete') })) return
    try {
      await deleteRoom(room.name, room.meeting_id)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('meetings.index.deleteFail'))
    }
  }

  // ── 모바일 FAB 시트 ──
  const [fabMenu, setFabMenu] = useState(false)
  const fabItems: UiMenuItem[] = [
    { key: 'now', label: t('meetings.startNow'), icon: 'video' },
    { key: 'schedule', label: t('meetings.schedule'), icon: 'calendar' },
  ]

  const notConfigured = !!error && /not configured/i.test(error)

  // 데모 모드 자리표시(시안 범위 외 — 기존 내용 유지, 글리프만 아이콘으로 대체)
  if (demoMode) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="max-w-md space-y-4 text-center">
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-[10px] bg-primary/15 text-primary">
            <UiIcon name="video" className="h-5 w-5" />
          </span>
          <h2 className="text-[15px] font-semibold">{t('nav.meetings')}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('demo.meetingsDescription')}</p>
          <ul className="space-y-2 rounded-lg border border-border bg-card p-4 text-left text-sm">
            {['demo.meetingsFeature1', 'demo.meetingsFeature2', 'demo.meetingsFeature3'].map(k => (
              <li key={k} className="flex items-center gap-2">
                <UiIcon name="check" className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.4} />{t(k)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* 최대 1100. 유동 레이아웃 적용 이후 큰 화면에서 왼쪽에 붙어 빈 상태·목록이 치우쳐 보이므로 가운데 정렬 */}
      <div className="mx-auto flex w-full max-w-[1100px] flex-col pb-28 md:gap-4 md:px-7 md:pb-10 md:pt-6">
        {/* 머리 */}
        <div className="flex items-end gap-2.5 px-4 pb-2 pt-3 md:p-0">
          <div className="min-w-0 flex-1">
            <h1 className="hidden text-2xl font-bold tracking-[-0.02em] md:block">{t('nav.meetings')}</h1>
            <p className="text-xs text-muted-foreground md:mt-1 md:text-[13.5px]">
              {t('meetings.index.liveLabel')} <span className="font-mono">{counts.live}</span> · {t('meetings.index.todayLabel')} <span className="font-mono">{counts.today}</span>
            </p>
          </div>
          <UiButton variant="outline" className="hidden px-3.5 text-[13px] md:inline-flex" onClick={() => setCreateMode('now')}>{t('meetings.startNow')}</UiButton>
          <UiButton className="hidden px-4 text-[13px] font-semibold md:inline-flex" onClick={() => setCreateMode('schedule')}>{t('meetings.schedule')}</UiButton>
        </div>

        {loading && !rooms.length
          ? <UiSkeleton preset="list" rows={4} framed className="mx-4 md:mx-0" />
          : error && !rooms.length
            ? (
              <UiErrorTile
                placement="page"
                title={notConfigured ? t('meetings.index.notConfigured') : t('meetings.index.loadFail')}
                detail={notConfigured ? t('meetings.index.notConfiguredDesc') : error}
                noRetry={notConfigured}
                onRetry={() => void fetchRooms()}
              />
            )
            : !rooms.length
              ? (
                <UiEmptyState
                  icon="video"
                  title={t('meetings.index.emptyTitle')}
                  // 목록에는 본인이 생성했거나 초대받은 회의만 포함된다(타인이 개설한 진행 중 회의는 미표시) — 빈 화면에서 이를 안내한다
                  description={t('meetings.index.emptyDescMine', '내가 만들었거나 초대받은 회의가 여기에 표시됩니다. 지금 시작하거나 회의를 예약해 초대 링크를 보내십시오.')}
                  actionLabel={t('meetings.schedule')}
                  onAction={() => setCreateMode('schedule')}
                />
              )
              : (
                <>
                  {error && <UiErrorTile placement="card" className="mx-4 md:mx-0" title={t('meetings.index.refreshFail')} detail={error} onRetry={() => void fetchRooms()} />}
                  <MeetingsList
                    rooms={rooms}
                    now={now}
                    onJoin={handleJoin}
                    onCopy={r => void handleCopy(r)}
                    onDelete={r => void handleDelete(r)}
                    onEdit={handleEdit}
                    onEnd={r => void handleEnd(r)}
                    onRsvp={(r, resp) => void handleRsvp(r, resp)}
                    onCalendar={handleCalendar}
                    onRecordings={setRecordingsOf}
                  />
                </>
              )}
      </div>

      {recordingsOf && <MeetingsRecordingsModal room={recordingsOf.name} title={recordingsOf.title || recordingsOf.name} onClose={() => setRecordingsOf(null)} />}
      <UiFab label={t('meetings.index.fabLabel')} onClick={() => setFabMenu(true)} />
      {fabMenu && (
        <UiMenu
          dense
          width={220}
          items={fabItems}
          anchor={null}
          title={t('meetings.index.newMeeting')}
          onSelect={k => setCreateMode(k as 'now' | 'schedule')}
          onClose={() => setFabMenu(false)}
        />
      )}

      {createMode && (
        <MeetingsInviteModal
          mode={createMode}
          busy={creating}
          room={editing}
          serverNameError={nameConflict}
          onClose={closeCreate}
          onCreate={p => void handleCreate(p)}
          onUpdate={p => void handleUpdate(p)}
        />
      )}
      {created && (
        <MeetingsCreatedSheet
          name={created.room.name}
          shareToken={created.room.share_token}
          scheduledAt={created.payload.scheduled_at}
          durationMinutes={created.payload.duration_minutes}
          inviteCount={created.payload.invitees.length}
          joinNow={createdJoinNow}
          calendarTo={calendarPath(created.payload.scheduled_at)}
          addedToCalendar={created.payload.add_to_calendar}
          onClose={() => setCreated(null)}
          onJoin={joinCreated}
        />
      )}
    </div>
  )
}
