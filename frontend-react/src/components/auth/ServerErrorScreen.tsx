/**
 * 500 — 셸 없음, 가운데 480 열 하나.
 *  브랜드(타일 28 + 이름 15/600) → mono 500 · 제목 24/700 · 설명 14 → 요청 번호(UiInput readonly mono · 복사) →
 *  [다시 시도(refresh)][서비스 상태 ▴/▾ outline] → 펼치면 UiCard: 머리 "서비스 상태 · 확인 10:42:08 · 새로 확인",
 *  행 40 = StatusDot · 서비스 · 상태 글자 · 응답 시간(mono, 오른쪽 64).
 * 요청 번호: 서버가 500 본문(request_id)·X-Request-ID 헤더로 준 값. 화면 쪽 오류처럼 서버 번호가 없으면
 *   같은 꼴로 만들어 콘솔에 오류와 함께 남긴다(관리자가 브라우저 콘솔에서 찾을 수 있게).
 * 서비스 상태는 공개 헬스 체크만(GET /api/services/public-status — 로그인 전에도, 내부 주소·버전 없음).
 *   "웹·API" 줄은 그 요청 자체로 잰다(응답이 없으면 중단, 나머지 줄은 알 수 없으니 그리지 않는다).
 *   확인 시각은 서버 점검 시각(없으면 받은 시각). 로그인 전이라 관리 화면 링크는 두지 않는다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch, errorRequestId } from '~/lib/api'
import { reportClientError } from '~/lib/clientErrorReport'
import { navigateTo, useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { toast } from '~/composables/useToast'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiInput } from '~/components/ui/Input'
import { UiCard } from '~/components/ui/Card'
import { UiStatusDot } from '~/components/ui/StatusDot'

export interface AuthServerErrorScreenProps {
  /** 라우터 오류 경계가 넘기는 오류(statusCode·message·data(원래 오류)·cause) */
  error?: { statusCode?: number; message?: string; data?: any; cause?: any } | null
}

function shortId() {
  const a = new Uint8Array(4)
  try { crypto.getRandomValues(a) } catch { for (let i = 0; i < 4; i++) a[i] = Math.floor(Math.random() * 256) }
  const h = Array.from(a, b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 4)}-${h.slice(4)}`
}

/**
 * 오류 객체 어디엔가 실린 서버 요청 번호(본문 request_id · 응답 헤더).
 * React 라우터 오류는 원래 FetchError 를 data 에 담아 오므로
 * 그 안(lib/api 의 errorRequestId — 본문 request_id → X-Request-ID)까지 본다.
 */
function serverRequestId(e: any): string {
  if (!e) return ''
  const d = e.data ?? e.cause?.data
  if (d && typeof d === 'object' && typeof d.request_id === 'string') return d.request_id
  const h = e.response?.headers ?? e.cause?.response?.headers
  try {
    const v = h?.get?.('x-request-id')
    if (v) return v
  } catch { /* ignore */ }
  return errorRequestId(e) || errorRequestId(e.cause) || errorRequestId(e.data) || ''
}

/** 공개 상태 한 줄(서버) */
interface PublicSvc { key: string; status: 'ok' | 'slow' | 'down' | 'off' | 'checking'; response_ms: number | null }
interface PublicStatus { checked_at: string | null; services: PublicSvc[] }
/** 화면 줄 — web 은 이 화면이 직접 잰다 */
export interface ServiceStatusRow { key: string; status: PublicSvc['status']; ms: number | null }

/** 응답 시간 글자 — 1초 이상이면 "1.2 s", 없으면 "—" */
export function serviceMsText(ms: number | null) {
  if (ms === null || ms === undefined) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/** 공개 상태 응답(또는 실패) → 화면 줄. 맨 위는 웹·API(이 요청의 왕복 시간) */
export function serviceRows(res: PublicStatus | null, webMs: number | null): ServiceStatusRow[] {
  if (!res) return [{ key: 'web', status: 'down', ms: null }]
  const web: ServiceStatusRow = { key: 'web', status: webMs !== null && webMs >= 1000 ? 'slow' : 'ok', ms: webMs }
  return [web, ...res.services.map(s => ({ key: s.key, status: s.status, ms: s.status === 'off' ? null : s.response_ms }))]
}

function hms(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function AuthServerErrorScreen({ error }: AuthServerErrorScreenProps) {
  const { t } = useI18n()
  const { appName, brandLogo } = useSiteConfig()
  const route = useRoute()

  const [requestId] = useState(() => serverRequestId(error) || shortId())
  useEffect(() => {
    // 서버 번호가 없던 오류(화면 쪽)는 같은 번호로 콘솔과 서버 로그(/api/client-error)에 남긴다
    if (!serverRequestId(error)) {
      console.error(`[req ${requestId}]`, error)
      reportClientError(requestId, error?.data ?? error, error?.statusCode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const brandInitial = (appName || 'W').trim().charAt(0).toUpperCase()

  // 오류를 지우고 그 주소로 replace
  function retry() { void navigateTo(route.fullPath, { replace: true }) }

  // ── 서비스 상태 ──
  const [statusOpen, setStatusOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<ServiceStatusRow[]>([])
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  async function loadStatus() {
    setLoading(true)
    const t0 = performance.now()
    try {
      const r = await $fetch<PublicStatus>('/api/services/public-status')
      setRows(serviceRows(r, Math.round(performance.now() - t0)))
      setCheckedAt(r.checked_at ? new Date(r.checked_at) : new Date())
    } catch {
      setRows(serviceRows(null, null))
      setCheckedAt(new Date())
    } finally { setLoading(false) }
  }
  function toggleStatus() {
    const open = !statusOpen
    setStatusOpen(open)
    if (open && !rows.length && !loading) void loadStatus()
  }
  function svcLabel(s: ServiceStatusRow) {
    if (s.key === 'web' && s.status === 'down') return t('error.500.statusNoResponse')
    return s.status === 'checking' ? t('error.500.statusUnknown') : t(`ui.status.${s.status}`)
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="flex w-full max-w-[480px] flex-col gap-4">
        <div className="flex items-center gap-2.5">
          {brandLogo
            ? <img src={brandLogo} alt="" className="h-7 w-7 rounded-sm object-cover" />
            : <span className="grid h-7 w-7 place-items-center rounded-sm bg-primary text-[13px] font-bold text-primary-foreground" aria-hidden="true">{brandInitial}</span>}
          <span className="text-[15px] font-semibold">{appName}</span>
        </div>
        <p className="font-mono text-[13px] font-semibold text-muted-foreground">{error?.statusCode || 500}</p>
        <h1 className="text-2xl font-bold tracking-tight">{t('error.500.title')}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground [word-break:keep-all]">{t('error.500.description')}</p>
        <UiInput
          readonly
          mono
          label={t('error.500.requestId')}
          modelValue={requestId}
          onCopied={() => toast({ type: 'success', title: t('error.500.copied') })}
        />
        <div className="flex flex-wrap gap-2">
          <UiButton icon="refresh" onClick={retry}>{t('error.500.retry')}</UiButton>
          <UiButton variant="outline" iconRight={statusOpen ? 'chevron-up' : 'chevron-down'} aria-expanded={statusOpen} aria-controls="svc-status" onClick={toggleStatus}>
            {t('error.500.status')}
          </UiButton>
        </div>
        {statusOpen && (
          <UiCard id="svc-status">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span className="flex-1 text-[13px] font-semibold">{t('error.500.status')}</span>
              {checkedAt && <span className="text-xs text-muted-foreground">{t('error.500.checkedAt')} <span className="font-mono">{hms(checkedAt)}</span></span>}
              <UiIconButton icon="refresh" label={t('error.500.recheck')} disabled={loading} onClick={() => void loadStatus()} />
            </div>
            <div role="status" aria-busy={loading}>
              {loading && !rows.length
                ? <p className="px-4 py-2.5 text-[13px] text-muted-foreground">{t('error.500.statusLoading')}</p>
                : rows.map(s => (
                  <div key={s.key} className="flex h-10 items-center gap-2.5 border-b border-border px-4 text-[13px] last:border-b-0">
                    <UiStatusDot status={s.status === 'checking' ? 'unknown' : s.status} />
                    <span className="min-w-0 flex-1 truncate">{t(`error.500.svc.${s.key}`)}</span>
                    <span className="text-xs text-muted-foreground">{svcLabel(s)}</span>
                    <span className="w-16 text-right font-mono text-[11px] text-muted-foreground">{serviceMsText(s.ms)}</span>
                  </div>
                ))}
            </div>
          </UiCard>
        )}
      </div>
    </main>
  )
}

export default AuthServerErrorScreen
