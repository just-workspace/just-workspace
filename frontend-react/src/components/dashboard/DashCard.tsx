/**
 * 홈 대시보드 카드 공통 규격.
 *
 * 헤더 48: (편집 중 grip) · (AI 카드 sparkles) · 제목 14/600 · 개수(mono 12, 0·없음이면 미표시) · 여백 ·
 *          범위 토글(있을 때, muted 배경 탭) · "○○ 보기 ›"(항상 맨 오른쪽, xs primary).
 *          편집 중에는 범위 토글·보기 링크를 숨기고 [1칸|2칸] + 숨기기(eye-off), 관리자 고정은 lock "관리자 고정".
 * 행: 한 줄 44 / 두 줄 56(사용자·출처가 있는 항목) — DashRow. 한 카드 안에서 혼용하지 않는다.
 * 1차 행동: 행 맨 오른쪽(시각 뒤). [참여]는 항상 표시되는 primary, 읽음·완료·DM 은 호버/포커스 시에만 표시(터치 기기는 항상 표시).
 *
 * 높이: 열 쌓기(grid-auto-rows 4px)에 카드 높이가 필요하므로, 카드가 자신의 "본래 높이"(헤더+본문+푸터)를 측정하여
 * 대시보드에 보고한다(ResizeObserver). 주 줄은 확장된 높이를 사용하므로 본문과 푸터를 별도로 측정하고 사이 여백은 포함하지 않는다.
 *
 * 대시보드 외부(테스트·단독)에서도 렌더링되도록 컨텍스트 기본값은 no-op 이다.
 */
import { createContext, useContext, useEffect, useRef, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiButton } from '~/components/ui/Button'
import { useI18n } from '~/i18n'
import type { CardKey, CardSpan } from '~/lib/dashLayout'

/** 카드 상태 — empty 이면 대시보드가 맨 아래 "비어 있는 카드" 그룹으로 이동시킨다(주 줄 카드는 제자리 유지) */
export type CardStatus = 'loading' | 'ready' | 'empty' | 'error'
/** 빈 카드 그룹의 한 행을 카드가 변경하려는 경우(예: 메일 계정 없음) */
export interface EmptyNote { text?: string; linkLabel?: string; to?: string }

export interface DashCtxValue {
  editing: boolean
  /** 카드 행 수 상한(실효 높이) */
  maxRows: number
  /** 열 수(1 = 모바일) */
  cols: number
  report: (key: CardKey, status: CardStatus, note?: EmptyNote) => void
  reportHeight: (key: CardKey, px: number) => void
  spanOf: (key: CardKey) => CardSpan
  setSpan: (key: CardKey, span: CardSpan) => void
  hide: (key: CardKey) => void
  isLocked: (key: CardKey) => boolean
  /** 키보드로 한 칸 앞/뒤 이동 */
  step: (key: CardKey, delta: -1 | 1) => void
  dragStart: (key: CardKey) => void
}

const noop = () => {}
export const DashCtx = createContext<DashCtxValue>({
  editing: false, maxRows: 5, cols: 3, report: noop, reportHeight: noop, spanOf: () => 1, setSpan: noop, hide: noop,
  isLocked: () => false, step: noop, dragStart: noop,
})

export function useDash() { return useContext(DashCtx) }

/** 카드 상태를 대시보드에 보고 */
export function useCardStatus(key: CardKey, status: CardStatus, note?: EmptyNote) {
  const { report } = useDash()
  const text = note?.text, linkLabel = note?.linkLabel, to = note?.to
  useEffect(() => { report(key, status, text || linkLabel || to ? { text, linkLabel, to } : undefined) }, [report, key, status, text, linkLabel, to])
}

export interface DashScopeItem { value: string; label: string }

export interface DashCardProps {
  cardKey: CardKey
  title: string
  /** 헤더 개수(mono). 0·빈 값이면 미표시 */
  count?: number | string | null
  /** AI 카드 — 제목 앞 sparkles */
  ai?: boolean
  /** 범위 토글(헤더 오른쪽) */
  scope?: { items: DashScopeItem[]; value: string; onChange: (v: string) => void; label: string }
  /** "○○ 보기 ›" — to 가 있으면 링크, 없으면 버튼 */
  link?: { label: string; to?: string; onClick?: () => void }
  /** 헤더 오른쪽 끝 추가 행동(예: 시작하기 닫기) — 편집 중에는 숨김 */
  extra?: ReactNode
  /** 본문(행 목록 등) */
  children?: ReactNode
  /** 카드 푸터(확장된 카드에서 맨 아래에 고정 — AI 카드 생성 시각 행) */
  footer?: ReactNode
  /** 보드 밖 전폭 카드(시작하기) — 편집 중에도 드래그·1칸/2칸 없이 숨기기만 제공 */
  fixed?: boolean
  /** 헤더 제목 영역을 대체 렌더링한다(런처 카드 — 아이콘 타일 + 제목 + mono 부제). 지정 시 헤더는 48 고정 대신 p-5 상단 여백 적용 */
  head?: ReactNode
}

const TAB_ON = 'bg-background font-medium shadow-xs'
const TAB_OFF = 'text-muted-foreground'

export function DashCard({ cardKey, title, count, ai, scope, link, extra, children, footer, fixed, head }: DashCardProps) {
  const { t } = useI18n()
  const d = useDash()
  const topRef = useRef<HTMLDivElement | null>(null)
  const footRef = useRef<HTMLDivElement | null>(null)
  const locked = d.isLocked(cardKey)
  const free = d.editing && !locked
  const span = d.spanOf(cardKey)

  // 본래 높이 = 헤더+본문 + 푸터 + 테두리 2
  const { reportHeight } = d
  const hasFooter = footer != null
  useEffect(() => {
    const top = topRef.current
    if (!top) return
    const measure = () => { reportHeight(cardKey, (top.offsetHeight || 0) + (footRef.current?.offsetHeight || 0) + 2) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(top)
    if (footRef.current) ro.observe(footRef.current)
    return () => ro.disconnect()
  }, [reportHeight, cardKey, hasFooter])

  function onGripKey(e: KeyboardEvent) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); d.step(cardKey, -1) }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); d.step(cardKey, 1) }
  }
  function onDragStart(e: DragEvent) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', cardKey) } catch { /* 일부 브라우저 */ }
    d.dragStart(cardKey)
  }

  const shown = count != null && count !== '' && count !== 0 ? String(count) : ''
  return (
    <section
      aria-label={title}
      data-card={cardKey}
      className={cn('flex h-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground', free ? 'border-dashed border-primary/40' : 'border-border')}
    >
      <div ref={topRef} className="flex shrink-0 flex-col">
        <div className={cn('flex shrink-0 items-center gap-2', head ? 'px-5 pt-5' : 'h-12 px-4')}>
          {d.editing && !fixed && (
            <button
              type="button"
              draggable
              onDragStart={onDragStart}
              onKeyDown={onGripKey}
              aria-label={t('dashboard.d17.edit.grip', { title })}
              className="-ml-1 flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            ><UiIcon name="grip" className="h-4 w-4" /></button>
          )}
          {ai && <UiIcon name="sparkles" className="h-4 w-4 shrink-0 text-primary" />}
          {head ?? <h2 className="truncate text-[14px] font-semibold">{title}</h2>}
          {shown && <span className="font-mono text-xs text-muted-foreground">{shown}</span>}
          <span className="flex-1" />
          {scope && !d.editing && (
            <div role="tablist" aria-label={scope.label} className="flex shrink-0 rounded-md bg-muted p-0.5 text-xs">
              {scope.items.map(o => (
                <button
                  key={o.value}
                  type="button"
                  role="tab"
                  aria-selected={scope.value === o.value}
                  className={cn('rounded px-2 py-1 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', scope.value === o.value ? TAB_ON : TAB_OFF)}
                  onClick={() => scope.onChange(o.value)}
                >{o.label}</button>
              ))}
            </div>
          )}
          {link && !d.editing && (link.to
            ? <NuxtLink to={link.to} className="shrink-0 text-xs text-primary hover:underline">{link.label} ›</NuxtLink>
            : <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={link.onClick}>{link.label} ›</button>)}
          {extra && !d.editing && extra}
          {d.editing && locked && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground"><UiIcon name="lock" className="h-3.5 w-3.5" />{t('dashboard.d17.edit.locked')}</span>
          )}
          {free && (
            <>
              {d.cols > 1 && !fixed && (
                <div role="radiogroup" aria-label={t('dashboard.d17.edit.size')} className="flex rounded-md bg-muted p-0.5 text-xs">
                  {([1, 2] as const).map(n => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={span === n}
                      className={cn('rounded px-2 py-1 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', span === n ? 'bg-background font-medium' : 'text-muted-foreground')}
                      onClick={() => d.setSpan(cardKey, n)}
                    >{t(n === 1 ? 'dashboard.d17.edit.span1' : 'dashboard.d17.edit.span2')}</button>
                  ))}
                </div>
              )}
              <UiIconButton icon="eye-off" label={t('dashboard.d17.edit.hide')} size="sm" onClick={() => d.hide(cardKey)} />
            </>
          )}
        </div>
        {children}
      </div>
      {hasFooter && <span className="flex-1" />}
      {hasFooter && <div ref={footRef} className="shrink-0">{footer}</div>}
    </section>
  )
}

// ── 행 ──

export interface DashRowProps {
  /** 제목 */
  title: ReactNode
  /** 둘째 줄(있으면 56, 없으면 44) */
  meta?: ReactNode
  /** 이니셜 아바타(28) — 사진 주소는 avatarSrc */
  avatar?: string
  avatarSrc?: string | null
  /** 아바타 상태 점(bg-success 등) */
  dot?: string
  /** 종류 아이콘 */
  icon?: string
  iconClass?: string
  /** 제목 굵기·색(font-semibold · text-muted-foreground) */
  titleClass?: string
  /** 오른쪽 시각·값(mono 11) */
  time?: ReactNode
  timeClass?: string
  /** 행 배경(bg-primary/10 등) */
  className?: string
  /** 행을 누를 때 이동할 경로 */
  to?: string
  onOpen?: () => void
  /** 1차 행동 버튼(UiButton xs). persistent = 항상 표시([참여]), 그 외 호버/포커스 시에만 표시 */
  action?: { label: string; onClick: () => void; variant?: 'default' | 'outline' | 'ghost'; persistent?: boolean; disabled?: boolean }
  /** 아이콘 행동(호버/포커스 시에만 표시) */
  iconAction?: { icon: string; label: string; onClick: () => void }
  /** 접근성용 접두 문구(예: "읽지 않음: ") */
  srPrefix?: string
}

/** 호버·포커스 시에만 표시하며 터치 기기(hover 없음)는 항상 표시 */
const HOVER_ONLY = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'

export function DashRow({
  title, meta, avatar, avatarSrc, dot, icon, iconClass, titleClass, time, timeClass, className, to, onOpen, action, iconAction, srPrefix,
}: DashRowProps) {
  const body = (
    <>
      {(avatar != null || avatarSrc) && (
        <span className="relative shrink-0">
          <UiAvatar src={avatarSrc} fallback={avatar} textSize={11} className="h-7 w-7" />
          {dot && <span className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card', dot)} aria-hidden="true" />}
        </span>
      )}
      {icon && <UiIcon name={icon} className={cn('h-4 w-4 shrink-0', iconClass ?? 'text-muted-foreground')} />}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[13.5px]', titleClass)}>{srPrefix && <span className="sr-only">{srPrefix}</span>}{title}</span>
        {meta != null && meta !== '' && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
      </span>
    </>
  )
  const linkCls = 'flex min-w-0 flex-1 items-center gap-3 self-stretch focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
  return (
    <li className={cn('group flex shrink-0 items-center gap-3 border-t border-border px-4 hover:bg-accent/50', meta != null && meta !== '' ? 'h-14' : 'h-11', className)}>
      {to ? <NuxtLink to={to} className={linkCls} onClick={onOpen}>{body}</NuxtLink>
        : onOpen ? <button type="button" className={cn(linkCls, 'text-left')} onClick={onOpen}>{body}</button>
          : <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>}
      {time != null && time !== '' && <span className={cn('shrink-0 font-mono text-[11px]', timeClass ?? 'text-muted-foreground')}>{time}</span>}
      {action && (
        <UiButton
          variant={action.variant ?? 'ghost'}
          size="xs"
          disabled={action.disabled}
          className={action.persistent ? undefined : HOVER_ONLY}
          onClick={action.onClick}
        >{action.label}</UiButton>
      )}
      {iconAction && <UiIconButton icon={iconAction.icon} label={iconAction.label} size="sm" className={HOVER_ONLY} onClick={iconAction.onClick} />}
    </li>
  )
}

/** 행 목록 래퍼 */
export function DashRows({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return <ul className="flex flex-col" aria-busy={busy || undefined}>{children}</ul>
}

/** 카드 내 한 행 빈 상태(주 줄 카드) — 시안: 아이콘 + muted 제목 한 행 */
export function DashInlineEmpty({ icon, text }: { icon: string; text: string }) {
  return <DashRows><DashRow icon={icon} title={text} titleClass="text-muted-foreground" /></DashRows>
}

/** 행 스켈레톤(로딩) — 행 높이와 동일 */
export function DashRowsSkeleton({ rows = 3, twoLine = true }: { rows?: number; twoLine?: boolean }) {
  return (
    <ul className="flex flex-col" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className={cn('flex items-center gap-3 border-t border-border px-4', twoLine ? 'h-14' : 'h-11')}>
          <span className="h-4 w-4 shrink-0 animate-pulse rounded bg-muted" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-3/5 animate-pulse rounded bg-muted" />
            {twoLine && <span className="h-2.5 w-2/5 animate-pulse rounded bg-muted" />}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** 시각 표기: 오늘 HH:MM · 어제 · M/D */
export function shortTime(iso: string | null | undefined, yesterday: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  if (diff <= 0) return `${p(d.getHours())}:${p(d.getMinutes())}`
  if (diff === 1) return yesterday
  return `${d.getMonth() + 1}/${d.getDate()}`
}
