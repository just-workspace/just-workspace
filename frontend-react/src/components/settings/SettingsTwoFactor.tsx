/**
 * 설정 › 보안 "2단계 인증" 카드 + 모달.
 *
 * 카드: UiCard 머리(제목 + "로그인할 때 인증 앱의 6자리 코드를 한 번 더 묻습니다" + 상태 틴트 배지 켜짐 success / 꺼짐 neutral),
 *   본문 버튼 — 꺼짐 [켜기] · 켜짐 [복구 코드 새로 발급](outline) [끄기](ghost danger).
 *   관리자가 필수로 정한 계정은 [끄기] 대신 안내 글만(끌 수 없음).
 * 모달(G 규격, 시안 그대로):
 *  · 켜기 1/2(520, 바깥 클릭으로 안 닫힘): QR 136(bg-paper) + 설정 키(읽기 전용·복사) + 앱 코드 6자리(lg mono, "000 000").
 *    틀리면 UiInput error. [다음 — 복구 코드] → POST /api/auth/2fa/enable.
 *  · 켜기 2/2 · 새로 발급 결과(480, 바깥 클릭으로 안 닫힘): 복구 코드 10개 2열 mono 점선 틀 + [복사][.txt 받기]
 *    + "저장했습니다" 체크해야 [완료].
 *  · 끄기(sm, danger): 인증 앱 코드 또는 복구 코드 — 넣기 전엔 [끄기] 비활성. POST /api/auth/2fa/disable.
 *  · 새로 발급(480): warning 띠 "남은 코드 n개는 바로 못 쓰게 됩니다" + 인증 앱 코드 → POST /api/auth/2fa/recovery-codes → 2/2 같은 틀.
 *
 * @example <SettingsTwoFactor autoEnroll={route.query.enroll === '1'} />
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { fetchUser } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { UiCard } from '~/components/ui/Card'
import { UiCardHeader } from '~/components/ui/CardHeader'
import { UiCardTitle } from '~/components/ui/CardTitle'
import { UiCardContent } from '~/components/ui/CardContent'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiIcon } from '~/components/ui/Icon'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiTrans } from '~/components/ui/Trans'
import { writeClipboard } from '~/lib/clipboard'

export interface SettingsTwoFactorProps {
  /** 처음 열 때 꺼져 있으면 바로 켜기 흐름을 연다(관리자 정책으로 등록 유도) */
  autoEnroll?: boolean
}

interface Status { enabled: boolean; recovery_total: number; recovery_remaining: number; required: boolean }
interface SetupData { secret: string; otpauth_url: string; qr_data_url: string }

function errDetail(e: unknown): string | undefined {
  const d = (e as { data?: { detail?: unknown } } | null)?.data?.detail
  return typeof d === 'string' ? d : undefined
}

/** 6자리 코드 칸 표기 — 숫자만, 3자리 뒤 공백("481 20") */
export function formatOtp(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 6)
  return d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d
}
/** 설정 키 표기 — 4글자씩 띄움("JBSW Y3DP …") */
export function groupSecret(s: string): string {
  return (s.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ')
}
/** 복구 코드 .txt 내용 */
export function recoveryCodesText(appName: string, codes: string[]): string {
  return [`${appName} — 2FA recovery codes`, '', ...codes.map((c, i) => `${String(i + 1).padStart(2, '0')}  ${c}`), ''].join('\n')
}

type Dialog = null | 'on1' | 'codes' | 'off' | 'regen'

export function SettingsTwoFactor({ autoEnroll }: SettingsTwoFactorProps) {
  const { t } = useI18n()
  const { appName } = useSiteConfig()

  const [st, setSt] = useState<Status | null>(null)
  const [loadError, setLoadError] = useState(false)
  async function load(): Promise<Status | null> {
    setLoadError(false)
    try { const s = await $fetch<Status>('/api/auth/2fa/status'); setSt(s); return s } catch { setLoadError(true); return null }
  }

  const [dialog, setDialog] = useState<Dialog>(null)
  const [setup, setSetup] = useState<SetupData | null>(null)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [working, setWorking] = useState(false)
  const [codes, setCodes] = useState<string[]>([])
  /** 2/2 단계 표시(켜기 흐름) — 새로 발급 결과면 false */
  const [codesStep, setCodesStep] = useState(false)

  function open(d: Dialog) { setCode(''); setCodeError(''); setDialog(d) }

  async function openSetup() {
    try {
      setSetup(await $fetch<SetupData>('/api/auth/2fa/setup', { method: 'POST' }))
      open('on1')
    } catch (e) { addToast('error', errDetail(e) || t('settings.twoFactor.setupFailed')) }
  }

  const autoRef = useRef(autoEnroll)
  useEffect(() => {
    void (async () => {
      const s = await load()
      if (autoRef.current && s && !s.enabled) void openSetup()
    })()
    // 마운트 때 한 번(Vue onMounted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const digits = code.replace(/\D/g, '')

  async function enable() {
    if (!setup || working) return
    if (digits.length !== 6) { setCodeError(t('settings.twoFactor.codeFormat')); return }
    setWorking(true); setCodeError('')
    try {
      const r = await $fetch<{ recovery_codes: string[] }>('/api/auth/2fa/enable', { method: 'POST', body: { secret: setup.secret, code: digits } })
      setSetup(null)
      setCodes(r.recovery_codes || [])
      setCodesStep(true)
      setDialog('codes')
      await Promise.all([load(), fetchUser()])
    } catch { setCodeError(t('settings.twoFactor.codeWrongClock')) }
    finally { setWorking(false) }
  }

  async function regenerate() {
    if (working) return
    if (digits.length !== 6) { setCodeError(t('settings.twoFactor.codeFormat')); return }
    setWorking(true); setCodeError('')
    try {
      const r = await $fetch<{ recovery_codes: string[] }>('/api/auth/2fa/recovery-codes', { method: 'POST', body: { code: digits } })
      setCodes(r.recovery_codes || [])
      setCodesStep(false)
      setDialog('codes')
      await load()
    } catch (e) { setCodeError(errDetail(e) || t('settings.twoFactor.codeWrong')) }
    finally { setWorking(false) }
  }

  async function disable() {
    const c = code.trim()
    if (!c || working) return
    setWorking(true); setCodeError('')
    try {
      await $fetch('/api/auth/2fa/disable', { method: 'POST', body: { code: /^[\d\s]+$/.test(c) ? c.replace(/\s/g, '') : c } })
      setDialog(null)
      await Promise.all([load(), fetchUser()])
    } catch (e) { setCodeError(errDetail(e) || t('settings.twoFactor.codeWrong')) }
    finally { setWorking(false) }
  }

  async function copyCodes() {
    try { await writeClipboard(codes.join('\n')); addToast('success', t('settings.twoFactor.copied')) }
    catch { addToast('error', t('settings.twoFactor.copyFailed')) }
  }
  function downloadCodes() {
    const blob = new Blob([recoveryCodesText(appName, codes)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(appName || 'workspace').replace(/[^\w.-]+/g, '-')}-recovery-codes.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const onOtp = (v: string) => { setCode(formatOtp(v)); setCodeError('') }

  return (
    <>
      <UiCard>
        <UiCardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <UiCardTitle>{t('settings.twoFactor.title')}</UiCardTitle>
            <p className={st?.required && !st.enabled ? 'mt-1 text-[13px] font-medium text-warning' : 'mt-1 text-[13px] text-muted-foreground'}>
              {st?.required && !st.enabled ? t('settings.twoFactor.descRequired') : t('settings.twoFactor.cardDesc')}
            </p>
          </div>
          {st && <UiBadge tone={st.enabled ? 'success' : 'neutral'} tint>{st.enabled ? t('settings.twoFactor.on') : t('settings.twoFactor.off')}</UiBadge>}
        </UiCardHeader>
        <UiCardContent className="flex flex-wrap items-center gap-2">
          {!st && !loadError
            ? <UiSkeleton preset="text" rows={1} className="w-48" />
            : loadError
              ? (
                <>
                  <span className="text-[13px] text-danger">{t('settings.twoFactor.loadError')}</span>
                  <UiButton variant="outline" size="sm" onClick={() => void load()}>{t('common.retry')}</UiButton>
                </>
              )
              : st && !st.enabled
                ? <UiButton size="sm" onClick={() => void openSetup()}>{t('settings.twoFactor.turnOn')}</UiButton>
                : st && (
                  <>
                    <UiButton variant="outline" size="sm" onClick={() => open('regen')}>{t('settings.twoFactor.regenTitle')}</UiButton>
                    {st.required
                      ? <span className="text-xs text-muted-foreground">{t('settings.twoFactor.requiredNoOff')}</span>
                      : <UiButton variant="ghost" size="sm" className="text-danger" onClick={() => open('off')}>{t('settings.twoFactor.turnOff')}</UiButton>}
                  </>
                )}
        </UiCardContent>
      </UiCard>

      {dialog === 'on1' && setup && (
        <SettingsTwoFactorSetupModal
          setup={setup}
          code={code}
          codeError={codeError}
          working={working}
          onCode={onOtp}
          onNext={() => void enable()}
          onClose={() => { setDialog(null); setSetup(null) }}
        />
      )}
      {dialog === 'codes' && (
        <SettingsTwoFactorCodesModal
          codes={codes}
          step={codesStep}
          onCopy={() => void copyCodes()}
          onDownload={downloadCodes}
          onClose={() => { setDialog(null); setCodes([]) }}
        />
      )}
      {dialog === 'off' && (
        <SettingsTwoFactorOffModal
          code={code}
          codeError={codeError}
          working={working}
          onCode={(v) => { setCode(v); setCodeError('') }}
          onDisable={() => void disable()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'regen' && (
        <SettingsTwoFactorRegenModal
          remaining={st?.recovery_remaining ?? 0}
          code={code}
          codeError={codeError}
          working={working}
          onCode={onOtp}
          onRegenerate={() => void regenerate()}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

/** 코드 입력 단계 공통 props */
interface CodeStepProps {
  /** 입력 중인 코드(표기 그대로) */
  code: string
  /** 코드 오류 문구 */
  codeError: string
  /** 요청 중(확인 버튼 비활성) */
  working: boolean
  /** 코드 입력 */
  onCode: (v: string) => void
  /** 닫기(취소 · ✕ · Esc) */
  onClose: () => void
}

/**
 * 켜기 1/2(시안 #on1 · #on1err) — 520, 바깥 클릭으로 안 닫힘. QR 136 + 설정 키(읽기 전용·복사) + 6자리 코드(lg mono).
 */
export function SettingsTwoFactorSetupModal({ setup, code, codeError, working, onCode, onNext, onClose }: CodeStepProps & {
  /** /2fa/setup 응답(QR data URL · 비밀키) */
  setup: SetupData
  /** [다음 — 복구 코드] · Enter */
  onNext: () => void
}) {
  const { t } = useI18n()
  return (
    <UiModal
      title={t('settings.twoFactor.setupTitle')}
      size="520"
      persistent
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={working} onClick={onNext}>{t('settings.twoFactor.nextCodes')}</UiButton>
        </>
      )}
    >
      <p className="text-xs font-semibold text-muted-foreground">{t('settings.twoFactor.step1of2')}</p>
      <div className="flex gap-4">
        <div role="img" aria-label={t('settings.twoFactor.qrAlt')} className="grid shrink-0 place-items-center overflow-hidden rounded-md bg-paper font-mono text-[11px] text-paper-foreground" style={{ width: 136, height: 136 }}>
          {setup.qr_data_url ? <img src={setup.qr_data_url} alt="" className="h-full w-full object-contain" /> : 'QR'}
        </div>
        <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-relaxed">
          <p>{t('settings.twoFactor.scanQr')}</p>
          <p className="text-xs text-muted-foreground">{t('settings.twoFactor.typeKey')}</p>
          <UiInput readonly mono modelValue={groupSecret(setup.secret)} aria-label={t('settings.twoFactor.setupKey')} />
        </div>
      </div>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); onNext() }}>
        <UiInput
          label={t('settings.twoFactor.appCode')}
          modelValue={code}
          onUpdateModelValue={onCode}
          mono
          size="lg"
          placeholder="000 000"
          error={codeError}
          hint={t('settings.twoFactor.every30s')}
          inputMode="numeric"
          autocomplete="one-time-code"
          maxLength={7}
          data-autofocus
        />
        <button type="submit" className="hidden" />
      </form>
    </UiModal>
  )
}

/**
 * 켜기 2/2 · 새로 발급 결과(시안 #on2) — 480, 바깥 클릭으로 안 닫힘. 복구 코드 10개 2열 mono 점선 틀 + [복사][.txt 받기],
 * "저장했습니다" 체크해야 [완료].
 */
export function SettingsTwoFactorCodesModal({ codes, step = true, onCopy, onDownload, onClose }: {
  /** 복구 코드 목록 */
  codes: string[]
  /** "2 / 2 · 복구 코드 10개" 단계 표시(켜기 흐름). 새로 발급 결과면 false → "복구 코드 n개" */
  step?: boolean
  /** [복사] */
  onCopy: () => void
  /** [.txt 받기] */
  onDownload: () => void
  /** [완료] · ✕ · Esc */
  onClose: () => void
}) {
  const { t } = useI18n()
  const [saved, setSaved] = useState(false)
  return (
    <UiModal
      title={t('settings.twoFactor.keepTitle')}
      size="480"
      persistent
      onClose={onClose}
      footer={<UiButton size="sm" disabled={!saved} onClick={onClose}>{t('common.done')}</UiButton>}
    >
      <p className="text-xs font-semibold text-muted-foreground">{step ? t('settings.twoFactor.step2of2', { n: codes.length }) : t('settings.twoFactor.codesCount', { n: codes.length })}</p>
      <UiTrans k="settings.twoFactor.keepBody" as="p" className="text-[13px] leading-relaxed" slots={{ b: c => <b className="font-semibold">{c}</b> }} />
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border border-dashed border-input px-4 py-3 font-mono text-[13px]" aria-label={t('settings.twoFactor.codesTitle')}>
        {codes.map((c, i) => (
          <li key={c}><span className="mr-2 text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>{c}</li>
        ))}
      </ol>
      <div className="flex gap-2">
        <UiButton variant="outline" size="sm" icon="copy" onClick={onCopy}>{t('settings.twoFactor.copy')}</UiButton>
        <UiButton variant="outline" size="sm" icon="download" onClick={onDownload}>{t('settings.twoFactor.downloadTxt')}</UiButton>
      </div>
      <UiCheckbox label={t('settings.twoFactor.savedCheck')} modelValue={saved} onUpdateModelValue={setSaved} />
    </UiModal>
  )
}

/**
 * 끄기(시안 #off) — sm, danger. 인증 앱 코드 또는 복구 코드를 넣기 전에는 [끄기] 비활성.
 */
export function SettingsTwoFactorOffModal({ code, codeError, working, onCode, onDisable, onClose }: CodeStepProps & {
  /** [끄기] · Enter */
  onDisable: () => void
}) {
  const { t } = useI18n()
  return (
    <UiModal
      title={t('settings.twoFactor.offTitle')}
      size="sm"
      danger
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton variant="danger" size="sm" disabled={!code.trim() || working} onClick={onDisable}>{t('settings.twoFactor.turnOff')}</UiButton>
        </>
      )}
    >
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t('settings.twoFactor.offBody')}</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); onDisable() }}>
        <UiInput
          label={t('settings.twoFactor.offCode')}
          modelValue={code}
          onUpdateModelValue={onCode}
          mono
          placeholder="000 000"
          error={codeError}
          autocomplete="one-time-code"
          maxLength={20}
          data-autofocus
        />
        <button type="submit" className="hidden" />
      </form>
    </UiModal>
  )
}

/**
 * 복구 코드 새로 발급(시안 #regen) — 480. warning 띠(남은 코드 n개 폐기 · 지금 코드는 보여 줄 수 없음) + 인증 앱 코드.
 * 발급하면 2/2 와 같은 틀(SettingsTwoFactorCodesModal)로 넘어간다.
 */
export function SettingsTwoFactorRegenModal({ remaining, code, codeError, working, onCode, onRegenerate, onClose }: CodeStepProps & {
  /** 지금 남은 복구 코드 수 */
  remaining: number
  /** [새로 발급] · Enter */
  onRegenerate: () => void
}) {
  const { t } = useI18n()
  return (
    <UiModal
      title={t('settings.twoFactor.regenTitle')}
      size="480"
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={working} onClick={onRegenerate}>{t('settings.twoFactor.regenerate')}</UiButton>
        </>
      )}
    >
      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px] leading-relaxed">
        <UiIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <UiTrans
          k="settings.twoFactor.regenWarn"
          as="span"
          slots={{ b: c => <b className="font-semibold">{c}</b>, n: <span className="font-mono">{remaining}</span> }}
        />
      </div>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); onRegenerate() }}>
        <UiInput
          label={t('settings.twoFactor.regenCode')}
          modelValue={code}
          onUpdateModelValue={onCode}
          mono
          placeholder="000 000"
          error={codeError}
          inputMode="numeric"
          autocomplete="one-time-code"
          maxLength={7}
          data-autofocus
        />
        <button type="submit" className="hidden" />
      </form>
      <p className="text-xs text-muted-foreground">{t('settings.twoFactor.regenNext')}</p>
    </UiModal>
  )
}

export default SettingsTwoFactor
