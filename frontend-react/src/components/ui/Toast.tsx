/**
 * 토스트 호스트: 반전색 바탕(foreground/background), 제목 600 + 본문 12 opacity .8,
 * 행동 1개(링크형, --primary-inverse 글자 — 반전 바탕 위 4.5:1 로 보정된 반대 테마 강조색),
 * 아이콘은 종류 색. 데스크톱 왼쪽 아래 24, 모바일은 상단(상단바 아래 8 — 탭바·FAB 와 경쟁하지 않음).
 * role=status(오류는 alert). 오류·수동 닫기 토스트에만 닫기 버튼. 같은 오류가 합쳐지면 제목 뒤에 횟수(mono 11).
 * 앱 루트(App.tsx)에 한 번 그린다. 토스트 내기는 `addToast`/`toast`(~/composables/useToast).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useToast, type Toast, type ToastType } from '~/composables/useToast'
import { useSidebar } from '~/composables/useSidebar'
import { useAuth } from '~/composables/useAuth'
import { UiIcon } from './Icon'
import { transitionClass, useTransition } from './internal'

const ICON: Record<ToastType, { name: string; cls: string }> = {
  success: { name: 'check', cls: 'text-success' },
  error: { name: 'alert-circle', cls: 'text-danger' },
  warning: { name: 'alert-triangle', cls: 'text-warning' },
  info: { name: 'info', cls: 'text-primary' },
}

const LEAVE_MS = 150

/**
 * 토스트 목록(전역 1개).
 * @example <UiToast />  — App.tsx 루트에서만
 */
export function UiToast() {
  const { toasts } = useToast()
  // 데스크톱 왼쪽 아래는 레일(64)·고정 사이드바(236) 오른쪽으로 24 띄운다 — 레일 하단 아바타를 덮지 않게(QA 토스트)
  const { pushes } = useSidebar()
  const { user } = useAuth()
  const leftClass = !user ? 'sm:left-6' : pushes ? 'sm:left-6 md:left-[260px]' : 'sm:left-6 md:left-[88px]'

  // TransitionGroup: 사라진 토스트는 leave 애니메이션 동안 제자리에 남긴다
  const [rendered, setRendered] = useState<{ t: Toast; leaving: boolean }[]>(() => toasts.map(t => ({ t, leaving: false })))
  useEffect(() => {
    setRendered((prev) => {
      const ids = new Set(toasts.map(t => t.id))
      const next: { t: Toast; leaving: boolean }[] = toasts.map(t => ({ t, leaving: false }))
      prev.forEach((p, i) => {
        if (!ids.has(p.t.id)) next.splice(Math.min(i, next.length), 0, { t: p.t, leaving: true })
      })
      return next
    })
  }, [toasts])
  const leavingKey = rendered.filter(r => r.leaving).map(r => r.t.id).join(',')
  useEffect(() => {
    if (!leavingKey) return
    const tm = setTimeout(() => setRendered(prev => prev.filter(r => !r.leaving)), LEAVE_MS)
    return () => clearTimeout(tm)
  }, [leavingKey])

  return createPortal(
    <div
      className={cn('pointer-events-none fixed inset-x-3 top-[calc(56px+env(safe-area-inset-top)+8px)] z-toast flex flex-col gap-2 sm:inset-x-auto sm:bottom-6 sm:top-auto sm:w-[380px]', leftClass)}
    >
      {rendered.map(r => <ToastRow key={r.t.id} t={r.t} leaving={r.leaving} />)}
    </div>,
    document.body,
  )
}

function ToastRow({ t: tst, leaving }: { t: Toast; leaving: boolean }) {
  const { t } = useI18n()
  const { removeToast } = useToast()
  const tr = useTransition(!leaving, 200, LEAVE_MS, true)
  const trClass = transitionClass(tr.phase, {
    enterActive: 'transition-all duration-200 ease-out',
    enterFrom: 'opacity-0 -translate-y-2 sm:translate-y-2',
    enterTo: 'opacity-100 translate-y-0',
    leaveActive: 'transition-all duration-150 ease-in',
    leaveFrom: 'opacity-100',
    leaveTo: 'opacity-0',
  })

  async function runAction(id: string, fn: () => void | Promise<void>) {
    try { await fn() } finally { removeToast(id) }
  }

  return (
    <div
      role={tst.type === 'error' ? 'alert' : 'status'}
      className={cn('pointer-events-auto flex items-center gap-2.5 rounded-lg bg-foreground py-2.5 pl-3.5 pr-2 text-[13px] text-background shadow-md', trClass)}
    >
      <UiIcon name={ICON[tst.type].name} className={cn('h-4 w-4 shrink-0', ICON[tst.type].cls)} strokeWidth={2.4} />
      <div className="min-w-0 flex-1">
        <p className={tst.description ? 'font-semibold' : ''}>{tst.message}{(tst.count ?? 1) > 1 && <span className="ml-1.5 font-mono text-[11px] font-semibold opacity-70">{t('common.repeatCount', { n: tst.count })}</span>}</p>
        {tst.description && <p className="truncate text-xs opacity-80">{tst.description}</p>}
      </div>
      {tst.action && (
        <button
          type="button"
          className="shrink-0 rounded-sm px-2.5 py-1.5 font-semibold text-primary-inverse underline-offset-4 hover:bg-background/10 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-inverse"
          onClick={() => { void runAction(tst.id, tst.action!.onClick) }}
        >{tst.action.label}</button>
      )}
      {(tst.duration === 0 || tst.type === 'error') && (
        <button
          type="button"
          aria-label={t('common.close')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-sm opacity-70 hover:bg-background/10 hover:opacity-100"
          onClick={() => removeToast(tst.id)}
        >
          <UiIcon name="close" className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

export default UiToast
