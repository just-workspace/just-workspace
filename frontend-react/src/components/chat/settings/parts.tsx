/**
 * 채팅 설정 공용 조각 — 섹션 머리(데스크톱 제목 20/600 + 설명 14 + 닫기 ESC), 모바일 머리(뒤로 44 · 17/600 · +),
 * 안내 띠(banner: warn · info · danger), 설정 화면 맥락(모바일 여부 · 닫기 · 모바일 뒤로).
 * 시안: Settings22.dc.html 머리·banner·모바일 header.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { errorStatus } from '~/lib/api'

export interface SettingsCtxValue {
  mobile: boolean
  /** 설정 화면 닫기(변경이 있으면 확인) */
  close: () => void
  /** 모바일: 섹션 목록으로 */
  backToMenu: () => void
}
export const SettingsCtx = createContext<SettingsCtxValue>({ mobile: false, close: () => {}, backToMenu: () => {} })
export const useSettingsCtx = () => useContext(SettingsCtx)

/** 데스크톱 섹션 머리 — 제목 · 설명 · 닫기(ESC) */
export function SettingsHeader({ title, sub }: { title: string; sub?: string }) {
  const { t } = useI18n()
  const { close } = useSettingsCtx()
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[20px] font-semibold">{title}</h2>
        {sub && <p className="mt-1 text-[14px] text-muted-foreground">{sub}</p>}
      </div>
      <button
        type="button"
        aria-label={t('chat.settings.closeEsc')}
        className="flex shrink-0 flex-col items-center gap-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={close}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-muted-foreground/60">
          <UiIcon name="close" className="h-4 w-4" />
        </span>
        ESC
      </button>
    </div>
  )
}

/** 모바일 머리 56 — 뒤로 44 · 제목 17/600 · 오른쪽 + (선택) */
export function MobileHeader({ title, onBack, addLabel, onAdd }: { title: string; onBack: () => void; addLabel?: string; onAdd?: () => void }) {
  const { t } = useI18n()
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-1">
      <UiIconButton icon="chevron-left" label={t('common.back')} size="lg" onClick={onBack} />
      <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</h2>
      {addLabel && onAdd && <UiIconButton icon="plus" label={addLabel} size="lg" onClick={onAdd} />}
    </header>
  )
}

export type BannerTone = 'warn' | 'info' | 'danger'
const TONE: Record<BannerTone, string> = {
  warn: 'border-warning/60 bg-warning/10',
  info: 'border-border bg-card',
  danger: 'border-danger/60 bg-danger/10',
}
/** 안내 띠 — 아이콘 16 · 글 13 · 오른쪽 버튼(xs outline) */
export function SettingsBanner({ tone, icon, children, action, onAction, className }: {
  tone: BannerTone; icon: string; children: ReactNode; action?: string; onAction?: () => void; className?: string
}) {
  return (
    <div role="status" className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]', TONE[tone], className)}>
      <UiIcon name={icon} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action && onAction && <UiButton type="button" variant="outline" size="xs" onClick={onAction}>{action}</UiButton>}
    </div>
  )
}

/** 역할 색 점(12) — 색 없음이면 muted-foreground */
export function RoleDot({ index, className }: { index: number; className?: string }) {
  return <span aria-hidden="true" className={cn('relative h-3 w-3 shrink-0 rounded-full', index ? ROLE_DOT[index - 1] : 'bg-muted-foreground', className)} />
}
const ROLE_DOT = ['bg-role-1', 'bg-role-2', 'bg-role-3', 'bg-role-4', 'bg-role-5', 'bg-role-6', 'bg-role-7', 'bg-role-8']
export const ROLE_TEXT = ['text-role-1', 'text-role-2', 'text-role-3', 'text-role-4', 'text-role-5', 'text-role-6', 'text-role-7', 'text-role-8']

/** 서버 오류 → 사람이 읽을 문구(detail 문자열 또는 {message}) */
export function errorText(e: unknown, fallback: string): string {
  const d = (e as { data?: { detail?: unknown } })?.data?.detail
  if (typeof d === 'string' && d) return d
  if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string') return (d as { message: string }).message
  return fallback
}
export const statusOf = (e: unknown): number => errorStatus(e) ?? 0
