// 설정 › 채팅(시안 R12Settings #chat · S2) — React 에만 있는 화면(Vue 동결 뒤 신설).
//  ① 입력 카드: Enter 키 세그먼트(보내기 / 줄바꿈 — Ctrl+Enter 보내기) + 링크 미리보기 · 이미지·영상 자동 펼치기 스위치.
//  ② 알림 카드: 알림 키워드(제거 가능한 UiChip 이 든 입력, 최대 20개, Enter 로 추가) + 방해 금지 시간 스위치 + 시작·끝(mono).
//  모두 바로 저장 + "저장됨 ✓". 입력·키워드는 useUserPrefs → /api/me/prefs(chat.*), 키워드 판정은 서버(app/chat/keywords.py).
//  방해 금지 시간은 설정 › 알림의 방해 금지 일정(GET/PUT /api/notifications/dnd-schedule)과 같은 값 — 켜기·시간만 여기서 바꾸고
//  요일은 그대로 둔다(일정이 아직 없으면 매일).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useUserPrefs, setPref, MAX_CHAT_KEYWORDS, type ChatEnterKey, type Prefs } from '~/composables/useUserPrefs'
import { addKeyword, KEYWORD_MAX_LEN } from '~/utils/chatKeywords'
import { addToast } from '~/composables/useToast'
import { NuxtLink } from '~/components/NuxtLink'
import { UiCard } from '~/components/ui/Card'
import { UiCardHeader } from '~/components/ui/CardHeader'
import { UiCardTitle } from '~/components/ui/CardTitle'
import { UiCardContent } from '~/components/ui/CardContent'
import { UiSegment } from '~/components/ui/Segment'
import { UiSwitch } from '~/components/ui/Switch'
import { UiChip } from '~/components/ui/Chip'
import { UiInput } from '~/components/ui/Input'
import { UiTrans } from '~/components/ui/Trans'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsSavedMark } from '~/components/settings/SettingsSavedMark'

interface DndSchedule { enabled: boolean; days: number[]; start: string; end: string; timezone: string | null }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
function useFlash() {
  const [on, setOn] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  return [on, () => {
    setOn(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setOn(false) }, 2000)
  }] as const
}

export default function SettingsChatPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('settings.chatPrefs.title')} | ${appName}` })
  return (
    <>
      <SettingsHeader title={t('settings.chatPrefs.title')} subtitle={t('settings.chatPrefs.subtitle')} />
      <ChatInputPrefsCard />
      <ChatNotifyPrefsCard />
    </>
  )
}

/** ① 입력 카드 — 채팅 설정 화면(Settings22 "메시지 표시")에서도 재사용 */
export function ChatInputPrefsCard() {
  const { t } = useI18n()
  const { prefs } = useUserPrefs()
  const [savedInput, flashInput] = useFlash()
  function saveInput<K extends keyof Prefs>(k: K, v: Prefs[K]) { setPref(k, v); flashInput() }

  const ENTER = [
    { value: 'send', label: t('settings.chatPrefs.enterSend') },
    { value: 'newline', label: t('settings.chatPrefs.enterNewline') },
  ]

  return (
    <>
      {/* ① 입력 */}
      <UiCard>
        <UiCardHeader>
          <div className="flex items-center gap-3">
            <UiCardTitle className="flex-1">{t('settings.chatPrefs.inputTitle')}</UiCardTitle>
            {savedInput && <SettingsSavedMark />}
          </div>
        </UiCardHeader>
        <UiCardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">{t('settings.chatPrefs.enterKey')}</span>
            <UiSegment
              className="self-start"
              ariaLabel={t('settings.chatPrefs.enterKey')}
              modelValue={prefs.chatEnterKey}
              items={ENTER}
              onUpdateModelValue={v => saveInput('chatEnterKey', v as ChatEnterKey)}
            />
            <span className="text-xs text-muted-foreground">{t('settings.chatPrefs.enterHint')}</span>
          </div>
          <UiSwitch
            label={t('settings.chatPrefs.linkPreview')}
            description={t('settings.chatPrefs.linkPreviewDesc')}
            modelValue={prefs.chatLinkPreview}
            onUpdateModelValue={v => saveInput('chatLinkPreview', v)}
          />
          <UiSwitch
            label={t('settings.chatPrefs.mediaExpand')}
            description={t('settings.chatPrefs.mediaExpandDesc')}
            modelValue={prefs.chatMediaAutoExpand}
            onUpdateModelValue={v => saveInput('chatMediaAutoExpand', v)}
          />
        </UiCardContent>
      </UiCard>

    </>
  )
}

/** ② 알림 카드(키워드 · 방해 금지 시간) — 채팅 설정 화면(Settings22 "알림")에서도 재사용 */
export function ChatNotifyPrefsCard() {
  const { t } = useI18n()
  const { prefs } = useUserPrefs()
  const [savedNotify, flashNotify] = useFlash()
  // ── 키워드 ──
  const [draft, setDraft] = useState('')
  const [kwError, setKwError] = useState('')
  function commitDraft() {
    const r = addKeyword(prefs.chatKeywords, draft)
    if (r.error) { setKwError(r.error === 'full' ? t('settings.chatPrefs.keywordFull', { n: MAX_CHAT_KEYWORDS }) : t('settings.chatPrefs.keywordTooLong')); return }
    setDraft(''); setKwError('')
    if (r.list !== prefs.chatKeywords) { setPref('chatKeywords', r.list); flashNotify() }
  }
  function removeKeyword(k: string) {
    setPref('chatKeywords', prefs.chatKeywords.filter(x => x !== k))
    setKwError('')
    flashNotify()
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitDraft(); return }
    if (e.key === 'Backspace' && !draft && prefs.chatKeywords.length) removeKeyword(prefs.chatKeywords[prefs.chatKeywords.length - 1])
  }

  // ── 방해 금지 시간(설정 › 알림 일정과 같은 값) ──
  const [dnd, setDnd] = useState<DndSchedule | null>(null)
  const [start, setStart] = useState('22:00')
  const [end, setEnd] = useState('08:00')
  const [timeErr, setTimeErr] = useState<{ start?: string; end?: string }>({})
  const [dndBusy, setDndBusy] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void (async () => {
      try {
        const r = await $fetch<{ schedule?: DndSchedule }>('/api/notifications/dnd-schedule')
        if (r?.schedule) { setDnd(r.schedule); setStart(r.schedule.start || '22:00'); setEnd(r.schedule.end || '08:00') }
      } catch { /* 스위치만 비활성 */ }
    })()
  }, [])
  async function putDnd(patch: Partial<DndSchedule>) {
    const base: DndSchedule = dnd ?? { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], start, end, timezone: null }
    const days = base.days?.length ? base.days : [0, 1, 2, 3, 4, 5, 6]
    setDndBusy(true)
    try {
      const r = await $fetch<{ schedule: DndSchedule }>('/api/notifications/dnd-schedule', { method: 'PUT', body: { ...base, days, ...patch } })
      setDnd(r.schedule)
      flashNotify()
    } catch (e) {
      addToast('error', (e as { data?: { detail?: string } })?.data?.detail || t('error.genericError'))
    } finally { setDndBusy(false) }
  }
  function commitTime(which: 'start' | 'end') {
    const v = which === 'start' ? start : end
    if (!HHMM.test(v)) { setTimeErr(x => ({ ...x, [which]: t('settings.chatPrefs.dndBadTime') })); return }
    setTimeErr(x => ({ ...x, [which]: undefined }))
    if (dnd && dnd[which] === v) return
    void putDnd({ [which]: v })
  }

  return (
    <>
      {/* ② 알림 */}
      <UiCard>
        <UiCardHeader>
          <div className="flex items-center gap-3">
            <UiCardTitle className="flex-1">{t('settings.chatPrefs.notifyTitle')}</UiCardTitle>
            {savedNotify && <SettingsSavedMark />}
          </div>
          <p className="text-[13px] text-muted-foreground">{t('settings.chatPrefs.notifyDesc')}</p>
        </UiCardHeader>
        <UiCardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="chat-keyword-input" className="text-xs font-semibold text-muted-foreground">{t('settings.chatPrefs.keywords')}</label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background p-1.5">
              {prefs.chatKeywords.map(k => (
                <UiChip key={k} label={k} variant="static" removable size="sm" onRemove={() => removeKeyword(k)} />
              ))}
              <input
                id="chat-keyword-input"
                aria-label={t('settings.chatPrefs.keywordAdd')}
                placeholder={t('settings.chatPrefs.keywordPlaceholder')}
                className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
                value={draft}
                maxLength={KEYWORD_MAX_LEN + 10}
                aria-invalid={!!kwError || undefined}
                aria-describedby="chat-keyword-hint"
                onChange={e => { setDraft(e.target.value); if (kwError) setKwError('') }}
                onKeyDown={onKeyDown}
                onBlur={() => { if (draft.trim()) commitDraft() }}
              />
            </div>
            <span id="chat-keyword-hint" className={kwError ? 'text-xs text-danger' : 'text-xs text-muted-foreground'} role={kwError ? 'alert' : undefined}>
              {kwError || <UiTrans k="settings.chatPrefs.keywordHint" slots={{ n: <span className="font-mono">{MAX_CHAT_KEYWORDS}</span> }} />}
            </span>
          </div>
          <div className="grid items-end gap-4 sm:grid-cols-2">
            <UiSwitch
              label={t('settings.chatPrefs.dnd')}
              description={t('settings.chatPrefs.dndDesc')}
              modelValue={!!dnd?.enabled}
              disabled={!dnd || dndBusy}
              onUpdateModelValue={v => void putDnd({ enabled: v })}
            />
            <div className="flex items-center gap-2">
              <UiInput
                modelValue={start}
                onUpdateModelValue={setStart}
                mono
                aria-label={t('settings.chatPrefs.dndStart')}
                error={timeErr.start}
                disabled={!dnd || dndBusy}
                maxLength={5}
                inputMode="numeric"
                onBlur={() => commitTime('start')}
                onKeyDown={e => { if (e.key === 'Enter') commitTime('start') }}
              />
              <span className="text-muted-foreground">–</span>
              <UiInput
                modelValue={end}
                onUpdateModelValue={setEnd}
                mono
                aria-label={t('settings.chatPrefs.dndEnd')}
                error={timeErr.end}
                disabled={!dnd || dndBusy}
                maxLength={5}
                inputMode="numeric"
                onBlur={() => commitTime('end')}
                onKeyDown={e => { if (e.key === 'Enter') commitTime('end') }}
              />
            </div>
          </div>
          <UiTrans
            k="settings.chatPrefs.moreInNotify"
            as="p"
            className="text-xs text-muted-foreground"
            slots={{ link: (c) => <NuxtLink to="/settings/notifications" className="font-semibold text-primary hover:underline">{c}</NuxtLink> }}
          />
        </UiCardContent>
      </UiCard>
    </>
  )
}
