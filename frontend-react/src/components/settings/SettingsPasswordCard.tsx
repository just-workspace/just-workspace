/**
 * 비밀번호 카드.
 * 제목 + "마지막 변경 YYYY-MM-DD", 2열(현재 비밀번호 전체 폭 / 새 비밀번호 + 규칙 체크 목록),
 * 체크 목록: "8자 이상" · "흔한 비밀번호 아님" · "아이디·이메일과 다름". 길이·아이디는 입력 즉시 판정하고,
 * 흔한 비밀번호는 서버 블록리스트이므로 POST /api/auth/password-check 응답 수신 후에만 통과로 표시한다(그 전에는 빈 원).
 * 푸터 = 왼쪽 "변경하면 다른 기기는 모두 로그아웃됩니다" + 오른쪽 [비밀번호 변경](입력 전 opacity .5).
 * 확인 칸은 시안대로 없음(보기 토글로 대체). 성공 시 머리에 "저장됨 ✓" 2초 표시.
 * 동작(POST /api/auth/change-password)까지 본 컴포넌트가 담당한다.
 *
 * @example <SettingsPasswordCard />
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useI18n } from '~/i18n'
import { changePassword, useAuth } from '~/composables/useAuth'
import { errText } from '~/utils/errText'
import { $fetch } from '~/lib/api'
import { PASSWORD_MIN, stripContext, type PasswordRuleResult } from '~/utils/passwordRules'
import { AuthPasswordRules } from '~/components/auth/AuthPasswordRules'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiButton } from '~/components/ui/Button'
import { SettingsCard } from './SettingsCard'

/** password_changed_at → YYYY-MM-DD(로컬). 없거나 형식 오류이면 '' */
export function passwordChangedDay(v: string | null | undefined): string {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 서버 판정(POST /api/auth/password-check) */
interface PwCheck { length: boolean; common: boolean; context: boolean; ok: boolean }

/** 체크 목록 결과 — 순서: 8자 이상 · 흔한 비밀번호 아님(서버 응답 후) · 아이디·이메일과 다름 */
export function settingsPasswordRules(pw: string, context: Array<string | null | undefined>, server: PwCheck | null): PasswordRuleResult[] {
  const p = (pw ?? '').normalize('NFKC')
  const n = p.length
  const low = p.toLowerCase()
  return [
    { key: 'length', ok: n >= PASSWORD_MIN, required: true, n },
    { key: 'common', ok: n >= PASSWORD_MIN && !!server && !server.common, required: true, n },
    { key: 'distinct', ok: n > 0 && !(stripContext(low, context) !== low && stripContext(low, context).length < PASSWORD_MIN), required: true, n },
  ]
}

export function SettingsPasswordCard() {
  const { t } = useI18n()
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [fieldErr, setFieldErr] = useState<{ newPassword?: string }>({})
  const [success, setSuccess] = useState(false)
  const [saving, setSaving] = useState(false)

  // 흔한 비밀번호 판정 — 입력 정지 후(400ms) 서버에 조회하고, 응답 수신 후에만 표시한다
  const [server, setServer] = useState<PwCheck | null>(null)
  const checkSeq = useRef(0)
  useEffect(() => {
    setServer(null)
    if (newPassword.normalize('NFKC').length < PASSWORD_MIN) return
    const seq = ++checkSeq.current
    const timer = setTimeout(() => {
      void $fetch<PwCheck>('/api/auth/password-check', { method: 'POST', body: { password: newPassword } })
        .then((r) => {
          if (seq !== checkSeq.current) return
          setServer(r)
          if (r.common) setFieldErr({ newPassword: t('settings.password.commonError') })
          else if (r.context) setFieldErr({ newPassword: t('settings.password.contextError') })
        })
        .catch(() => { /* 판정 실패 — 저장 시 서버가 재검증한다 */ })
    }, 400)
    return () => clearTimeout(timer)
  }, [newPassword, t])
  const rules = settingsPasswordRules(newPassword, [user?.username, user?.email], server)

  const lastChanged = passwordChangedDay(user?.password_changed_at)
  const ready = !!current && !!newPassword
  function reset() { setCurrent(''); setNewPassword(''); setError(''); setFieldErr({}) }

  async function save() {
    setError(''); setFieldErr({}); setSuccess(false)
    if (!ready) { setError(t('validation.allFieldsRequired')); return }
    if (newPassword.length < 8) { setFieldErr({ newPassword: t('validation.passwordTooShort') }); return }
    if (newPassword === current) { setFieldErr({ newPassword: t('settings.password.sameAsOld') }); return }
    setSaving(true)
    try {
      await changePassword(current, newPassword)
      reset()
      setSuccess(true)
      setTimeout(() => { setSuccess(false) }, 2000)
    } catch (e) {
      setError(errText(e, t('profile.passwordChangeError')))
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      title={t('settings.password.title')}
      description={lastChanged ? t('settings.password.lastChanged', { date: lastChanged }) : t('settings.password.neverChanged')}
      saved={success}
      flush
    >
      <form className="grid gap-x-4 gap-y-3.5 px-5 py-4 sm:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); void save() }}>
        <UiPasswordInput id="current_password" modelValue={current} onUpdateModelValue={setCurrent} label={t('fields.currentPassword')} autocomplete="current-password" className="sm:col-span-2" />
        <UiPasswordInput
          id="new_password"
          modelValue={newPassword}
          onUpdateModelValue={setNewPassword}
          label={t('fields.newPassword')}
          autocomplete="new-password"
          error={fieldErr.newPassword}
          onInput={() => setFieldErr({})}
        />
        <div className="flex items-end pb-2.5"><AuthPasswordRules results={rules} contextLabel={t('settings.password.contextTarget')} /></div>
        {error && <UiErrorTile title={error} noRetry className="sm:col-span-2" />}
        <button type="submit" className="hidden" />
      </form>
      <div className="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3">
        <span className="mr-auto text-xs text-muted-foreground">{t('settings.password.othersSignedOut')}</span>
        <UiButton size="sm" className={ready ? '' : 'opacity-50'} disabled={saving} onClick={() => void save()}>{saving ? t('settingsCard.saving') : t('settings.password.submit')}</UiButton>
      </div>
    </SettingsCard>
  )
}

export default SettingsPasswordCard
