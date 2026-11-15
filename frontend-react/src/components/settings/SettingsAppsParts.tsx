/**
 * 설정 › 연결된 앱 화면 조각.
 *  · SettingsConnectedAppRow — 연결된 앱 행(min 64): 글자 타일 36 + 이름 14/600 + 권한 + "연결 · 마지막 사용" + [연결 끊기]
 *  · SettingsAppPasswordRow — 앱 비밀번호 행(min 52): 이름 600 + "메일 · 캘린더 · 만든 날" + "삭제"
 *  · SettingsPatRow — 개인 액세스 토큰 행(min 48): 이름(+ 폐기됨 배지) + 만든·쓴 시각 + "폐기"
 *  · SettingsAppPasswordNewModal — 새 앱 비밀번호(이름 + 범위 체크 2) → [만들기]
 *  · SettingsAppPasswordIssuedModal — 발급된 비밀번호 한 번만 보여 주기 → [완료]
 */
import type { FormEvent, ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiButton } from '~/components/ui/Button'
import { UiBadge } from '~/components/ui/Badge'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { SettingsTextAction } from './SettingsTextAction'

export interface SettingsConnectedAppRowProps {
  /** 앱 이름(첫 글자가 타일) */
  name: string
  /** 권한 이름들(없으면 줄 생략) */
  scopeLabels: string[]
  /** "연결 {since} · 마지막 사용 {last}" 줄(UiTrans 로 만든 노드) */
  since: ReactNode
  /** 버튼 비활성 */
  disabled?: boolean
  /** [연결 끊기] */
  onDisconnect: () => void
}

/** OAuth 로 연결된 앱 한 줄 */
export function SettingsConnectedAppRow({ name, scopeLabels, since, disabled = false, onDisconnect }: SettingsConnectedAppRowProps) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-16 items-center gap-3 border-t border-border px-5 py-2.5 text-[13px]">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary/15 font-bold text-primary" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-foreground">{name}</div>
        {scopeLabels.length > 0 && <div className="truncate text-xs text-muted-foreground">{scopeLabels.join(' · ')}</div>}
        <div className="text-xs text-muted-foreground">{since}</div>
      </div>
      <UiButton variant="outline" size="xs" className="shrink-0 font-semibold text-danger hover:text-danger" disabled={disabled} onClick={onDisconnect}>{t('settings.apps.disconnect')}</UiButton>
    </div>
  )
}

export interface SettingsAppPasswordRowProps {
  /** 이름 */
  name: string
  /** "메일 · 캘린더 · 만든 날 MM/DD" */
  meta: string
  /** 마지막 사용(있으면 " · 마지막 사용 …") */
  lastUsed?: string
  /** 삭제 버튼 비활성 */
  disabled?: boolean
  /** [삭제] */
  onDelete: () => void
}

/** 앱 비밀번호 한 줄 */
export function SettingsAppPasswordRow({ name, meta, lastUsed, disabled = false, onDelete }: SettingsAppPasswordRowProps) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
      <span className="min-w-0 flex-1">
        <b className="block truncate font-semibold text-foreground">{name}</b>
        <span className="block truncate text-xs text-muted-foreground">{meta}{lastUsed && <> · {t('settings.appPw.lastUsed', { date: lastUsed })}</>}</span>
      </span>
      <SettingsTextAction disabled={disabled} aria-label={t('settings.appPw.deleteAria', { name })} onClick={onDelete}>{t('common.delete')}</SettingsTextAction>
    </div>
  )
}

export interface SettingsPatRowProps {
  /** 토큰 이름 */
  name: string
  /** 폐기됨(흐리게 + 배지, 폐기 버튼 없음) */
  revoked: boolean
  /** 만든 시각 */
  created: string
  /** 마지막 사용 시각 */
  used: string
  /** [폐기] */
  onRevoke: () => void
}

/** AI 커넥터 개인 액세스 토큰 한 줄 */
export function SettingsPatRow({ name, revoked, created, used, onRevoke }: SettingsPatRowProps) {
  const { t } = useI18n()
  return (
    <div className={cn('flex min-h-12 items-center gap-3 border-t border-border px-5 py-2 text-[13px]', revoked ? 'opacity-50' : '')}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          {name}
          {revoked && <UiBadge tone="danger" tint size={18}>{t('settings.apps.revoked')}</UiBadge>}
        </div>
        <div className="text-xs text-muted-foreground">{t('settings.apps.tokenMeta', { created, used })}</div>
      </div>
      {!revoked && (
        <button type="button" className="relative text-xs font-semibold text-danger hover:underline after:absolute after:-inset-3 after:content-['']" onClick={onRevoke}>{t('settings.apps.revoke')}</button>
      )}
    </div>
  )
}

export interface AppPasswordDraft { name: string; mail: boolean; dav: boolean; error: string; saving: boolean }

export interface SettingsAppPasswordNewModalProps {
  /** 입력 상태 */
  draft: AppPasswordDraft
  /** 일부 바꾸기 */
  onChange: (patch: Partial<AppPasswordDraft>) => void
  /** [만들기] · Enter */
  onCreate: () => void
  /** 닫기 */
  onClose: () => void
}

/** 새 앱 비밀번호 모달(440) */
export function SettingsAppPasswordNewModal({ draft, onChange, onCreate, onClose }: SettingsAppPasswordNewModalProps) {
  const { t } = useI18n()
  return (
    <UiModal
      title={t('settings.appPw.newTitle')}
      size="440"
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={draft.saving} onClick={onCreate}>{t('settings.appPw.create')}</UiButton>
        </>
      )}
    >
      <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); onCreate() }}>
        <UiInput
          modelValue={draft.name}
          onUpdateModelValue={v => onChange({ name: v, error: '' })}
          label={t('settings.appPw.name')}
          placeholder={t('settings.appPw.namePlaceholder')}
          error={draft.error}
          maxLength={100}
        />
        <fieldset className="flex flex-col">
          <legend className="mb-1 text-xs font-semibold text-muted-foreground">{t('settings.appPw.scopes')}</legend>
          <UiCheckbox modelValue={draft.mail} onUpdateModelValue={v => onChange({ mail: v })} label={t('settings.appPw.scopeMail')} description={t('settings.appPw.scopeMailDesc')} />
          <UiCheckbox modelValue={draft.dav} onUpdateModelValue={v => onChange({ dav: v })} label={t('settings.appPw.scopeDav')} description={t('settings.appPw.scopeDavDesc')} />
        </fieldset>
        <button type="submit" className="hidden" />
      </form>
    </UiModal>
  )
}

/** 발급된 앱 비밀번호(한 번만) 모달(440, 바깥 클릭으로 안 닫힘) */
export function SettingsAppPasswordIssuedModal({ name, password, onClose }: {
  /** 앱 비밀번호 이름(제목) */
  name: string
  /** 발급된 비밀번호(읽기 전용 + 복사) */
  password: string
  /** [완료] · ✕ · Esc */
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <UiModal
      title={t('settings.appPw.issuedTitle', { name })}
      size="440"
      persistent
      onClose={onClose}
      footer={<UiButton size="sm" onClick={onClose}>{t('settings.appPw.done')}</UiButton>}
    >
      <p className="text-[13px] text-warning">{t('settings.appPw.issuedOnce')}</p>
      <UiInput modelValue={password} readonly mono label={t('settings.appPw.password')} />
      <p className="text-xs text-muted-foreground">{t('settings.appPw.issuedHint')}</p>
    </UiModal>
  )
}
