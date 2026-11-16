/**
 * 원격 데스크톱 플러그인(v2 React) — /p/remote-desktop. 상태: 기기 없음 · 설치 안내 · 오프라인 · 코드 오류.
 *  · 내 기기: 데스크톱 앱에서 "이 PC 원격 접속 허용"을 활성화한 사용자 PC. 화면 앞 사용자가 30초 안에 허용해야 연결된다.
 *  · 1회성 지원: 피지원자의 지원 프로그램(포터블)에 표시된 9자리 코드를 입력 → 상대가 [허용]해야 연결된다.
 *  · 요청 즉시 RemoteViewer 가 화면 전체 오버레이로 표시되며(승인 대기부터), 닫으면 세션이 종료된다.
 * 플러그인 제약: 호스트 Tailwind 글롭 밖이므로 반응형 variant 를 사용하지 않는다(matchMedia·인라인 style). 부품은 호스트 키트(@jw/ui).
 * 설계·보안: plugins/remote-desktop/README.md
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { UiBadge, UiButton, UiEmptyState, UiErrorTile, UiIcon, UiIconButton, UiInput, UiSkeleton, UiStatusDot, UiSwitch, addToast } from '@jw/ui'
import { cleanCodeInput, codeFormatOk, joinErrorKind, makeApi, type Fetch, type RemoteDevice, type RemoteInfo } from './src/api'
import { currentLang, fmtSize, fmtWhen, makeT } from './src/i18n'
import { RemoteViewer, type ViewerRequest } from './src/viewer'

export const jwPlugin = { api: 2 } as const

interface PluginApiV2 {
  version: 2
  pluginId: string
  user: { id: string; is_admin?: boolean } | null
  appName: string
  $fetch: Fetch
  setTitle?: (title: string | null, owner?: string) => () => void
}

type CodeError = 'format' | 'no_match' | 'expired' | 'tooMany' | null

const MAX_CODE_ATTEMPTS = 5
const cardStyle: React.CSSProperties = { background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, minWidth: 0, boxSizing: 'border-box' }
const mono: React.CSSProperties = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" }
const h2: React.CSSProperties = { margin: 0, fontSize: 18, lineHeight: '28px', fontWeight: 600 }
const muted13: React.CSSProperties = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'hsl(var(--muted-foreground))' }

function useIsMobile() {
  const q = '(max-width: 767px)'
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}

/** 기기 아이콘 타일 + 상태 점(시안 36×36) */
function DeviceTile({ status, label }: { status: string; label: string }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 36, height: 36, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 10, background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}>
      <UiIcon name="monitor-pc" style={{ width: 18, height: 18 }} />
      <UiStatusDot status={status} ring="card" label={label} style={{ position: 'absolute', right: -2, bottom: -2 }} />
    </span>
  )
}

export default function RemoteDesktopPage({ pluginApi }: { pluginApi: PluginApiV2 }) {
  const t = useMemo(() => makeT(currentLang()), [])
  const api = useMemo(() => makeApi(pluginApi.$fetch), [pluginApi.$fetch])
  const mobile = useIsMobile()
  const user = pluginApi.user
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [failed, setFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<CodeError>(null)
  const [joining, setJoining] = useState(false)
  const [showInstall, setShowInstall] = useState(false)
  const [offlineSel, setOfflineSel] = useState<string | null>(null)
  const [open, setOpen] = useState<ViewerRequest | null>(null)

  useEffect(() => pluginApi.setTitle?.(t('title')), [])  // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const [i, d] = await Promise.all([api.status(), api.devices(showAll)])
      setInfo(i)
      setDevices(d.devices)
    } catch {
      setFailed(true)
    }
  }, [api, showAll])
  useEffect(() => { if (user) void load() }, [load, user])
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try { setDevices((await api.devices(showAll)).devices) } catch { addToast('error', t('loadError')) } finally { setRefreshing(false) }
  }, [api, showAll, t])
  useEffect(() => {
    if (open || !user) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void api.devices(showAll).then(d => setDevices(d.devices)).catch(() => {})
    }, 15_000)
    return () => clearInterval(id)
  }, [api, open, showAll, user])

  async function joinCode() {
    // 형식은 여기서 먼저 검사한다(공백·하이픈·붙여 쓰기 모두 허용) — 서버도 동일한 판정을 수행한다
    if (!codeFormatOk(code)) { setCodeError('format'); return }
    setJoining(true)
    try {
      const { session } = await api.joinCode(code.replace(/\D/g, ''))
      setCode('')
      setCodeError(null)
      setOpen({ sessionId: session.id, title: t('support.title') })
    } catch (e) {
      const k = joinErrorKind(e)
      if (k === 'other') { setCodeError(null); addToast('error', t('result.failed')) }
      else setCodeError(k)
    } finally {
      setJoining(false)
    }
  }

  async function connect(d: RemoteDevice) {
    try {
      const { session } = await api.connect(d.id)
      setOpen({ sessionId: session.id, title: d.name })
    } catch (e) {
      const detail = (e as { data?: { detail?: unknown } }).data?.detail
      addToast('error', typeof detail === 'string' ? detail : t('result.failed'))
    }
  }

  async function copyLink() {
    if (!info) return
    try {
      await navigator.clipboard.writeText(new URL(info.support_download, location.origin).href)
      addToast('success', t('support.linkCopied'))
    } catch {
      addToast('error', t('result.failed'))
    }
  }

  const pad = { padding: mobile ? 16 : 24 }
  if (failed) return <div style={pad}><UiErrorTile placement="card" title={t('loadError')} onRetry={() => { void load() }} /></div>
  if (!info || !devices) return <div style={pad}><UiSkeleton preset="text" rows={4} /></div>

  const firstOnline = devices.find(d => d.online && d.allow_remote)?.id
  const sel = devices.find(d => d.id === offlineSel && !d.online)

  const installGuide = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20 }} data-testid="remote-install">
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <UiIcon name="info" style={{ width: 18, height: 18, flexShrink: 0, marginTop: 2, color: 'hsl(var(--primary))' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 14, lineHeight: '20px', fontWeight: 600 }}>{t('install.title')}</span>
          <span style={muted13}>{t('install.desc')}</span>
        </div>
      </div>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(['install.step1', 'install.step2', 'install.step3'] as const).map((k, i) => (
          <li key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, lineHeight: '20px' }}>
            <span style={{ ...mono, display: 'inline-flex', width: 24, height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'hsl(var(--muted))', fontSize: 12 }}>{i + 1}</span>
            <span>{t(k)}</span>
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <UiButton as="a" href={info.desktop_download} icon="download">{t('install.windows')}</UiButton>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'hsl(var(--muted-foreground))' }}>{t('install.otherOs')}</span>
      </div>
    </div>
  )

  return (
    <div style={{ ...pad, boxSizing: 'border-box' }} data-testid="remote-page">
      <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h1 style={{ margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 700 }}>{t('title')}</h1>
            <p style={{ ...muted13, fontSize: 14 }}>{t('desc')}</p>
          </div>
          <UiButton as="a" href={info.desktop_download} variant="outline" size="sm" icon="download">{t('getDesktopApp')}</UiButton>
        </div>
        {!info.livekit && (
          <div role="alert" style={{ ...cardStyle, padding: '10px 14px', borderColor: 'hsl(var(--danger) / 0.4)', fontSize: 13, color: 'hsl(var(--danger))' }}>{t('noRelay')}</div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
          {/* 내 기기 */}
          <section aria-labelledby="rd-h-devices" style={{ ...cardStyle, flex: '999 1 560px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 20px', borderBottom: '1px solid hsl(var(--border))' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <h2 id="rd-h-devices" style={h2}>{t('devices.title')}</h2>
                <span style={{ ...mono, fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>{devices.length}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {info.is_admin && <UiSwitch label={t('devices.showAll')} modelValue={showAll} onUpdateModelValue={setShowAll} />}
                <UiIconButton icon="refresh" label={t('devices.refresh')} disabled={refreshing} onClick={() => void refresh()} />
              </div>
            </div>

            {devices.length === 0 ? (
              showInstall ? installGuide : (
                <div style={{ padding: 20 }}>
                  <UiEmptyState
                    variant="panel" icon="monitor-pc" title={t('devices.empty')} description={t('devices.emptyDesc')}
                    actionLabel={t('getDesktopApp')} onAction={() => setShowInstall(true)}
                  />
                </div>
              )
            ) : (
              <div role="list" data-testid="remote-devices">
                {devices.map(d => {
                  const usable = d.online && d.allow_remote
                  const stateLabel = !d.online ? t('devices.offline') : d.allow_remote ? t('devices.online') : t('devices.notAllowed')
                  const meta = [d.os_name || d.platform, showAll && d.owner_id !== user?.id ? d.owner_name : '', stateLabel].filter(Boolean).join(' · ')
                  const last = d.online ? t('devices.now') : fmtWhen(d.last_seen_at)
                  const row = (
                    <>
                      <DeviceTile status={d.online ? 'online' : 'offline'} label={stateLabel} />
                      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                        <span style={{ fontSize: 12, lineHeight: '16px', color: 'hsl(var(--muted-foreground))' }}>
                          {meta} · {t('devices.lastSeen')} <span style={mono}>{last}</span>
                        </span>
                      </div>
                    </>
                  )
                  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, minHeight: 56, padding: '8px 20px', borderBottom: '1px solid hsl(var(--border))', boxSizing: 'border-box' }
                  if (!d.online) {
                    // C: 오프라인 행 선택 시 연결 불가 사유를 펼쳐 표시한다
                    const selected = offlineSel === d.id
                    return (
                      <div key={d.id} role="listitem">
                        <button
                          type="button"
                          aria-expanded={selected}
                          onClick={() => setOfflineSel(selected ? null : d.id)}
                          style={{ ...rowStyle, width: '100%', textAlign: 'left', background: selected ? 'hsl(var(--accent))' : 'transparent', border: 0, borderBottom: '1px solid hsl(var(--border))', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
                        >
                          {row}
                          <UiBadge tone="neutral" tint>{t('devices.offline')}</UiBadge>
                        </button>
                        {selected && sel && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 20px 16px', borderBottom: '1px solid hsl(var(--border))' }}>
                            <UiErrorTile
                              placement="card"
                              title={t('offline.title', { name: sel.name })}
                              detail={t('offline.detail', { when: fmtWhen(sel.last_seen_at) })}
                              retryLabel={t('offline.retry')}
                              onRetry={() => void refresh()}
                            />
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'hsl(var(--muted-foreground))' }}>{t('offline.help')}</span>
                          </div>
                        )}
                      </div>
                    )
                  }
                  return (
                    <div key={d.id} role="listitem" style={rowStyle}>
                      {row}
                      <UiButton
                        size="sm"
                        variant={d.id === firstOnline ? 'default' : 'secondary'}
                        icon="monitor"
                        disabled={!usable || !info.livekit}
                        onClick={() => void connect(d)}
                        data-testid={`remote-connect-${d.id}`}
                      >{t('devices.connect')}</UiButton>
                    </div>
                  )
                })}
              </div>
            )}

            {devices.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', ...muted13 }}>
                <UiIcon name="info" style={{ width: 14, height: 14, flexShrink: 0 }} />
                <span>{t('devices.addHint')}</span>
              </div>
            )}
          </section>

          {/* 1회성 지원 */}
          <section aria-labelledby="rd-h-support" style={{ ...cardStyle, flex: '1 1 340px', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h2 id="rd-h-support" style={h2}>{t('support.title')}</h2>
              <p style={muted13}>{t('support.desc')}</p>
            </div>
            <form style={{ display: 'flex', flexDirection: 'column', gap: 16 }} onSubmit={e => { e.preventDefault(); void joinCode() }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <UiInput
                  label={t('support.codeLabel')}
                  placeholder="123-456-789"
                  mono
                  size="lg"
                  icon="lock"
                  inputMode="numeric"
                  modelValue={code}
                  onUpdateModelValue={(v: string) => { setCode(cleanCodeInput(v)); if (codeError) setCodeError(null) }}
                  hint={t('support.codeHint')}
                  error={codeError ? t(`support.err.${codeError}`) : undefined}
                  data-testid="remote-code"
                />
                {codeError === 'no_match' && (
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'hsl(var(--muted-foreground))' }}>
                    {t('support.burnNote', { n: MAX_CODE_ATTEMPTS })}
                  </span>
                )}
              </div>
              <UiButton type="submit" size="lg" icon="monitor" disabled={!code.trim() || joining || !info.livekit}>{t('support.join')}</UiButton>
            </form>
            {info.support_size != null && (
              <>
                <div style={{ height: 1, background: 'hsl(var(--border))' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{t('support.program')}</span>
                  <span style={muted13}>
                    {t('support.programDesc', { req: info.support_requirements, size: '\u0000' }).split('\u0000')[0]}
                    <span style={mono}>{fmtSize(info.support_size)}</span>
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <UiButton as="a" href={info.support_download} variant="outline" size="sm" icon="download">{t('support.download')}</UiButton>
                    <UiButton variant="ghost" size="sm" icon="link" onClick={() => void copyLink()}>{t('support.copyLink')}</UiButton>
                  </div>
                </div>
              </>
            )}
            {info.support_size == null && info.is_admin && (
              <span style={{ fontSize: 12, lineHeight: '16px', color: 'hsl(var(--muted-foreground))' }}>{t('support.notUploaded')}</span>
            )}
          </section>
        </div>
      </div>

      {open && <RemoteViewer key={open.sessionId} api={api} t={t} request={open} onClose={() => { setOpen(null); void load() }} />}
    </div>
  )
}
