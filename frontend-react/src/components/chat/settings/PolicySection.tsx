/**
 * 서버 전역 정책(사용자 지시 — 전역 관리자에게만 표시): UiSwitch 두 개, 즉시 저장(PUT /api/chat/policy, 감사 로그 chat.policy.*).
 * (1) 전역 관리자에게 채널 내 특권 부여(1:1 대화·비공개 채널 열람 포함) — 기본 비활성. 활성화 시 개인정보 경고 확인 대화 상자 표시.
 * (2) 채널 소유자가 타 사용자의 메시지를 삭제할 수 있음 — 기본 비활성.
 * 서버가 미지원이면(404) "서버가 아직 지원하지 않음" banner, can_edit false 이면 잠금.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { UiSwitch } from '~/components/ui/Switch'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { fetchChatPolicy, updateChatPolicy, type ChatPolicy } from '~/composables/useChatRoles'
import { MobileHeader, SettingsBanner, SettingsHeader, errorText, statusOf, useSettingsCtx } from './parts'

type PolicyKey = 'admin_channel_privileges' | 'owner_manage_messages'

/** 활성화 전 확인 필요 여부 — (1)을 활성화할 때만 */
export function policyNeedsConfirm(key: PolicyKey, next: boolean): boolean {
  return key === 'admin_channel_privileges' && next
}

export function PolicySection() {
  const { t } = useI18n()
  const { mobile, backToMenu } = useSettingsCtx()
  const [pol, setPol] = useState<ChatPolicy | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'unsupported' | 'error'>('loading')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchChatPolicy()
      .then(p => { setPol(p); setState('ok') })
      .catch(e => setState(statusOf(e) === 404 ? 'unsupported' : 'error'))
  }, [])

  async function toggle(key: PolicyKey, next: boolean) {
    if (!pol) return
    if (policyNeedsConfirm(key, next)) {
      const ok = await confirmBox(t('chat.settings.policy.adminConfirm'), {
        title: t('chat.settings.policy.adminConfirmTitle'), danger: true, confirmLabel: t('chat.settings.policy.adminConfirmOk'), size: '440',
      })
      if (!ok) return
    }
    const prev = pol
    setPol({ ...pol, [key]: next })
    setBusy(true)
    try { setPol(await updateChatPolicy({ [key]: next })); addToast('success', t('chat.settings.policy.saved')) } catch (e) {
      setPol(prev)
      addToast('error', errorText(e, t('chat.settings.policy.saveFail')))
    } finally { setBusy(false) }
  }

  const locked = !pol?.can_edit || busy
  const body = (
    <div className="flex flex-col gap-4">
      {state === 'unsupported' && <SettingsBanner tone="info" icon="info">{t('chat.settings.policy.unsupported')}</SettingsBanner>}
      {state === 'error' && <SettingsBanner tone="danger" icon="alert-circle">{t('chat.settings.policy.loadFail')}</SettingsBanner>}
      {state === 'ok' && pol && !pol.can_edit && <SettingsBanner tone="info" icon="lock">{t('chat.settings.policy.readOnly')}</SettingsBanner>}
      {state === 'ok' && pol && (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border p-3">
            <UiSwitch
              className="flex w-full"
              label={t('chat.settings.policy.admin')}
              description={t('chat.settings.policy.adminDesc')}
              modelValue={pol.admin_channel_privileges}
              disabled={locked}
              onUpdateModelValue={v => void toggle('admin_channel_privileges', v)}
            />
          </div>
          <div className="rounded-lg border border-border p-3">
            <UiSwitch
              className="flex w-full"
              label={t('chat.settings.policy.owner')}
              description={t('chat.settings.policy.ownerDesc')}
              modelValue={pol.owner_manage_messages}
              disabled={locked}
              onUpdateModelValue={v => void toggle('owner_manage_messages', v)}
            />
          </div>
        </div>
      )}
      {state === 'loading' && <p className="text-[13px] text-muted-foreground">{t('common.loading')}</p>}
    </div>
  )
  if (mobile) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title={t('chat.settings.policy.title')} onBack={backToMenu} />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{body}</div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title={t('chat.settings.policy.title')} sub={t('chat.settings.policy.sub')} />
      {body}
    </div>
  )
}

export default PolicySection
