/**
 * 신뢰 상단 줄(단독 앱) — 격리 화면 밖, 원격 페이지가 닿을 수 없는 유일한 UI.
 *  세션 중: 대상 이름 · 원격 주소(읽기 전용 글자, 링크 아님) · 정책 배지 · 화면 방식(픽셀↔미러) · 연결/지연 · 세션 끝내기 · 사용자 메뉴
 *  세션 없음: 앱 이름 · 사용자 메뉴
 * 키보드: 격리 화면에 포커스가 있을 때 Ctrl+Alt+B 로 이 줄의 첫 단추로 온다(앱이 건다). 이 줄에서 Esc 면 다시 격리 화면으로.
 * TODO: 줄 높이·배지 밀도·주소 칸 폭·지연 표시 규격은 디자인 확정 뒤에. 지금은 기존 키트(UiBadge·UiButton·UiSegment·
 *   UiStatusDot·UiMenu·UiKeycap·UiIcon)와 다크 토큰만 쓴다.
 */
import { type KeyboardEvent, type Ref } from 'react'
import { useI18n } from '~/i18n'
import { rbiPolicyKeys, type RbiMode, type RbiPolicy, type RbiSession, type RbiSiteMe } from '~/composables/useRbi'
import type { RbiMirrorConn } from '~/components/rbi/RbiMirrorView'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiMenu } from '~/components/ui/Menu'
import { UiSegment } from '~/components/ui/Segment'
import { UiStatusDot } from '~/components/ui/StatusDot'

export interface RbiTrustedBarProps {
  me: RbiSiteMe | null
  session: RbiSession | null
  /** 원격 문서 주소(미러: 에이전트가 알려 준 지금 주소, 픽셀: 대상 주소) */
  url: string
  policy: RbiPolicy | null
  conn: RbiMirrorConn | null
  onSwitchMode: (m: RbiMode) => void
  onEnd: () => void
  onLogout: () => void
  /** 이 줄에서 Esc — 격리 화면으로 돌아간다 */
  onEscape?: () => void
  ref?: Ref<HTMLElement>
}

export function RbiTrustedBar({ me, session, url, policy, conn, onSwitchMode, onEnd, onLogout, onEscape, ref }: RbiTrustedBarProps) {
  const { t } = useI18n()
  const live = !!session && (session.status === 'running' || session.status === 'starting')
  const mode: RbiMode = session?.mode ?? 'pixel'
  const modes = session?.modes ?? []

  function onKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape' && !e.defaultPrevented && live) { e.preventDefault(); onEscape?.() }
  }

  let status: { dot: string; text: string } | null = null
  if (live && session) {
    if (session.status === 'starting') status = { dot: 'connecting', text: t('rbi.status.starting') }
    else if (mode === 'mirror') {
      status = conn?.connected
        ? { dot: 'online', text: t('rbi.mirror.connected') }
        : conn?.reason === 'replaced' ? { dot: 'offline', text: t('rbi.mirror.replaced') }
          : conn?.reason === 'idle' ? { dot: 'offline', text: t('rbi.mirror.idleEnded') }
            : conn?.reason ? { dot: 'offline', text: t('rbi.mirror.disconnected') } : { dot: 'connecting', text: t('rbi.mirror.connecting') }
    } else status = { dot: 'online', text: t('rbi.status.running') }
  }

  return (
    <header
      ref={ref}
      onKeyDown={onKey}
      aria-label={t('rbi.app.barLabel')}
      data-rbi-bar=""
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-background px-3 py-1.5 text-[13px]"
    >
      <span className="flex min-w-0 shrink-0 items-center gap-1.5 font-semibold text-foreground">
        <UiIcon name="shield" className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate" data-testid="rbi-bar-title">{live && session ? session.target_name : t('rbi.title')}</span>
      </span>

      {live && session && (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5" aria-label={t('rbi.mirror.urlLabel')}>
            <UiIcon name="lock" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {/* 원격 주소는 글자로만 — 링크·클릭 없음 */}
            <span className="min-w-0 truncate font-mono text-xs text-foreground" title={url} data-testid="rbi-bar-url">{url}</span>
          </span>
          <ul className="flex flex-wrap gap-1.5" aria-label={t('rbi.mirror.policyLabel')}>
            <li><UiBadge tone={mode === 'mirror' ? 'primary' : 'neutral'} tint size={18}>{t(`rbi.mode.${mode}`)}</UiBadge></li>
            {policy && rbiPolicyKeys(policy).map(k => <li key={k}><UiBadge tone="neutral" tint size={18}>{t(k)}</UiBadge></li>)}
          </ul>
          {status && (
            <span className="flex shrink-0 items-center gap-1.5" role="status" aria-live="polite" data-testid="rbi-bar-status">
              <UiStatusDot status={status.dot} label={status.text} />
              <span className="text-muted-foreground">{status.text}</span>
              {mode === 'mirror' && conn?.connected && conn.rtt > 0 && (
                <span className="font-mono text-xs text-muted-foreground">{t('rbi.mirror.latency', { ms: Math.round(conn.rtt) })}</span>
              )}
            </span>
          )}
          {session.status === 'running' && modes.length > 1 && (
            <UiSegment
              size="sm"
              ariaLabel={t('rbi.mode.label')}
              items={modes.map(m => ({ value: m, label: t(`rbi.mode.${m}`) }))}
              modelValue={mode}
              onUpdateModelValue={v => { if (v && v !== mode) onSwitchMode(v as RbiMode) }}
            />
          )}
          <UiButton variant="danger" size="xs" icon="close" onClick={onEnd}>{t('rbi.end')}</UiButton>
          <span className="hidden items-center gap-1 text-xs text-muted-foreground md:flex" title={t('rbi.app.shortcutHint')}>
            <UiKeycap>Ctrl</UiKeycap><UiKeycap>Alt</UiKeycap><UiKeycap>B</UiKeycap>
            <span className="sr-only">{t('rbi.app.shortcutHint')}</span>
          </span>
        </>
      )}

      <span className={live ? 'shrink-0' : 'ml-auto shrink-0'}>
        {me && (
          <UiMenu
            label={t('rbi.app.userMenu')}
            items={[
              { key: 'who', label: me.user.display_name, description: me.user.username, heading: true },
              { key: 'workspace', label: t('rbi.app.toWorkspace'), icon: 'external-link' },
              { key: 'logout', label: t('rbi.app.logout'), icon: 'log-out', danger: true, separated: true },
            ]}
            onSelect={k => {
              if (k === 'logout') onLogout()
              else if (k === 'workspace') window.open(me.workspace_url, '_blank', 'noopener,noreferrer')
            }}
            trigger={({ toggle, open, controls }) => (
              <UiButton variant="ghost" size="xs" icon="user" aria-haspopup="menu" aria-expanded={open} aria-controls={controls} onClick={toggle}>
                <span className="max-w-[10rem] truncate">{me.user.display_name}</span>
              </UiButton>
            )}
          />
        )}
      </span>
    </header>
  )
}
