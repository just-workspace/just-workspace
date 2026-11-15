/**
 * 대시보드 머리(시안 Dash17): 왼쪽 h1 24/700 "좋은 아침이에요, 하늘 님" + 날짜 13.5 muted(요약은 칩 줄이 맡는다 — Q8),
 * 오른쪽 빠른 만들기 버튼 행 [메일 쓰기][일정][문서][파일 올리기][▾] · 구분선 · layout 아이콘 "대시보드 편집".
 * 3열 미만·모바일은 아이콘 2개(+ 새로 만들기 메뉴 · 편집).
 * 인사 문구는 관리 › 일반 "대시보드 문구·공지"(dash.greeting_mode: date 자동 / custom 직접 / none 숨김).
 * ▾·+ 메뉴 맨 위 항목은 dash.primary_action / primary_href(비우면 없음). 꺼진 모듈 항목은 숨긴다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { usePlatform } from '~/composables/usePlatform'
import { openCompose } from '~/composables/useMail'
import { addToast } from '~/composables/useToast'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'

export interface DashboardGreetingProps {
  /** 버튼 행(3열 이상 데스크톱) / 아이콘 2개 */
  wide: boolean
  editing: boolean
  onToggleEdit: () => void
  /** 편집 버튼 숨김(관리자 기본 배치 화면) */
  noEdit?: boolean
}

interface Action { key: string; label: string; icon: string; run: () => void }

export function DashboardGreeting({ wide, editing, onToggleEdit, noEdit }: DashboardGreetingProps) {
  const { t, locale } = useI18n()
  const { user } = useAuth()
  const { config } = useSiteConfig()
  const { isModuleEnabled } = usePlatform()
  const cfg = (k: string) => (config?.[k] ?? '').trim()

  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const timer = setInterval(() => { setNow(new Date()) }, 60_000)
    return () => clearInterval(timer)
  }, [])

  const greeting = (() => {
    if (!now) return t('greeting.hello')
    const h = now.getHours()
    if (h < 6) return t('greeting.lateNight')
    if (h < 12) return t('greeting.goodMorning')
    if (h < 18) return t('greeting.goodAfternoon')
    return t('greeting.goodEvening')
  })()
  const mode = cfg('dash.greeting_mode') || 'date'
  const title = mode === 'none'
    ? ''
    : mode === 'custom' && cfg('dash.greeting_text')
      ? cfg('dash.greeting_text')
      : t('greeting.withName', { greeting, name: user?.display_name || user?.username })
  const dateStr = now ? now.toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'long' }) : ''

  function newDoc() {
    const win = window.open('/office/open?new=doc&dir=my', '_blank')
    if (!win) addToast('error', t('files.page.popupBlocked'))
  }
  // 버튼 행 4개(시안) — 꺼진 모듈은 뺀다
  const main: Action[] = []
  if (isModuleEnabled('mail')) main.push({ key: 'mail', label: t('dashboard.shortcuts.composeMail'), icon: 'mail', run: () => openCompose('new') })
  if (isModuleEnabled('calendar')) main.push({ key: 'event', label: t('dashboard.header.newEvent'), icon: 'calendar', run: () => { void navigateTo('/calendar?new=1') } })
  if (isModuleEnabled('files')) {
    main.push({ key: 'doc', label: t('dashboard.d17.create.doc'), icon: 'file-doc', run: newDoc })
    main.push({ key: 'file', label: t('dashboard.header.uploadFile'), icon: 'upload', run: () => { void navigateTo('/files') } })
  }
  // ▾ 더 보기
  const more: Action[] = []
  const custom = cfg('dash.primary_action'), href = cfg('dash.primary_href')
  if (custom && href) more.push({ key: 'custom', label: custom, icon: 'star', run: () => { void navigateTo(href) } })
  if (isModuleEnabled('tasks')) more.push({ key: 'task', label: t('dashboard.header.newTask'), icon: 'check-square', run: () => { void navigateTo('/tasks') } })
  if (isModuleEnabled('wiki')) more.push({ key: 'wiki', label: t('dashboard.header.newWiki'), icon: 'book-open', run: () => { void navigateTo('/wiki') } })
  if (isModuleEnabled('board')) more.push({ key: 'post', label: t('dashboard.header.newPost'), icon: 'clipboard-list', run: () => { void navigateTo('/board') } })
  if (isModuleEnabled('meetings')) more.push({ key: 'meeting', label: t('nav.meetings'), icon: 'video', run: () => { void navigateTo('/meetings') } })

  const menuItems = (list: Action[]): UiMenuItem[] => list.map(a => ({ key: a.key, label: a.label, icon: a.icon }))
  const runKey = (list: Action[]) => (key: string) => { list.find(a => a.key === key)?.run() }
  const all = [...main, ...more]

  return (
    // 진짜 낮은 창(실효 높이 < 760 — handover 14 답 4)에선 인사 줄을 숨긴다. 버튼은 오른쪽에 남긴다
    <div className="flex items-end gap-4 low:justify-end">
      <div className="min-w-0 flex-1 low:hidden">
        {/* 좁은 폭에서 "검수 / 님"처럼 글자 단위로 끊기지 않게 keep-all + balance */}
        {title && <h1 className="text-2xl font-bold tracking-tight [text-wrap:balance] [word-break:keep-all]">{title}</h1>}
        <p className="mt-1 text-[13.5px] text-muted-foreground">{dateStr}</p>
      </div>
      {wide ? (
        <div className="flex shrink-0 items-center gap-2">
          {main.map(a => (
            <UiButton key={a.key} variant="outline" size="sm" icon={a.icon} onClick={a.run}>{a.label}</UiButton>
          ))}
          {more.length > 0 && (
            <UiMenu
              label={t('dashboard.d17.create.more')}
              items={menuItems(more)}
              width={200}
              onSelect={runKey(more)}
              trigger={({ toggle, open, controls }) => (
                <UiIconButton icon="chevron-down" label={t('dashboard.d17.create.more')} variant="outline" size="md" className="h-9 w-9" aria-expanded={open} aria-haspopup="menu" aria-controls={controls} onClick={toggle} />
              )}
            />
          )}
          {!noEdit && (
            <>
              <span className="mx-1 h-6 w-px bg-border" aria-hidden="true" />
              <UiIconButton icon="layout" label={t('dashboard.d17.edit.open')} size="md" className="h-9 w-9" pressed={editing} onClick={onToggleEdit} />
            </>
          )}
        </div>
      ) : (
        <div className="flex shrink-0 gap-1">
          {all.length > 0 && (
            <UiMenu
              label={t('dashboard.header.create')}
              items={menuItems(all)}
              width={200}
              onSelect={runKey(all)}
              trigger={({ toggle, open, controls }) => (
                <UiIconButton icon="plus" label={t('dashboard.header.create')} variant="outline" size="md" aria-expanded={open} aria-haspopup="menu" aria-controls={controls} onClick={toggle} />
              )}
            />
          )}
          {!noEdit && <UiIconButton icon="layout" label={t('dashboard.d17.edit.open')} size="md" pressed={editing} onClick={onToggleEdit} />}
        </div>
      )}
    </div>
  )
}

export default DashboardGreeting
