/**
 * 채널 알림 설정 — 데스크톱 Modal md 448, 모바일 바텀시트. UiModal 이 sm 미만에서 시트로 바뀐다.
 * 라디오 카드 3개: 모든 새 메시지 / 멘션만(기본) / 끄기(음소거 — notify_level none + muted).
 * "기기별 세부 설정"(데스크톱·모바일 푸시·이메일·따라가는 스레드 답글) — GET/PATCH /channels/{id}/prefs 의 기기 필드.
 * 데스크톱·모바일 푸시: 위 설정 따름 / 끄기. 이메일은 서버가 값만 저장하고 아직 보내지 않아 현재 값만 보인다(바꿀 수 없음).
 * 데스크톱은 접힘(펼치기), 모바일은 다음 화면(시트 안에서 화면 전환, ‹ 로 돌아옴).
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useStore } from 'zustand'
// class 를 이어 붙이기만 한다(tailwind-merge 없이 — 뒤에 온 클래스를 지우지 않는다)
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { chatStore, fetchChannelPrefs, updateChannelPrefs, useChat, type ChannelDevicePrefs, type NotifyLevel } from '~/composables/useChat'
import { chatUiStore, setNotifySheetChannelId } from '~/composables/useChatUi'
import { UiModal } from '~/components/ui/Modal'
import { UiIcon } from '~/components/ui/Icon'
import { UiSelect } from '~/components/ui/Select'
import { UiSwitch } from '~/components/ui/Switch'

const DEVICE_DEFAULT: Required<ChannelDevicePrefs> = { desktop: true, push: true, email: false, thread_replies: true }

/** 채널 알림 설정 시트 */
export function ChatNotifySheet() {
  const { t } = useI18n()
  const chat = useChat()
  const notifySheetChannelId = useStore(chatUiStore, s => s.notifySheetChannelId)

  const ch = chat.channels.find(c => c.id === notifySheetChannelId) || null
  const title = !ch ? '' : t('chat.notify.title', { channel: ch.type === 'dm' ? chat.getDMDisplayName(ch) : `#${ch.name}` })

  function currentLevel(): NotifyLevel {
    const c = chatStore.getState().channels.find(x => x.id === chatUiStore.getState().notifySheetChannelId) || null
    if (!c) return 'mentions'
    if (c.muted) return 'none'
    return c.notify_level || (c.type === 'dm' ? 'all' : 'mentions')
  }
  const [level, setLevel] = useState<NotifyLevel>(currentLevel)

  const [devicesOpen, setDevicesOpen] = useState(false)
  /** 모바일: 기기별 세부 화면 */
  const [mobileDevices, setMobileDevices] = useState(false)
  const [saving, setSaving] = useState(false)

  // 기기 세부 — 시트를 열 때 서버에서 읽는다. 읽기 전·실패면 저장에 넣지 않는다(서버 값 보존).
  const [devices, setDevices] = useState<Required<ChannelDevicePrefs>>({ ...DEVICE_DEFAULT })
  const [devicesLoaded, setDevicesLoaded] = useState<Required<ChannelDevicePrefs> | null>(null)
  async function loadDevices(id: string | null) {
    setDevicesLoaded(null)
    setDevices({ ...DEVICE_DEFAULT })
    if (!id) return
    try {
      const p = await fetchChannelPrefs(id)
      if (chatUiStore.getState().notifySheetChannelId !== id) return
      const d = {
        desktop: p.desktop !== false,
        push: p.push !== false,
        email: !!p.email,
        thread_replies: p.thread_replies !== false,
      }
      setDevices({ ...d })
      setDevicesLoaded(d)
    } catch (e) {
      console.error('fetchChannelPrefs error:', e)
    }
  }
  useEffect(() => {
    setLevel(currentLevel())
    setDevicesOpen(false)
    setMobileDevices(false)
    void loadDevices(notifySheetChannelId)
     
  }, [notifySheetChannelId])

  const FOLLOW_OPTIONS = [
    { value: 'on', label: t('chat.notify.follows') },
    { value: 'off', label: t('chat.notify.off') },
  ]
  const desktopSel = devices.desktop ? 'on' : 'off'
  const setDesktopSel = (v: string | number | null) => setDevices({ ...devices, desktop: v !== 'off' })
  const pushSel = devices.push ? 'on' : 'off'
  const setPushSel = (v: string | number | null) => setDevices({ ...devices, push: v !== 'off' })
  const threadReplies = devices.thread_replies
  const setThreadReplies = (v: boolean) => setDevices({ ...devices, thread_replies: v })
  const emailLabel = devices.email ? t('chat.notify.emailDefault') : t('chat.notify.off')
  /** 모바일 행 오른쪽 요약 — 데스크톱·푸시·스레드 답글이 다 켜져 있으면 "위 설정 따름" */
  const devicesSummary = devices.desktop && devices.push && devices.thread_replies ? t('chat.notify.follows') : t('chat.notify.custom')

  const OPTIONS: { value: NotifyLevel; title: string; desc: string; descShort: string; isDefault?: boolean }[] = [
    { value: 'all', title: t('chat.notify.all'), desc: t('chat.notify.allDesc'), descShort: '' },
    { value: 'mentions', title: t('chat.notify.mentions'), desc: t('chat.notify.mentionsDesc'), descShort: t('chat.notify.mentionsDescShort'), isDefault: true },
    { value: 'none', title: t('chat.notify.none'), desc: t('chat.notify.noneDesc'), descShort: '' },
  ]

  function close() { setNotifySheetChannelId(null) }

  async function save() {
    const c = ch
    if (!c || saving) return
    setSaving(true)
    try {
      const patch: Parameters<typeof updateChannelPrefs>[1] = { notify_level: level, muted: level === 'none' }
      const base = devicesLoaded
      if (base) {
        // 바뀐 기기 필드만 보낸다(이메일은 화면에서 바꾸지 않는다)
        if (devices.desktop !== base.desktop) patch.desktop = devices.desktop
        if (devices.push !== base.push) patch.push = devices.push
        if (devices.thread_replies !== base.thread_replies) patch.thread_replies = devices.thread_replies
      }
      await updateChannelPrefs(c.id, patch)
      addToast('success', t('chat.notify.saved'))
      close()
    } catch (e: any) {
      console.error('updateChannelPrefs error:', e)
      addToast('error', t('chat.notify.failed'))
    } finally {
      setSaving(false)
    }
  }

  function onRadioKey(e: KeyboardEvent, idx: number) {
    const n = OPTIONS.length
    let next = -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % n
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + n) % n
    if (next < 0) return
    e.preventDefault()
    setLevel(OPTIONS[next].value)
    const v = OPTIONS[next].value
    requestAnimationFrame(() => (document.querySelector(`[data-notify-opt="${v}"]`) as HTMLElement | null)?.focus())
  }

  if (!ch) return null

  return (
    <UiModal
      title={title}
      size="md"
      onClose={close}
      footer={(
        <>
          <button
            type="button"
            className="hidden h-9 items-center rounded-[10px] border border-border px-3.5 text-[13px] font-medium text-foreground hover:bg-accent sm:inline-flex"
            onClick={close}
          >{t('common.cancel')}</button>
          <button
            type="button"
            className="inline-flex h-12 w-full items-center justify-center rounded-[12px] bg-primary px-4 text-[15px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:h-9 sm:w-auto sm:rounded-[10px] sm:text-[13px]"
            disabled={saving}
            onClick={() => { void save() }}
          >{t('common.save')}</button>
        </>
      )}
    >
      {/* 모바일: 기기별 세부 화면(‹ 로 돌아옴) */}
      {mobileDevices && (
        <div className="flex flex-col gap-1 sm:hidden">
          <button type="button" className="flex min-h-10 items-center gap-1 px-1 text-left text-[13px] font-semibold text-muted-foreground" onClick={() => setMobileDevices(false)}>
            <UiIcon name="chevron-left" className="h-4 w-4" strokeWidth={2.5} />{t('chat.notify.devices')}
          </button>
          <div className="flex min-h-12 items-center gap-2 px-1 text-[15px]">
            <span className="flex-1">{t('chat.notify.desktop')}</span>
            <UiSelect modelValue={desktopSel} onUpdateModelValue={setDesktopSel} options={FOLLOW_OPTIONS} placeholder="" className="w-[180px]" aria-label={t('chat.notify.desktop')} />
          </div>
          <div className="flex min-h-12 items-center gap-2 px-1 text-[15px]">
            <span className="flex-1">{t('chat.notify.mobilePush')}</span>
            <UiSelect modelValue={pushSel} onUpdateModelValue={setPushSel} options={FOLLOW_OPTIONS} placeholder="" className="w-[180px]" aria-label={t('chat.notify.mobilePush')} />
          </div>
          <div className="flex min-h-12 items-center gap-2 px-1 text-[15px]">
            <span className="flex-1">{t('chat.notify.email')}</span>
            <span className="text-[13px] text-muted-foreground">{emailLabel}</span>
          </div>
          <div className="flex min-h-12 items-center gap-2 px-1 text-[15px]">
            <span className="flex-1">{t('chat.notify.threadReplies')}</span>
            <UiSwitch modelValue={threadReplies} onUpdateModelValue={setThreadReplies} ariaLabel={t('chat.notify.threadReplies')} />
          </div>
          <p className="px-1 text-xs text-muted-foreground">{t('chat.notify.emailSavedOnly')}</p>
        </div>
      )}

      <div className={cn('flex flex-col gap-2 sm:gap-3', mobileDevices ? 'max-sm:hidden' : '')}>
        <p className="hidden text-xs font-semibold text-muted-foreground sm:block" id={`notify-legend-${ch.id}`}>{t('chat.notify.section')}</p>
        <div role="radiogroup" aria-labelledby={`notify-legend-${ch.id}`} className="flex flex-col gap-2 sm:gap-3">
          {OPTIONS.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              data-notify-opt={o.value}
              aria-checked={level === o.value}
              tabIndex={level === o.value ? 0 : -1}
              className={cn(
                'flex min-h-14 items-center gap-3 rounded-[12px] px-3.5 py-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:items-start sm:rounded-[10px] sm:p-3',
                level === o.value ? 'border-[1.5px] border-primary bg-primary/[0.08]' : 'border border-border hover:bg-accent/40',
              )}
              onClick={() => setLevel(o.value)}
              onKeyDown={(e) => onRadioKey(e, i)}
            >
              <span
                className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border-[1.5px] sm:mt-0.5 sm:h-4 sm:w-4', level === o.value ? 'border-primary' : 'border-muted-foreground')}
                aria-hidden="true"
              >
                {level === o.value && <span className="h-2.5 w-2.5 rounded-full bg-primary sm:h-2 sm:w-2" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold text-foreground sm:text-sm">
                  {o.title}
                  {o.isDefault && <>{' '}<span className="text-xs font-medium text-muted-foreground">{t('chat.notify.default')}</span></>}
                </span>
                {/* 데스크톱은 셋 다 설명, 모바일은 선택된 "멘션만"의 짧은 설명만 */}
                <span className="hidden text-[13px] text-muted-foreground sm:block">{o.desc}</span>
                {o.descShort && level === o.value && <span className="block text-[13px] text-muted-foreground sm:hidden">{o.descShort}</span>}
              </span>
            </button>
          ))}
        </div>

        {/* 기기별 세부 설정 — 데스크톱: 접힘(펼치기) */}
        <div className="hidden rounded-[10px] border border-border sm:block">
          <button
            type="button"
            className="flex h-10 w-full items-center gap-2 px-3 text-[13px] font-semibold text-foreground"
            aria-expanded={devicesOpen}
            aria-controls="notify-devices"
            onClick={() => setDevicesOpen(!devicesOpen)}
          >
            <span className="flex-1 text-left">{t('chat.notify.devices')}</span>
            <UiIcon name={devicesOpen ? 'chevron-up' : 'chevron-down'} className="h-3.5 w-3.5" />
          </button>
          {devicesOpen && (
            <div id="notify-devices" className="flex flex-col gap-2 px-3 pb-3 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="flex-1">{t('chat.notify.desktop')}</span>
                <UiSelect modelValue={desktopSel} onUpdateModelValue={setDesktopSel} options={FOLLOW_OPTIONS} placeholder="" size="sm" className="w-[200px]" aria-label={t('chat.notify.desktop')} />
              </div>
              <div className="flex items-center gap-2">
                <span className="flex-1">{t('chat.notify.mobilePush')}</span>
                <UiSelect modelValue={pushSel} onUpdateModelValue={setPushSel} options={FOLLOW_OPTIONS} placeholder="" size="sm" className="w-[200px]" aria-label={t('chat.notify.mobilePush')} />
              </div>
              <div className="flex items-center gap-2">
                <span className="flex-1">{t('chat.notify.email')}</span>
                <span
                  className="inline-flex h-8 w-[200px] cursor-not-allowed items-center justify-between gap-2 rounded-[10px] border border-input bg-muted/50 px-2.5 text-xs text-muted-foreground"
                  aria-disabled="true"
                  title={t('chat.notify.emailSavedOnly')}
                >{emailLabel}<UiIcon name="chevron-down" className="h-3 w-3" /></span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="flex-1">{t('chat.notify.threadReplies')}</span>
                <UiSwitch modelValue={threadReplies} onUpdateModelValue={setThreadReplies} ariaLabel={t('chat.notify.threadReplies')} />
              </div>
              <p className="text-xs text-muted-foreground">{t('chat.notify.emailSavedOnly')}</p>
            </div>
          )}
        </div>
        {/* 모바일: 다음 화면으로 */}
        <button
          type="button"
          className="flex min-h-12 items-center px-1 text-left text-[15px] text-foreground sm:hidden"
          onClick={() => setMobileDevices(true)}
        >
          <span className="flex-1">{t('chat.notify.devices')}</span>
          <span className="text-[13px] text-muted-foreground">{devicesSummary}</span>
          <UiIcon name="chevron-right" className="ml-1 h-4 w-4 text-muted-foreground" strokeWidth={2.5} />
        </button>
      </div>
    </UiModal>
  )
}

export default ChatNotifySheet
