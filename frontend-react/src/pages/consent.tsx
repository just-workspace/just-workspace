// OAuth 동의 화면.
//
// /oauth/authorize 는 세션이 있어도 곧바로 code 를 내주지 않고, 신뢰되지 않은 클라이언트면 여기로 보낸다.
// 서명된 요청 토큰(rq)에 원본 authorize 쿼리가 들어 있어서, 승인하면 그 URL 로 되돌아가 이번엔 동의 기록을 통과한다.
//
// 경로가 /oauth/consent 가 아니라 /consent 인 이유: nginx 가 /oauth/ 전체를 백엔드로 프록시하므로 그 아래에 프론트 라우트를 둘 수 없다.
// API 는 백엔드의 /oauth/consent/{info,decide} 를 그대로 쓴다(/api 접두어 없음).
// rq·info·decide·리다이렉트 로직은 OAuth 표준을 따른다.
import { useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo, useRoute } from '~/lib/router'
import { useI18n } from '~/i18n'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { AuthAlert } from '~/components/auth/AuthAlert'
import { AuthGuestCard } from '~/components/auth/AuthGuestCard'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'

interface ScopeItem { name: string; description: string }
interface ConsentInfo {
  client_id: string
  client_name: string
  dynamic: boolean
  redirect_uri: string
  scopes: ScopeItem[]
  username: string
  // RFC 7591 표시용 메타데이터. 서버가 https 검증을 통과한 값만 내려준다.
  logo_uri: string | null
  client_uri: string | null
  policy_uri: string | null
  tos_uri: string | null
}

export default function Page() {
  const { t } = useI18n()
  const route = useRoute()
  const rq = (route.query.rq as string) || ''

  const [info, setInfo] = useState<ConsentInfo | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 앱 카드 타일(로고가 없을 때) — 앱 이름 첫 글자
  const appInitial = (info?.client_name || '?').trim().charAt(0).toUpperCase()

  // redirect_uri 에서 호스트만 뽑아 보여준다 — 사용자가 "어디로 보내지는지"를 판단할 수 있어야 피싱성 클라이언트를 걸러낼 수 있다.
  const redirectHost = (() => {
    try { return new URL(info?.redirect_uri || '').host } catch { return info?.redirect_uri || '' }
  })()

  useEffect(() => {
    void (async () => {
      if (!rq) { setError(t('consent.invalidRequest')); return }
      try {
        setInfo(await $fetch<ConsentInfo>('/oauth/consent/info', {
          params: { rq }, credentials: 'include',
        }))
      } catch (e: any) {
        setError(e?.data?.detail || t('consent.loadFailed'))
      }
    })()
    // 마운트 때 한 번
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function decide(approve: boolean) {
    setSubmitting(true)
    setError('')
    try {
      const r = await $fetch<{ redirect: string }>('/oauth/consent/decide', {
        method: 'POST', credentials: 'include',
        body: { rq, approve },
      })
      // 승인이면 authorize 로 되돌아가고, 거부면 클라이언트에 access_denied 를 전달한다.
      window.location.href = r.redirect
    } catch (e: any) {
      setError(e?.data?.detail || t('consent.decideFailed'))
      setSubmitting(false)
    }
  }

  return (
    <AuthShell>
      {error && !info ? (
        <>
          <AuthHeading icon="alert-circle" tone="danger" title={t('consent.cannotConnect')} subtitle={error} />
          <UiButton as="a" href="/" variant="outline" size="lg" className="w-full bg-card" onClick={(e) => { e.preventDefault(); void navigateTo('/') }}>{t('authScreens.error.home')}</UiButton>
        </>
      ) : info ? (
        <>
          <AuthHeading title={t('consent.title')} subtitle={t('consent.subtitle')} />

          {/* 앱 카드: 로고/첫 글자 타일 40 + 이름(client_uri 링크) + 계정 */}
          <AuthGuestCard
            name={info.client_name}
            logo={info.logo_uri || undefined}
            initial={appInitial}
            href={info.client_uri || undefined}
            metaSlot={<UiTrans k="consent.connectAs" slots={{ user: <span className="font-semibold text-foreground">{info.username}</span> }} />}
          />

          {/* 동적 등록 클라이언트는 누구나 만들 수 있으므로 명시적으로 경고한다. */}
          {info.dynamic && (
            <AuthAlert tone="warning" title={t('consent.dynamicTitle')}>
              {t('consent.dynamicBody')}
            </AuthAlert>
          )}

          <div className="flex flex-col text-sm">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('consent.scopesLabel')}</p>
            <ul>
              {info.scopes.map(s => (
                <li key={s.name} className="flex min-h-10 items-center gap-2.5 py-1">
                  <UiIcon name="check" className="h-4 w-4 shrink-0 text-success" strokeWidth={2.6} />
                  <span className="min-w-0 flex-1 break-words">
                    {s.description}{' '}
                    <code className="ml-1 font-mono text-[11px] text-muted-foreground">{s.name}</code>
                  </span>
                </li>
              ))}
              {!info.scopes.length && (
                <li className="flex min-h-10 items-center text-[13px] text-muted-foreground">
                  {t('consent.noScopes')}
                </li>
              )}
            </ul>
          </div>

          {error && <AuthAlert tone="danger" title={error} />}

          <div className="flex gap-2">
            <UiButton variant="outline" size="lg" className="flex-1 px-4" disabled={submitting} onClick={() => { void decide(false) }}>
              {t('consent.deny')}
            </UiButton>
            <UiButton size="lg" className="flex-1 px-4 font-semibold" disabled={submitting} onClick={() => { void decide(true) }}>
              {submitting ? t('consent.processing') : t('consent.allow')}
            </UiButton>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground [word-break:keep-all]">
            <UiTrans k="consent.returnTo" slots={{ host: <span className="font-mono text-foreground">{redirectHost}</span> }} />
            {' '}{t('consent.revokeHint')}
          </p>

          {(info.policy_uri || info.tos_uri) && (
            <p className="text-xs text-muted-foreground">
              {info.policy_uri && (
                <a href={info.policy_uri} target="_blank" rel="noopener noreferrer" className="hover:underline">{t('consent.privacy')}</a>
              )}
              {info.policy_uri && info.tos_uri && <span> · </span>}
              {info.tos_uri && (
                <a href={info.tos_uri} target="_blank" rel="noopener noreferrer" className="hover:underline">{t('consent.terms')}</a>
              )}
            </p>
          )}
        </>
      ) : (
        /* 불러오는 중: 같은 틀의 스켈레톤 */
        <div className="flex flex-col gap-[18px]" role="status" aria-label={t('consent.loading')}>
          <div className="flex flex-col gap-2">
            <UiSkeleton className="h-7 w-40" />
            <UiSkeleton className="h-4 w-64" />
          </div>
          <UiSkeleton className="h-[70px] w-full rounded-lg" />
          <UiSkeleton preset="text" rows={3} />
        </div>
      )}
    </AuthShell>
  )
}
