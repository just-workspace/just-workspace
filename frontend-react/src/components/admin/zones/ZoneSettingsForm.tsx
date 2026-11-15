/**
 * 구역 설정 폼 — 켜기 창의 1단계와, 켜진 구역의 "설정"이 같이 쓴다.
 *  · 메일: 내장(메일 도메인 + 등록할 레코드 확인) / 외부 발신 서버(주소·포트·보안 방식·계정·비밀번호 + 연결 확인)
 *  · 회의: 공인 주소(감지값, 없으면 직접 입력) · 중계 서버 · 무손실 오디오
 *  · AI 도우미: 지금 연결(제공자·키 + 연결 확인) / 나중에
 *  · 코드 저장소: 검증된 버전 / 최신 / 직접 지정
 * 연결 확인이 필요한 값(외부 발신 서버, AI 키)을 바꾸면 확인 상태는 처음으로 돌아간다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { writeClipboard } from '~/lib/clipboard'
import { zonesApi, errorCode, type MailRecord, type ZoneSettings } from '~/composables/useSystemZones'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiSegment } from '~/components/ui/Segment'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiCallout } from '~/components/ui/Callout'
import { UiBadge } from '~/components/ui/Badge'
import { UiTable, type UiTableColumn } from '~/components/ui/Table'

export interface VerifyState { state: 'idle' | 'running' | 'ok' | 'failed'; code?: string }

export interface ZoneSettingsFormProps {
  zoneId: string
  form: ZoneSettings
  /** 값 바꾸기 — resetVerify 면 연결 확인 상태도 처음으로 */
  onChange: (patch: ZoneSettings, resetVerify?: boolean) => void
  verify: VerifyState
  onVerify: () => void
  /** 설치 때 감지해 둔 공인 주소 */
  detectedIp: string | null
  onRedetectIp: () => void
  redetecting: boolean
  /** 켜진 구역의 설정을 다시 연 것인가(메일 레코드를 열자마자 확인한다) */
  reopened: boolean
}

const AI_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
]

function VerifyLine({ verify, onVerify, need, okText, failNs }: { verify: VerifyState; onVerify: () => void; need: string; okText: string; failNs: string }) {
  const { t, te } = useI18n()
  const failKey = `${failNs}.${verify.code || 'error'}`
  return (
    <div className="flex flex-wrap items-center gap-3">
      <UiButton variant="outline" size="sm" icon="refresh" disabled={verify.state === 'running'} onClick={onVerify}>
        {verify.state === 'running' ? t('admin.zones.verifying') : t('admin.zones.verify')}
      </UiButton>
      {verify.state === 'ok' ? (
        <span role="status" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-success" data-testid="verify-status">
          <UiIcon name="check-circle" className="h-4 w-4" />{okText}
        </span>
      ) : verify.state === 'failed' ? (
        <span role="alert" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-danger" data-testid="verify-status">
          <UiIcon name="alert-circle" className="h-4 w-4" />{t(te(failKey) ? failKey : `${failNs}.error`)}
        </span>
      ) : (
        <span className="text-[13px] text-muted-foreground">{need}</span>
      )}
    </div>
  )
}

function MailRecords({ domain, auto }: { domain: string; auto: boolean }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<MailRecord[] | null>(null)
  const [state, setState] = useState<'idle' | 'running' | 'error' | 'unsupported'>('idle')

  async function check() {
    if (!domain.trim()) return
    setState('running')
    try {
      const r = await zonesApi.probeMailRecords(domain.trim())
      setRows(Array.isArray(r.records) ? r.records : [])
      setState('idle')
    } catch (e) {
      setState(errorCode(e) === 'installer_unsupported' ? 'unsupported' : 'error')
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (auto) void check() }, [])

  const STATUS: Record<MailRecord['status'], { tone: string; icon: string }> = {
    ok: { tone: 'text-success', icon: 'check-circle' },
    missing: { tone: 'text-warning', icon: 'alert-triangle' },
    different: { tone: 'text-danger', icon: 'alert-circle' },
    unknown: { tone: 'text-muted-foreground', icon: 'info' },
  }
  const columns: UiTableColumn<MailRecord>[] = [
    { key: 'type', header: t('admin.zones.mail.col.type'), mono: true, cell: r => r.type },
    { key: 'name', header: t('admin.zones.mail.col.name'), mono: true, cell: r => r.name },
    { key: 'value', header: t('admin.zones.mail.col.value'), cell: r => (
      <span className="-my-1.5 flex items-center gap-1">
        <span className="min-w-0 break-all font-mono">{r.expected}</span>
        {r.expected && <UiIconButton label={t('admin.zones.mail.copy', { name: r.name })} icon="copy" size="sm" onClick={() => { void writeClipboard(r.expected) }} />}
      </span>
    ) },
    { key: 'status', header: t('admin.zones.mail.col.status'), className: 'whitespace-nowrap', cell: r => {
      const s = STATUS[r.status] ?? STATUS.unknown
      return <span className={cn('inline-flex items-center gap-1.5 font-medium', s.tone)}><UiIcon name={s.icon} className="h-4 w-4" />{t(`admin.zones.mail.rec.${STATUS[r.status] ? r.status : 'unknown'}`)}</span>
    } },
  ]

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <h3 className="text-base font-semibold">{t('admin.zones.mail.recordsTitle')}</h3>
          <UiButton variant="secondary" size="sm" icon="refresh" disabled={state === 'running' || !domain.trim()} onClick={() => { void check() }}>
            {state === 'running' ? t('admin.zones.verifying') : t('admin.zones.mail.recheck')}
          </UiButton>
        </div>
        <div className="border-t border-border">
          {state === 'unsupported' ? (
            <UiCallout variant="plain" tone="neutral" role="status" className="px-4 py-3">{t('admin.zones.mail.recordsUnsupported')}</UiCallout>
          ) : state === 'error' ? (
            <UiCallout variant="plain" tone="danger" role="alert" className="px-4 py-3">{t('admin.zones.mail.recordsError')}</UiCallout>
          ) : rows === null ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{t('admin.zones.mail.recordsEmpty')}</p>
          ) : (
            <UiTable columns={columns} rows={rows} rowKey={r => r.id} label={t('admin.zones.mail.recordsTitle')} minWidthClass="min-w-[600px]" />
          )}
        </div>
      </div>
      <p className="text-xs leading-[18px] text-muted-foreground">{t('admin.zones.mail.recordsNote')}</p>
    </>
  )
}

export function ZoneSettingsForm({ zoneId, form, onChange, verify, onVerify, detectedIp, onRedetectIp, redetecting, reopened }: ZoneSettingsFormProps) {
  const { t } = useI18n()
  const str = (v: unknown) => (v == null ? '' : String(v))
  const pick = (key: string) => (v: string | number | null) => { if (v != null) onChange({ [key]: v }, true) }

  if (zoneId === 'mail') {
    const builtin = form.kind === 'builtin'
    const domain = str(form.mail_domain).trim()
    return (
      <>
        <div role="radiogroup" aria-label={t('admin.zones.mail.wayAria')} className="grid gap-2 sm:grid-cols-2">
          <UiRadioCard className="w-full" layout="row" value="builtin" title={t('admin.zones.mail.builtin.title')} description={t('admin.zones.mail.builtin.desc')} modelValue={form.kind} onUpdateModelValue={pick('kind')} />
          <UiRadioCard className="w-full" layout="row" value="external" title={t('admin.zones.mail.external.title')} description={t('admin.zones.mail.external.desc')} modelValue={form.kind} onUpdateModelValue={pick('kind')} />
        </div>
        {builtin ? (
          <>
            <div className="max-w-[320px]">
              <UiInput label={t('admin.zones.mail.domain')} mono placeholder="example.com" modelValue={str(form.mail_domain)} onUpdateModelValue={v => onChange({ mail_domain: v })}
                hint={t('admin.zones.mail.domainHint', { domain: domain || 'example.com' })} />
            </div>
            <MailRecords key={reopened ? 'reopened' : 'new'} domain={domain} auto={reopened && !!domain} />
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <UiInput label={t('admin.zones.mail.host')} mono placeholder="smtp.example.com" modelValue={str(form.host)} onUpdateModelValue={v => onChange({ host: v }, true)} />
              <UiInput label={t('admin.zones.mail.port')} mono modelValue={str(form.port)} onUpdateModelValue={v => onChange({ port: v }, true)} />
              <UiInput label={t('admin.zones.mail.username')} mono modelValue={str(form.username)} onUpdateModelValue={v => onChange({ username: v }, true)} autocomplete="off" />
              <UiPasswordInput label={t('admin.zones.mail.password')} autocomplete="new-password" modelValue={str(form.password)} onUpdateModelValue={v => onChange({ password: v }, true)}
                placeholder={form.password_set ? t('admin.zones.mail.passwordSaved') : t('admin.zones.mail.passwordPh')} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('admin.zones.mail.security')}</h3>
              <div className="flex">
                <UiSegment ariaLabel={t('admin.zones.mail.security')} modelValue={form.security} onUpdateModelValue={pick('security')}
                  items={[{ value: 'starttls', label: 'STARTTLS' }, { value: 'ssl', label: 'SSL/TLS' }, { value: 'none', label: t('admin.zones.mail.secNone') }]} />
              </div>
            </div>
            <VerifyLine verify={verify} onVerify={onVerify} need={t('admin.zones.mail.needVerify')} okText={t('admin.zones.mail.verified')} failNs="admin.zones.mail.fail" />
          </>
        )}
      </>
    )
  }

  if (zoneId === 'meetings') {
    const typed = str(form.public_ip).trim()
    return (
      <>
        {detectedIp && !typed ? (
          <UiCallout variant="plain" tone="success" role="status" title={<span className="text-success">{t('admin.zones.meet.ipOk')}</span>} data-testid="meet-ip">
            <span className="text-muted-foreground">{t('admin.zones.meet.ipOkBefore')}<span className="font-mono">{detectedIp}</span>{t('admin.zones.meet.ipOkAfter')}</span>
          </UiCallout>
        ) : (
          <>
            {!detectedIp && (
              <UiCallout tone="warning" role="status" title={t('admin.zones.meet.ipUnknown')} data-testid="meet-ip"
                actions={<UiButton variant="outline" size="sm" icon="refresh" disabled={redetecting} onClick={onRedetectIp}>{redetecting ? t('admin.zones.verifying') : t('admin.zones.meet.redetect')}</UiButton>}>
                {t('admin.zones.meet.ipUnknownBody')}
              </UiCallout>
            )}
            <div className="max-w-[320px]">
              <UiInput label={t('admin.zones.meet.ipLabel')} mono placeholder="203.0.113.24" modelValue={str(form.public_ip)} onUpdateModelValue={v => onChange({ public_ip: v })} />
            </div>
          </>
        )}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('admin.zones.meet.relayTitle')}</h3>
          <div role="radiogroup" aria-label={t('admin.zones.meet.relayTitle')} className="grid gap-2 sm:grid-cols-2">
            <UiRadioCard className="w-full" layout="row" value="on" title={t('admin.zones.meet.relayOn.title')} description={t('admin.zones.meet.relayOn.desc')} modelValue={form.turn ? 'on' : 'off'} onUpdateModelValue={v => { if (v != null) onChange({ turn: v === 'on' }) }} />
            <UiRadioCard className="w-full" layout="row" value="off" title={t('admin.zones.meet.relayOff.title')} description={t('admin.zones.meet.relayOff.desc')} modelValue={form.turn ? 'on' : 'off'} onUpdateModelValue={v => { if (v != null) onChange({ turn: v === 'on' }) }} />
          </div>
        </div>
        <UiCheckbox label={t('admin.zones.meet.hifi')} description={t('admin.zones.meet.hifiDesc')} modelValue={!!form.lossless_audio} onUpdateModelValue={v => onChange({ lossless_audio: !!v })} />
      </>
    )
  }

  if (zoneId === 'ai') {
    return (
      <>
        <div role="radiogroup" aria-label={t('admin.zones.ai.whenAria')} className="grid gap-2 sm:grid-cols-2">
          <UiRadioCard className="w-full" layout="row" value="now" title={t('admin.zones.ai.now.title')} description={t('admin.zones.ai.now.desc')} modelValue={form.mode} onUpdateModelValue={pick('mode')} />
          <UiRadioCard className="w-full" layout="row" value="later" title={t('admin.zones.ai.later.title')} description={t('admin.zones.ai.later.desc')} modelValue={form.mode} onUpdateModelValue={pick('mode')} />
        </div>
        {form.mode === 'now' && (
          <>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('admin.zones.ai.provider')}</h3>
              <div className="flex"><UiSegment ariaLabel={t('admin.zones.ai.provider')} items={AI_PROVIDERS} modelValue={form.provider} onUpdateModelValue={pick('provider')} /></div>
            </div>
            <UiPasswordInput label={t('admin.zones.ai.key')} autocomplete="off" modelValue={str(form.api_key)} onUpdateModelValue={v => onChange({ api_key: v }, true)}
              placeholder={form.api_key_set ? t('admin.zones.ai.keySaved') : t('admin.zones.ai.keyPh')} hint={t('admin.zones.ai.keyHint')} />
            <VerifyLine verify={verify} onVerify={onVerify} need={t('admin.zones.ai.needVerify')} okText={t('admin.zones.ai.verified')} failNs="admin.zones.ai.fail" />
          </>
        )}
      </>
    )
  }

  if (zoneId === 'git') {
    return (
      <>
        <div role="radiogroup" aria-label={t('admin.zones.git.aria')} className="flex flex-col gap-2">
          {(['tested', 'latest', 'custom'] as const).map(v => (
            <UiRadioCard key={v} className="w-full" value={v} title={t(`admin.zones.git.${v}.title`)} description={t(`admin.zones.git.${v}.desc`)} modelValue={form.version} onUpdateModelValue={x => { if (x != null) onChange({ version: x }) }} />
          ))}
        </div>
        {form.version === 'custom' && (
          <div className="max-w-[280px]">
            <UiInput label={t('admin.zones.git.version')} mono modelValue={str(form.custom_version)} onUpdateModelValue={v => onChange({ custom_version: v })} />
          </div>
        )}
        {form.version !== 'tested' && (
          <UiCallout tone="warning" title={<UiBadge tone="warning" tint size={18}>{t('admin.zones.git.untested.badge')}</UiBadge>}>
            <span className="text-muted-foreground">{t('admin.zones.git.untested.body')}</span>
          </UiCallout>
        )}
      </>
    )
  }

  return null
}

export default ZoneSettingsForm
