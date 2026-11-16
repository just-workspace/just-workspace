/**
 * 사용자 메뉴: 288, bg-popover rounded-lg shadow-md p-1, z-dropdown.
 * 머리(아바타 40 + 상태점 12) → 상태 메시지 줄 → 상태 세그먼트(온라인·자리 비움·방해 금지) → 프로필·설정
 * → 테마 세그먼트·언어 → 단축키 도움말(Ctrl /)·관리 콘솔 → 로그아웃. 메뉴 행 36(아이콘 16 + 글자).
 * 상태는 서버(/api/chat/me/status) 기준 — useMyStatus.
 *
 * 상태 메시지 줄: 이모지 · 문구 · "15:00까지 · 방해 금지 1시간" · ›. 선택 시 메뉴 왼쪽에 UiMenu 펼침 패널 표시
 * (자유 내용 + 메뉴 행, 폭 320): 이모지 버튼 + 문구 입력(n / 60) · 빠른 문구 칩 · 지우기 선택(+시각) · [지우기][저장]
 * / 방해 금지 세그먼트(끄기·30분·1·2·4시간) / 방해 금지 일정…(설정 › 알림) / 표시: 오프라인으로 표시.
 *   참고: 테마·언어·관리 콘솔 줄은 디자인 시안에 없으나 기존 기능이므로 동일 행 규격으로 유지함.
 *   이모지 선택: 이모지 버튼(pressed) → 테두리 상자 "최근 · 자주 쓰는" + 8×2(36 칸).
 *   1줄 = 최근 사용 항목(사용자 단위 서버 저장 ui.status_emoji_recent), 2줄 = 기본 추천 — 최근 항목이 8개 미만이면 기본 추천으로 보충함.
 *   선택한 칸 bg-accent + ring-primary. 전체 이모지 선택기는 미제공 — 입력 칸에 직접 붙여넣기. 8×2 수용을 위해 패널 폭 360(시안).
 */
import { useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useRbiLauncher } from '~/composables/useRbiLauncher'
import { useMyStatus } from '~/composables/useMyStatus'
import { openShortcuts } from '~/composables/useShell'
import { useColorMode } from '~/composables/useColorMode'
import { pushStatusEmojiRecent, useUserPrefs } from '~/composables/useUserPrefs'
import { addToast } from '~/composables/useToast'
import {
  STATUS_TEXT_MAX, DND_SEGMENT_MINUTES, statusEmojiCells, dndLeft, dndSegmentValue, hhmmOf, statusClearAt, statusClearFrom, type StatusClear,
} from '~/utils/myStatus'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiInput } from '~/components/ui/Input'
import { UiChip } from '~/components/ui/Chip'
import { UiSelect } from '~/components/ui/Select'
import { UiButton } from '~/components/ui/Button'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'

export interface LayoutUserMenuProps {
  /** 메뉴 닫힘 시 호출(항목 선택·Esc) */
  onClose?: () => void
}

/** 빠른 문구(이모지 + 문구 키) */
const PRESETS = [
  { emoji: '🗓', key: 'presetMeeting' },
  { emoji: '🚌', key: 'presetCommute' },
  { emoji: '🤒', key: 'presetSick' },
  { emoji: '🌴', key: 'presetVacation' },
] as const

const rowCls = 'flex min-h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left outline-hidden hover:bg-accent focus-visible:bg-accent'

export function LayoutUserMenu({ onClose }: LayoutUserMenuProps) {
  const emitClose = () => onClose?.()
  const { user, logout } = useAuth()
  const rbiUrl = useRbiLauncher()
  const my = useMyStatus()
  const presence = my.presence
  const colorMode = useColorMode()
  const { t, locale, locales, setLocale } = useI18n()
  const { prefs } = useUserPrefs()
  const emojiCells = statusEmojiCells(prefs.statusEmojiRecent)

  const displayName = user?.display_name || user?.username || ''
  const initial = (displayName || 'U').charAt(0).toUpperCase()
  const email = user?.primary_email || user?.email || ''

  const PRESENCE = [
    { value: 'online', label: t('ui.status.online') },
    { value: 'away', label: t('ui.status.away') },
    { value: 'dnd', label: t('ui.status.dnd') },
  ]

  const THEME = [
    { value: 'light', label: t('shell.userMenu.themeLight') },
    { value: 'dark', label: t('shell.userMenu.themeDark') },
    { value: 'system', label: t('shell.userMenu.themeSystem') },
  ]

  const localeName = locales.find(l => l.code === locale)?.name ?? locale
  function nextLocale() {
    const codes = locales.map(l => l.code)
    const i = codes.indexOf(locale)
    void setLocale(codes[(i + 1) % codes.length])
  }

  async function run(fn: () => Promise<unknown> | unknown): Promise<boolean> {
    try { await fn(); return true } catch { addToast('error', t('shell.userMenu.statusFailed')); return false }
  }

  function go(to: string) { emitClose(); void navigateTo(to) }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') emitClose() }

  const msg = my.message
  const now = Date.now()
  const dndOn = presence === 'dnd'
  const left = dndOn ? dndLeft(my.dndUntil, now) : null

  // ── 상태 메시지 펼침 패널 ──
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const [panelAt, setPanelAt] = useState<DOMRect | null>(null)
  const [panelRight, setPanelRight] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [draftEmoji, setDraftEmoji] = useState<string | null>(null)
  const [clearChoice, setClearChoice] = useState<StatusClear>('never')
  const [clearTime, setClearTime] = useState('')
  const [pickEmoji, setPickEmoji] = useState(false)
  const [saving, setSaving] = useState(false)

  function openPanel() {
    const row = rowRef.current?.getBoundingClientRect()
    const menu = rootRef.current?.getBoundingClientRect()
    if (!row || !menu) return
    // 패널의 오른쪽 위 모서리를 메뉴 왼쪽 8 · 줄 위 5 위치에 배치(UiMenu 기준형은 기준 오른쪽 끝·아래 4 에 배치됨)
    // 왼쪽 공간이 부족하면(채팅 목록 아래 계정 패널처럼 메뉴가 화면 왼쪽 끝에 위치) 오른쪽에 배치 — 미적용 시 패널이 메뉴를 가림
    const fitsLeft = menu.left - 8 - 360 >= 8
    setPanelRight(!fitsLeft)
    setPanelAt(new DOMRect(fitsLeft ? menu.left - 8 : menu.right + 8, row.top - 9, 0, 0))
    setDraftText(msg.text)
    setDraftEmoji(msg.emoji)
    const c = statusClearFrom(msg.expiresAt)
    setClearChoice(c.choice)
    setClearTime(c.time)
    setPickEmoji(false)
  }
  const closePanel = () => setPanelAt(null)

  async function saveDraft(close: () => void) {
    const text = draftText.trim().slice(0, STATUS_TEXT_MAX)
    setSaving(true)
    const ok = await run(() => my.saveMessage(text, text ? draftEmoji : null, text ? statusClearAt(clearChoice, clearTime, Date.now()) : null))
    setSaving(false)
    if (ok && text && draftEmoji) pushStatusEmojiRecent(draftEmoji)
    if (ok) close()
  }
  async function clearDraft(close: () => void) {
    setSaving(true)
    const ok = await run(my.clearMessage)
    setSaving(false)
    if (ok) close()
  }

  const CLEAR_OPTS = [
    { value: 'never', label: t('shell.userMenu.clearNever') },
    { value: '30m', label: t('shell.userMenu.clear30m') },
    { value: '1h', label: t('shell.userMenu.clear1h') },
    { value: 'today', label: t('shell.userMenu.clearToday') },
    { value: 'time', label: t('shell.userMenu.clearTime') },
  ]
  const DND_ITEMS = DND_SEGMENT_MINUTES.map(m => ({
    value: m,
    label: m === 0 ? t('shell.userMenu.dndOff') : m < 60 ? t('shell.userMenu.dndSegMin', { n: m }) : t('shell.userMenu.dndSegHour', { n: m / 60 }),
  }))

  const panelItems: UiMenuItem[] = [
    { key: 'dnd-schedule', label: t('shell.userMenu.dndSchedule'), icon: 'clock', hint: t('shell.userMenu.dndScheduleHint'), to: '/settings/notifications' },
    ...(my.server ? [
      { key: 'display', label: t('shell.userMenu.display'), heading: true },
      { key: 'invisible', label: t('shell.userMenu.appearOffline'), icon: 'eye-off', checked: my.invisible },
    ] : []),
  ]

  function onPanelSelect(key: string) {
    if (key === 'dnd-schedule') emitClose()
    else if (key === 'invisible') void run(() => my.setInvisible(!my.invisible))
  }

  const tooLong = draftText.length > STATUS_TEXT_MAX

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={t('shell.userMenu.label')}
      className="w-72 overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] text-foreground shadow-md"
      onKeyDown={onKey}
    >
      {/* 머리 */}
      <div className="flex items-center gap-2.5 p-2.5">
        <span className="relative inline-flex shrink-0">
          <UiAvatar src={user?.avatar_url} alt={displayName} fallback={initial} className="h-10 w-10" textSize={15} />
          <UiStatusDot status={my.dot} size={12} ring="card" className="absolute -bottom-0.5 -right-0.5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{displayName}</div>
          {/* 이메일 · 관리자 — 이메일이 없으면 앞 구분점 없이 역할만 표시 */}
          <div className="truncate text-xs text-muted-foreground">{[email, user?.is_admin ? t('common.role.admin') : ''].filter(Boolean).join(' · ')}</div>
        </div>
      </div>

      {/* 상태 메시지 줄 — 선택 시 왼쪽에 펼침 패널 표시 */}
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={!!panelAt}
        className={cn(
          'mx-1 mb-2 flex min-h-9 w-[calc(100%-8px)] items-center gap-2 rounded-md border border-border px-2.5 py-1 text-left outline-hidden hover:bg-accent focus-visible:bg-accent',
          panelAt ? 'bg-accent' : '',
        )}
        onClick={() => { if (panelAt) closePanel(); else openPanel() }}
      >
        {msg.text && msg.emoji
          ? <span aria-hidden="true">{msg.emoji}</span>
          : <UiIcon name="smile" className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', msg.text ? 'font-medium' : 'text-muted-foreground')}>{msg.text || t('shell.userMenu.setStatus')}</span>
          {((msg.text && msg.expiresAt) || dndOn) && (
            <span className="block truncate text-[11px] text-muted-foreground">
              {msg.text && msg.expiresAt && <><span className="font-mono">{hhmmOf(msg.expiresAt)}</span>{t('shell.userMenu.until')}</>}
              {msg.text && msg.expiresAt && dndOn && ' · '}
              {dndOn && (
                <>
                  {t('ui.status.dnd')}
                  {left && <> <span className="font-mono">{left.n}</span>{left.unit === 'h' ? t('shell.userMenu.unitHour') : t('shell.userMenu.unitMin')}</>}
                </>
              )}
            </span>
          )}
        </span>
        <UiIcon name="chevron-right" className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {panelAt && (
        <UiMenu
          anchor={panelAt}
          align={panelRight ? 'start' : 'end'}
          width={360}
          label={t('shell.userMenu.statusTitle')}
          title={t('shell.userMenu.statusTitle')}
          items={panelItems}
          onSelect={onPanelSelect}
          onClose={closePanel}
          // 포털 내부 클릭이 문서까지 전파되면 상단바의 바깥 클릭 처리가 사용자 메뉴 전체를 닫음 — 패널 내부에서 전파 차단
          onClick={(e: ReactMouseEvent) => e.stopPropagation()}
          content={({ close }) => (
            <div className="flex flex-col gap-3 text-[13px]">
              <p className="text-[11px] font-semibold text-muted-foreground">{t('shell.userMenu.statusTitle')}</p>
              <div className="flex gap-2">
                <UiIconButton
                  label={t('shell.userMenu.pickEmoji')}
                  variant="outline"
                  size="md"
                  aria-expanded={pickEmoji}
                  pressed={pickEmoji}
                  onClick={() => setPickEmoji(!pickEmoji)}
                >
                  {draftEmoji ? <span className="text-base" aria-hidden="true">{draftEmoji}</span> : <UiIcon name="smile" />}
                </UiIconButton>
                <UiInput
                  modelValue={draftText}
                  onUpdateModelValue={setDraftText}
                  aria-label={t('shell.userMenu.statusText')}
                  placeholder={t('shell.userMenu.statusPlaceholder')}
                  className="flex-1"
                  error={tooLong ? `${draftText.length} / ${STATUS_TEXT_MAX}` : undefined}
                  hint={`${draftText.length} / ${STATUS_TEXT_MAX}`}
                  maxLength={STATUS_TEXT_MAX}
                  data-autofocus=""
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !tooLong) { e.preventDefault(); void saveDraft(close) }
                  }}
                />
              </div>
              {pickEmoji && (
                <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                  <p className="px-1 text-[11px] font-semibold text-muted-foreground">{t('shell.userMenu.emojiRecent')}</p>
                  <div role="group" aria-label={t('shell.userMenu.pickEmoji')} className="grid grid-cols-8 gap-0.5">
                    {emojiCells.map(e => (
                      <button
                        key={e}
                        type="button"
                        aria-label={e}
                        aria-pressed={draftEmoji === e}
                        className={cn('grid h-9 w-9 place-items-center rounded-sm text-lg hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', draftEmoji === e ? 'bg-accent ring-1 ring-primary' : '')}
                        onClick={() => { setDraftEmoji(e); setPickEmoji(false) }}
                      >{e}</button>
                    ))}
                  </div>
                  <p className="px-1 text-[11px] text-muted-foreground">{t('shell.userMenu.emojiPasteHint')}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map(p => {
                  const label = t(`shell.userMenu.${p.key}`)
                  return (
                    <UiChip
                      key={p.key}
                      label={`${p.emoji} ${label}`}
                      size="sm"
                      variant="static"
                      onClick={() => { setDraftEmoji(p.emoji); setDraftText(label) }}
                    />
                  )
                })}
              </div>
              {/* 네이티브 선택 — 펼침 패널(스크롤 상자) 내부에서 목록 잘림 방지 */}
              <UiSelect
                label={t('shell.userMenu.clearLabel')}
                modelValue={clearChoice}
                onUpdateModelValue={v => {
                  const c = String(v) as StatusClear
                  setClearChoice(c)
                  if (c === 'time' && !clearTime) setClearTime(hhmmOf(new Date(Date.now() + 60 * 60_000)))
                }}
                options={CLEAR_OPTS}
                size="sm"
                native
              />
              <div className="flex items-center gap-2">
                {clearChoice === 'time' && (
                  <>
                    <span className="text-xs text-muted-foreground">{t('shell.userMenu.until')}</span>
                    <UiInput
                      type="time"
                      modelValue={clearTime}
                      onUpdateModelValue={setClearTime}
                      mono
                      aria-label={t('shell.userMenu.clearAt')}
                      className="w-28"
                    />
                  </>
                )}
                <span className="flex-1" />
                <UiButton variant="ghost" size="xs" disabled={saving} onClick={() => void clearDraft(close)}>{t('shell.userMenu.clearBtn')}</UiButton>
                <UiButton size="xs" disabled={saving || tooLong} onClick={() => void saveDraft(close)}>{t('common.save')}</UiButton>
              </div>
              <div className="-mx-2.5 h-px bg-border" role="separator" />
              <p className="px-1 text-[11px] font-semibold text-muted-foreground">{t('ui.status.dnd')}</p>
              <UiSegment
                size="sm"
                grow
                ariaLabel={t('ui.status.dnd')}
                modelValue={dndSegmentValue(dndOn, my.dndUntil, now)}
                onUpdateModelValue={v => { const m = Number(v); void run(() => my.setDndFor(m === 0 ? null : m)) }}
                items={DND_ITEMS}
              />
            </div>
          )}
        />
      )}

      {/* 상태 세그먼트 */}
      <div className="px-1 pb-2">
        <UiSegment
          size="sm"
          grow
          ariaLabel={t('shell.userMenu.presence')}
          modelValue={presence}
          onUpdateModelValue={v => { void run(() => my.setPresence(v as 'online' | 'away' | 'dnd')) }}
          items={PRESENCE}
        />
      </div>

      {/* 프로필 · 설정 */}
      <div className="-mx-1 my-1 h-px bg-border" role="separator" />
      <button type="button" role="menuitem" className={rowCls} onClick={() => go('/settings/account')}>
        <UiIcon name="user" className="h-4 w-4 shrink-0 text-muted-foreground" />{t('nav.profile')}
      </button>
      <button type="button" role="menuitem" className={rowCls} onClick={() => go('/settings')}>
        <UiIcon name="settings" className="h-4 w-4 shrink-0 text-muted-foreground" />{t('nav.settings')}
      </button>

      {/* 테마 · 언어 */}
      <div className="flex min-h-9 items-center gap-2 px-2.5">
        <UiIcon name="sun" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">{t('shell.userMenu.theme')}</span>
        <UiSegment
          modelValue={colorMode.preference}
          onUpdateModelValue={(v: string | number | null) => colorMode.setPreference(String(v))}
          items={THEME}
          size="sm"
          ariaLabel={t('shell.userMenu.theme')}
        />
      </div>
      <button type="button" role="menuitem" className={rowCls} onClick={nextLocale}>
        <UiIcon name="globe" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">{t('shell.userMenu.language')}</span>
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">{localeName}<UiIcon name="chevron-right" className="h-3.5 w-3.5" /></span>
      </button>

      {/* 단축키 · 관리 콘솔 · 로그아웃 */}
      <button type="button" role="menuitem" className={rowCls} onClick={() => { emitClose(); openShortcuts() }}>
        <UiIcon name="keyboard" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">{t('shell.userMenu.shortcuts')}</span>
        <span className="flex gap-0.5"><UiKeycap size={20}>Ctrl</UiKeycap><UiKeycap size={20}>/</UiKeycap></span>
      </button>
      {/* 격리 브라우저(전용 출처, 새 탭) — 사용 가능한 대상이 있을 때만 표시(레일은 '도구' 묶음 external 항목 · 모바일 탭에는 미표시) */}
      {rbiUrl && (
        <button type="button" role="menuitem" className={rowCls} onClick={() => { emitClose(); window.open(rbiUrl, '_blank', 'noopener,noreferrer') }}>
          <UiIcon name="shield" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">{t('shell.userMenu.openRbi')}</span>
          <UiIcon name="external-link" className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
      {user?.is_admin && (
        <button type="button" role="menuitem" className={rowCls} onClick={() => go('/admin')}>
          <UiIcon name="shield" className="h-4 w-4 shrink-0 text-muted-foreground" />{t('shell.userMenu.adminConsole')}
        </button>
      )}
      <button type="button" role="menuitem" className={rowCls} onClick={() => { emitClose(); void logout() }}>
        <UiIcon name="log-out" className="h-4 w-4 shrink-0 text-muted-foreground" />{t('auth.logout')}
      </button>
    </div>
  )
}

export default LayoutUserMenu
