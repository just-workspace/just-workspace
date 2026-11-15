// Vue 원본: frontend/pages/settings/account.vue
// 설정 › 계정: 아바타 64 + 이름·가입 정보 + [사진 바꾸기], 표시 이름·복구 이메일 2열, CalDAV/CardDAV 읽기 전용 + 복사,
// 카드 푸터 [되돌리기][저장]. 아래 로그인된 기기 카드(SettingsDevices — 내 세션 목록·개별 로그아웃).
// 복구 이메일은 저장 즉시 바뀌지 않는다(비밀번호 재설정 링크가 가는 주소 — 세션 탈취만으로 바뀌면 안 된다):
// 주소를 고치면 본인 확인 칸(현재 비밀번호)이 나타나고, 저장하면 새 주소로 확인 메일이 간다. 링크를 눌러야 바뀐다.
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useSiteConfig } from '~/composables/useSiteConfig'
import {
  cancelRecoveryEmailChange, getRecoveryEmailPending, requestRecoveryEmailChange, updateProfile, uploadAvatar, useAuth,
  type RecoveryReauth,
} from '~/composables/useAuth'
import { UiInput } from '~/components/ui/Input'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { SettingsAvatarRow } from '~/components/settings/SettingsAvatarRow'
import { SettingsDevices } from '~/components/settings/SettingsDevices'

interface ProfileForm { display_name: string; recovery_email: string }

export default function SettingsAccountPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('profile.navAccount')} | ${appName}` })

  const { user } = useAuth()
  const appUrl = window.location.origin

  // 아바타
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  async function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const target = e.target
    const file = target.files?.[0]
    if (!file) return
    setAvatarError('')
    setAvatarUploading(true)
    try { await uploadAvatar(file) }
    catch (err) { setAvatarError((err as { data?: { detail?: string } })?.data?.detail || t('profile.avatarUploadError')) }
    finally { setAvatarUploading(false); target.value = '' }
  }

  // 프로필 폼(변경 감지) — watch(user, immediate): 사용자 정보가 바뀌면 원본·폼을 다시 채운다
  const [original, setOriginal] = useState<ProfileForm>({ display_name: '', recovery_email: '' })
  const [form, setForm] = useState<ProfileForm>({ display_name: '', recovery_email: '' })
  useEffect(() => {
    const o = { display_name: user?.display_name || '', recovery_email: user?.recovery_email || '' }
    setOriginal(o)
    setForm(o)
  }, [user])

  const nameChanged = form.display_name !== original.display_name
  const emailChanged = form.recovery_email.trim() !== original.recovery_email
  const changes = Number(nameChanged) + Number(emailChanged)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState<{ recovery_email?: string; proof?: string }>({})

  // 복구 이메일 변경 — 본인 확인 수단(서버가 알려 준다)과 확인 대기 중인 새 주소
  const [reauth, setReauth] = useState<RecoveryReauth>('password')
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [proof, setProof] = useState('')
  const [cancelling, setCancelling] = useState(false)
  useEffect(() => {
    let alive = true
    getRecoveryEmailPending()
      .then((r) => { if (alive && r) { if (r.reauth) setReauth(r.reauth); setPendingEmail(r.pending_email ?? null) } })
      .catch(() => { /* 표시용 — 못 읽으면 기본(비밀번호 확인)으로 둔다 */ })
    return () => { alive = false }
  }, [])

  function reset() { setForm({ ...original }); setProof(''); setError(''); setFieldError({}) }
  async function save() {
    setError(''); setFieldError({})
    const email = form.recovery_email.trim()
    if (emailChanged && !proof.trim()) {
      setFieldError({ proof: reauth === 'totp'
        ? t('settings.account.recovery.codeRequired', '인증 앱 코드를 입력하세요')
        : t('settings.account.recovery.passwordRequired', '현재 비밀번호를 입력하세요') })
      return
    }
    setSaving(true)
    try {
      // 복구 이메일 요청을 먼저 — 이름 저장이 먼저 끝나면 사용자 정보가 다시 읽히며 고치던 주소가 원래 값으로 돌아간다
      if (emailChanged) {
        const r = await requestRecoveryEmailChange(email, reauth === 'totp' ? { code: proof.trim() } : { current_password: proof })
        setProof('')
        if (r?.cleared) {
          // 주소를 비운 경우 — 확인할 새 주소가 없어 바로 적용된다(사용자 정보가 다시 읽혀 폼이 빈 값으로 맞춰진다)
          setPendingEmail(null)
        } else {
          setPendingEmail(r?.pending_email || email)
          setForm(f => ({ ...f, recovery_email: original.recovery_email }))
        }
      }
      if (nameChanged) await updateProfile({ display_name: form.display_name.trim() })
    } catch (e) {
      const detail = (e as { data?: { detail?: unknown } })?.data?.detail
      const msg = Array.isArray(detail)
        ? detail.map((d: { msg?: string }) => d.msg?.replace('Value error, ', '') || d.msg).join(', ')
        : (typeof detail === 'string' ? detail : t('profile.updateError'))
      if (emailChanged && /비밀번호|password|인증 코드|본인 확인/i.test(msg)) setFieldError({ proof: msg })
      else if (/email|이메일|메일|주소/i.test(msg)) setFieldError({ recovery_email: msg })
      else setError(msg)
    } finally { setSaving(false) }
  }
  async function cancelPending() {
    setCancelling(true)
    try { await cancelRecoveryEmailChange(); setPendingEmail(null) }
    catch { setError(t('profile.updateError')) }
    finally { setCancelling(false) }
  }

  // 가입일(시안 "2024년 3월 가입")은 /api/auth/me 에 없음(백엔드 갭) — 표시하지 않는다
  const caldav = `${appUrl}/dav/calendars/${user?.username || ''}/`
  const carddav = `${appUrl}/dav/addressbooks/${user?.username || ''}/`

  return (
    <>
      <SettingsHeader title={t('profile.navAccount')} subtitle={t('settings.account.subtitle')} />

      <SettingsCard mobileBar="save" changes={changes} saving={saving} onSave={() => void save()} onReset={reset}>
        <SettingsAvatarRow
          avatarUrl={user?.avatar_url}
          alt={user?.display_name || ''}
          fallback={(user?.display_name || user?.username || '?').charAt(0).toUpperCase()}
          name={user?.display_name || user?.username || ''}
          role={user?.is_admin ? t('common.role.admin') : t('settings.account.member')}
          error={avatarError}
          uploading={avatarUploading}
          onFileChange={e => void handleAvatarChange(e)}
        />

        <form className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); void save() }}>
          <UiInput id="display_name" modelValue={form.display_name} onUpdateModelValue={v => setForm(f => ({ ...f, display_name: v }))} label={t('fields.displayName')} hint={t('settings.account.displayNameHint')} />
          <UiInput id="recovery_email" modelValue={form.recovery_email} onUpdateModelValue={v => setForm(f => ({ ...f, recovery_email: v }))} type="email" label={t('fields.recoveryEmail')} hint={reauth === 'none' ? t('settings.account.recovery.noReauth', '이 계정은 본인 확인 수단이 없어 직접 바꿀 수 없습니다. 관리자에게 요청하세요.') : t('profile.recoveryEmailHint')} error={fieldError.recovery_email} placeholder={t('register.recoveryEmailPlaceholder')} disabled={reauth === 'none'} />
          {/* 주소를 고쳤을 때만 — 본인 확인(현재 비밀번호, 비밀번호를 확인할 수 없는 계정은 인증 앱 코드) */}
          {emailChanged && reauth !== 'none' && (
            <UiInput
              id="recovery_proof"
              modelValue={proof}
              onUpdateModelValue={setProof}
              type={reauth === 'totp' ? 'text' : 'password'}
              autocomplete={reauth === 'totp' ? 'one-time-code' : 'current-password'}
              inputMode={reauth === 'totp' ? 'numeric' : undefined}
              mono={reauth === 'totp'}
              required
              label={reauth === 'totp' ? t('settings.account.recovery.code', '인증 앱 코드') : t('settings.account.recovery.password', '현재 비밀번호')}
              hint={form.recovery_email.trim()
                ? t('settings.account.recovery.proofHint', '복구 이메일을 바꾸려면 본인 확인이 필요합니다. 저장하면 새 주소로 확인 메일을 보내고, 메일의 링크를 눌러야 바뀝니다.')
                : t('settings.account.recovery.clearHint', '복구 이메일을 지우면 비밀번호를 잊었을 때 재설정 링크를 받을 수 없습니다. 저장하면 바로 지워집니다.')}
              error={fieldError.proof}
              className="sm:col-span-2"
            />
          )}
          {pendingEmail && (
            <div role="status" data-testid="recovery-pending" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[13px] sm:col-span-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground">{t('settings.account.recovery.pendingTitle', '확인 메일을 보냈습니다')}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{pendingEmail}</p>
                <p className="text-xs text-muted-foreground">{t('settings.account.recovery.pendingNote', '메일의 링크를 눌러야 복구 이메일이 바뀝니다. 그 전까지는 지금 주소가 그대로 쓰입니다.')}</p>
              </div>
              <button type="button" className="shrink-0 text-xs font-semibold text-primary hover:underline disabled:opacity-60" disabled={cancelling} onClick={() => void cancelPending()}>
                {t('settings.account.recovery.cancel', '요청 취소')}
              </button>
            </div>
          )}
          <UiInput modelValue={user?.username ?? null} label={t('fields.username')} disabled />
          <UiInput modelValue={user?.primary_email || user?.email || null} label={t('fields.email')} disabled />
          <UiInput modelValue={caldav} label={t('profile.caldavLabel')} readonly mono className="sm:col-span-2" />
          <UiInput modelValue={carddav} label={t('profile.carddavLabel')} readonly mono className="sm:col-span-2" />
          <p className="text-xs text-muted-foreground sm:col-span-2">{/* Vue 처럼 한 텍스트 노드로(노드가 갈리면 글자 배치가 1px 어긋남) */}{`${t('profile.syncDescription')} ${t('profile.syncPasswordHint')}`}</p>
          {error && <UiErrorTile title={error} noRetry className="sm:col-span-2" />}
        </form>
      </SettingsCard>

      {/* 로그인된 기기 — GET /api/auth/me/sessions (개별 로그아웃 · 다른 기기 모두 로그아웃) */}
      <SettingsDevices />
    </>
  )
}
