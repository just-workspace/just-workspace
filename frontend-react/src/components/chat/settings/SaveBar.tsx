/**
 * 저장 안 된 변경 띠: 아래 떠 있는 카드(popover · 그림자 · 1px) — 문구 14/500 + 되돌리기(ghost) · 저장.
 * 디스코드처럼 변경이 있는데 다른 곳으로 가려 하면(settingsStore.requestLeave) 띠를 흔들고 잠시 danger 테두리.
 * reduce-motion 이면 흔들지 않고 테두리만. 섹션 끝에 sticky 로 붙는다(스크롤해도 아래에 보인다).
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiButton } from '~/components/ui/Button'
import { useSettingsUi } from './settingsStore'

export function SaveBar({ onRevert, onSave, saving, canSave = true, mobile = false }: {
  onRevert: () => void; onSave: () => void; saving?: boolean; canSave?: boolean; mobile?: boolean
}) {
  const { t } = useI18n()
  const tick = useSettingsUi(s => s.shakeTick)
  const ref = useRef<HTMLDivElement | null>(null)
  const [warn, setWarn] = useState(false)
  const first = useRef(tick)
  useEffect(() => {
    if (tick === first.current) return
    setWarn(true)
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!reduce) ref.current?.animate?.(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
      { duration: 360, easing: 'ease-in-out' },
    )
    const id = setTimeout(() => setWarn(false), 1200)
    return () => clearTimeout(id)
  }, [tick])
  return (
    <div className={cn('pointer-events-none sticky z-30 flex', mobile ? 'bottom-3 mt-3' : 'bottom-6 mt-6')}>
      <div
        ref={ref}
        role="status"
        data-save-bar=""
        className={cn(
          'pointer-events-auto flex w-full items-center gap-3 rounded-lg border bg-popover px-4 py-2.5 shadow-xl',
          mobile ? 'flex-wrap' : 'max-w-[760px]',
          warn ? 'border-danger' : 'border-border',
        )}
      >
        <span className={cn('min-w-0 flex-1 text-[14px] font-medium', warn ? 'text-danger' : '')}>{t('chat.settings.dirty.text')}</span>
        <UiButton type="button" variant="ghost" size="sm" onClick={onRevert}>{t('chat.settings.dirty.revert')}</UiButton>
        <UiButton type="button" size="sm" disabled={saving || !canSave} onClick={onSave}>{t('common.save')}</UiButton>
      </div>
    </div>
  )
}

export default SaveBar
