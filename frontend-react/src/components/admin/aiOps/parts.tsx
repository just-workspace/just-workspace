// 관리자 › AI 운영 공용 컴포넌트 — 카드 틀·조회 실패(권한 포함)·출처/이유 라벨.
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { errorDetail, type AuditItem, type LoadError } from '~/utils/aiOps'

/** 시안의 카드: 1px border · 12 반지름 · card 바탕 */
export function OpsCard({ className, children, ...rest }: HTMLAttributes<HTMLElement> & { children?: ReactNode }) {
  return <section {...rest} className={cn('rounded-xl border border-border bg-card', className)}>{children}</section>
}

export function OpsTitle({ children, className }: { children?: ReactNode; className?: string }) {
  return <h2 className={cn('m-0 text-sm font-semibold', className)}>{children}</h2>
}

/** 조회 실패 — 403 이면 권한 상태(다시 시도 없음), 그 외에는 오류 타일 + 다시 시도 */
export function OpsLoadFailed({ error, title, onRetry, placement = 'card' }: { error: LoadError; title: string; onRetry?: () => void; placement?: 'card' | 'panel' }) {
  const { t } = useI18n()
  if (error.status === 403) {
    return <UiErrorTile placement={placement} title={t('aiOps.forbiddenTitle')} detail={t('aiOps.forbiddenDetail')} noRetry />
  }
  return <UiErrorTile placement={placement} title={title} detail={errorDetail(error)} retryLabel={t('aiOps.retry')} onRetry={onRetry} />
}

export function useOpsLabels() {
  const { t } = useI18n()
  const reasonLabel = (r: string) => {
    const k = `aiOps.reasons.${r}`
    const v = t(k)
    return v === k ? r : v
  }
  const resultLabel = (r: string) => {
    const k = `aiOps.audit.result.${r}`
    const v = t(k)
    return v === k ? r : v
  }
  /** 감사 행 출처 — "claude.ai · Claude" · "개인 토큰 “hana-macbook”" · "내장 AI · 웹" */
  const sourceLabel = (it: Pick<AuditItem, 'source' | 'client' | 'kind' | 'action'>) => {
    if (it.action?.startsWith('ai_feedback.')) return t('aiOps.audit.src.admin')
    const name = (it.client || '').trim()
    if (it.source === 'ai') {
      if (it.kind === 'builtin_desktop' || /데스크톱|desktop/i.test(name)) return t('aiOps.audit.src.builtinDesktop')
      if (it.kind === 'builtin_web' || /웹|web/i.test(name)) return t('aiOps.audit.src.builtinWeb')
      return t('aiOps.audit.src.builtin')
    }
    if (it.source === 'mcp') {
      if (it.kind === 'claude_app') return name ? t('aiOps.audit.src.claude', { name }) : t('aiOps.audit.src.claudeBare')
      if (it.kind === 'personal_token') return t('aiOps.audit.src.token', { name: name || '—' })
      return name ? t('aiOps.audit.src.connectorNamed', { name }) : t('aiOps.audit.src.connector')
    }
    if (it.source === 'plugin') return t('aiOps.audit.src.plugin')
    if (it.source === 'internal') return t('aiOps.audit.src.internal')
    return '—'
  }
  return { reasonLabel, resultLabel, sourceLabel }
}

/** 표 헤더 칸 공통 */
export const TH = 'px-2 py-2 text-xs font-semibold text-muted-foreground'
