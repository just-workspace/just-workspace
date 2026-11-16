/**
 * 권한 모드 칩 — 입력창 도구 줄(Claude Code 의 "⏵⏵ accept edits on · shift+tab to cycle" 위치).
 * 클릭 시 다섯 모드 메뉴 표시, Shift+Tab(입력창)으로 순환. bypass 는 빨강, auto·acceptEdits 는 강조, plan 은 파랑.
 */
import { useEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiMenu } from '~/components/ui/Menu'
import { UiIcon } from '~/components/ui/Icon'
import { AiPermissionRules } from '~/components/ai/AiPermissionRules'
import { PERMISSION_MODES, loadPermissionMode, setPermissionMode, usePermissionMode, type PermissionMode } from '~/composables/usePermissionMode'

const ICON: Record<PermissionMode, string> = {
  default: 'shield', acceptEdits: 'check', plan: 'list', auto: 'zap', bypassPermissions: 'alert-triangle',
}
const TONE: Record<PermissionMode, string> = {
  default: 'text-muted-foreground border-border',
  acceptEdits: 'text-success border-success/40 bg-success/10',
  plan: 'text-primary border-primary/40 bg-primary/10',
  auto: 'text-warning border-warning/40 bg-warning/10',
  bypassPermissions: 'text-danger border-danger/50 bg-danger/10',
}

export function AiPermissionMode({ disabled, conversationId }: { disabled?: boolean; conversationId?: string | null }) {
  const { t } = useI18n()
  const mode = usePermissionMode()
  useEffect(() => { void loadPermissionMode() }, [])
  const [rulesOpen, setRulesOpen] = useState(false)
  const items = [
    ...PERMISSION_MODES.map((m, i) => ({
      key: m, label: t(`ai.perm.mode.${m}`), description: t(`ai.perm.desc.${m}`), icon: ICON[m],
      checked: m === mode, radio: true, danger: m === 'bypassPermissions', separated: i === PERMISSION_MODES.length - 1,
    })),
    // Claude Code /permissions — 허용·거부 규칙
    { key: '__rules', label: t('ai.rules.menu'), description: t('ai.rules.menuDesc'), icon: 'settings', separated: true },
  ]
  return (
    <>
    {rulesOpen && <AiPermissionRules conversationId={conversationId} onClose={() => setRulesOpen(false)} />}
    <UiMenu
      items={items} label={t('ai.perm.label')} width={300} side="top" align="start"
      onSelect={(k: string) => { if (k === '__rules') setRulesOpen(true); else void setPermissionMode(k as PermissionMode) }}
      trigger={({ toggle, open, controls }) => (
        <button
          type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={controls}
          title={t('ai.perm.cycleHint')}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-[8px] border px-2 text-xs font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', TONE[mode])}
          onClick={toggle}
        >
          <UiIcon name={ICON[mode]} className="h-3.5 w-3.5" />
          <span>{t(`ai.perm.mode.${mode}`)}</span>
        </button>
      )}
    />
    </>
  )
}
