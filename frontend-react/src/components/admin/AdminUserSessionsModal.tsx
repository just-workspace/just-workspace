/**
 * 관리 › 사용자 ⋮ › 세션 보기 모달.
 * 상태(목록·불러오기·오류)는 페이지가 가지고, 이 조각은 그리기만 한다.
 * 행 56: 기기 아이콘 32 · 기기 이름(UA 추정) · IP(mono) · 호스트 · 마지막 활동 · [로그아웃]. 푸터 [모든 기기에서 로그아웃][닫기].
 */
import { useI18n } from '~/i18n'
import { UiModal } from '~/components/ui/Modal'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { deviceHint, fmtTs, nameOf, type AdminSessionInfo, type AdminUser } from './adminUsers'

export interface AdminUserSessionsModalProps {
  /** 세션을 보는 사용자(없으면 제목 이름 비움·푸터 로그아웃 숨김) */
  user: AdminUser | null
  /** 세션 목록 */
  sessions: AdminSessionInfo[]
  /** 불러오는 중 */
  loading: boolean
  /** 불러오기 실패 */
  error: boolean
  onClose?: () => void
  /** 다시 시도 */
  onRetry?: () => void
  /** 세션 하나 끊기 */
  onRevoke?: (s: AdminSessionInfo) => void
  /** 모든 기기에서 로그아웃 */
  onLogoutAll?: (u: AdminUser) => void
}

export function AdminUserSessionsModal({ user, sessions, loading, error, onClose, onRetry, onRevoke, onLogoutAll }: AdminUserSessionsModalProps) {
  const { t } = useI18n()
  const footer = (
    <>
      {user && <UiButton variant="outline" size="sm" className="mr-auto text-danger hover:text-danger" onClick={() => onLogoutAll?.(user)}>{t('admin.users.logoutEverywhere')}</UiButton>}
      <UiButton variant="outline" size="sm" onClick={() => onClose?.()}>{t('common.close')}</UiButton>
    </>
  )
  return (
    <UiModal title={t('admin.users.sessionsTitle', { name: user ? nameOf(user) : '' })} size="lg" onClose={() => onClose?.()} footer={footer}>
      <p className="text-[13px] text-muted-foreground">{t('admin.users.sessionsHint')}</p>
      {loading
        ? <UiSkeleton preset="list" rows={3} />
        : error
          ? <UiErrorTile placement="panel" title={t('admin.users.sessionsLoadError')} onRetry={() => onRetry?.()} />
          : !sessions.length
            ? <UiEmptyState variant="panel" icon="monitor" title={t('admin.users.noSessions')} />
            : (
              <div className="-mx-5 border-t border-border">
                {sessions.map(s => (
                  <div key={s.sid} className="flex min-h-14 items-center gap-3 border-b border-border px-5 text-[13px] last:border-b-0">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground"><UiIcon name={/Android|iPhone|iPad/i.test(s.ua) ? 'smartphone' : 'monitor'} className="h-[15px] w-[15px]" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-foreground">{deviceHint(s.ua, t)}</div>
                      <div className="truncate text-xs text-muted-foreground"><span className="font-mono">{s.ip || '—'}</span>{s.hostname && <span> · {s.hostname}</span>} · {fmtTs(s.last_seen)}</div>
                    </div>
                    <button type="button" className="relative shrink-0 text-xs font-semibold text-danger hover:underline after:absolute after:-inset-3 after:content-['']" onClick={() => onRevoke?.(s)}>{t('auth.logout')}</button>
                  </div>
                ))}
              </div>
            )}
    </UiModal>
  )
}

export default AdminUserSessionsModal
