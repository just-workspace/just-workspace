/**
 * 설정 › 메일 화면 조각.
 *  · SettingsMailAccountRow — 계정 행: 메일 타일 36(기본=primary) + 주소(+기본·내장 배지) + 상태 줄 + [다시 연결]/[편집] + ⋮ 메뉴
 *  · SettingsMdnRow — 읽음 확인 요청 응답 기본값 행(선택 180 + 저장됨)
 *  · SettingsSignatureRow — 서명 행: 이름(+기본 배지) + 본문 미리보기 + [기본으로] + 편집·삭제 아이콘
 *  · SettingsSignatureModal — 서명 만들기·고치기 모달
 *  · SettingsMailArchiveRow — 외부 계정 .eml 보관 행: 주소 + 상태/백필 진행 + [지난 메일 보관] + 스위치
 *  · SettingsMailDisabledRow — 서버 API 없는 기능(자동 전달·자동 응답)의 꺼진 스위치 행
 */
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import type { MailAccountInfo } from '~/composables/useMail'
import { UiIcon } from '~/components/ui/Icon'
import { UiBadge } from '~/components/ui/Badge'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiButton } from '~/components/ui/Button'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSelect } from '~/components/ui/Select'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSwitch } from '~/components/ui/Switch'
import { SettingsSavedMark } from './SettingsSavedMark'

/** 프로토콜 표기 — POP3/SMTP · IMAP/SMTP */
export function mailProtocolLabel(a: Pick<MailAccountInfo, 'protocol'>): string {
  return a.protocol === 'pop3' ? 'POP3/SMTP' : 'IMAP/SMTP'
}

/** 마지막 동기화 HH:MM(로컬). 없으면 '' */
export function mailSyncTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface SettingsMailAccountRowProps {
  /** 계정 */
  account: MailAccountInfo
  /** 첫 행이 아니면 위 선 */
  divided: boolean
  /** ⋮ 메뉴 항목 */
  menuItems: UiMenuItem[]
  /** ⋮ 메뉴 고름 */
  onMenu: (key: string) => void
  /** [다시 연결]·[편집] — /mail/accounts 로 */
  onEdit: () => void
}

/** 메일 계정 한 줄 */
export function SettingsMailAccountRow({ account: a, divided, menuItems, onMenu, onEdit }: SettingsMailAccountRowProps) {
  const { t } = useI18n()
  return (
    <div className={cn('flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap', divided ? 'border-t border-border' : '')}>
      <span
        className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-md', a.is_default ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}
        aria-hidden="true"
      ><UiIcon name="mail" className="h-[17px] w-[17px]" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <span className="truncate">{a.email}</span>
          {a.is_default && <UiBadge tone="neutral" tint size={18}>{t('common.default')}</UiBadge>}
          {a.is_builtin && <UiBadge tone="primary" tint size={18}>{t('mail.accounts.builtin')}</UiBadge>}
        </div>
        {a.sync_error
          ? (
            <div className="flex items-center gap-1.5 text-xs font-medium text-danger">
              <UiStatusDot status="failed" size={8} label={t('settings.mail.loginFailed')} />{t('settings.mail.loginFailed')} — {a.sync_error}
            </div>
          )
          : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <UiStatusDot status="ok" size={8} label={t('settings.mail.statusOk')} />{t('settings.mail.statusOk')} · {mailProtocolLabel(a)}
              {a.last_sync_at && <> · {t('settings.mail.lastSync')} <span className="font-mono">{mailSyncTime(a.last_sync_at)}</span></>}
            </div>
          )}
      </div>
      {a.sync_error && !a.is_builtin
        ? <UiButton size="xs" onClick={onEdit}>{t('settings.mail.reconnect')}</UiButton>
        : !a.is_builtin
          ? <UiButton variant="outline" size="xs" onClick={onEdit}>{t('settings.mail.edit')}</UiButton>
          : null}
      <UiMenu
        label={t('settings.mail.accountMenu')}
        items={menuItems}
        width={180}
        onSelect={onMenu}
        trigger={({ toggle, open, controls }) => (
          <UiIconButton label={t('settings.mail.accountMenu')} icon="more-vertical" aria-haspopup="menu" aria-expanded={open} aria-controls={controls} onClick={toggle} />
        )}
      />
    </div>
  )
}

export interface SettingsMdnRowProps {
  /** ask · always · never */
  modelValue: string
  /** 바꿈 */
  onUpdateModelValue: (v: string | number | null) => void
  /** "저장됨 ✓" */
  saved: boolean
}

/** 읽음 확인 요청 응답 기본값 행 */
export function SettingsMdnRow({ modelValue, onUpdateModelValue, saved }: SettingsMdnRowProps) {
  const { t } = useI18n()
  const MDN_OPTIONS = [{ value: 'ask', label: t('settings.mail.mdnAsk') }, { value: 'always', label: t('settings.mail.mdnAlways') }, { value: 'never', label: t('settings.mail.mdnNever') }]
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{t('settings.mail.mdnTitle')}</div>
        <div className="text-muted-foreground">{t('settings.mail.mdnDesc')}</div>
      </div>
      {saved && <SettingsSavedMark iconSize={14} />}
      <UiSelect modelValue={modelValue} onUpdateModelValue={onUpdateModelValue} options={MDN_OPTIONS} className="w-[180px]" aria-label={t('settings.mail.mdnTitle')} />
    </div>
  )
}

export interface SettingsSignatureRowProps {
  /** 이름 */
  name: string
  /** 본문 미리보기(태그 뺀 100자) */
  preview: string
  /** 기본 서명 */
  isDefault: boolean
  /** [기본으로] */
  onSetDefault: () => void
  /** 편집 */
  onEdit: () => void
  /** 삭제 */
  onDelete: () => void
}

/** 서명 한 줄 */
export function SettingsSignatureRow({ name, preview, isDefault, onSetDefault, onEdit, onDelete }: SettingsSignatureRowProps) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-12 items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          {name}
          {isDefault && <UiBadge tone="primary" tint size={18}>{t('common.default')}</UiBadge>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{preview}</div>
      </div>
      {!isDefault && <UiButton variant="ghost" size="xs" className="text-muted-foreground" onClick={onSetDefault}>{t('profile.sigSetDefault')}</UiButton>}
      <UiIconButton label={t('common.edit')} icon="edit" onClick={onEdit} />
      <UiIconButton label={t('common.delete')} icon="trash" className="text-danger hover:text-danger" onClick={onDelete} />
    </div>
  )
}

export interface SignatureDraft { name: string; html_content: string; is_default: boolean }

export interface SettingsSignatureModalProps {
  /** 고치는 중(제목이 "서명 편집") */
  editing: boolean
  /** 입력 상태 */
  form: SignatureDraft
  /** 일부 바꾸기 */
  onChange: (patch: Partial<SignatureDraft>) => void
  /** 오류 문구 */
  error: string
  /** 저장 중 */
  submitting: boolean
  /** [저장] */
  onSubmit: () => void
  /** 닫기 */
  onClose: () => void
}

/** 서명 만들기·고치기 모달(md) */
export function SettingsSignatureModal({ editing, form, onChange, error, submitting, onSubmit, onClose }: SettingsSignatureModalProps) {
  const { t } = useI18n()
  return (
    <UiModal
      title={editing ? t('profile.sigEditTitle') : t('profile.sigNew')}
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={submitting} onClick={onSubmit}>{submitting ? t('common.saving') : t('common.save')}</UiButton>
        </>
      )}
    >
      <UiInput modelValue={form.name} onUpdateModelValue={v => onChange({ name: v })} label={t('profile.sigNameLabel')} placeholder={t('profile.sigNamePlaceholder')} />
      <UiTextarea
        modelValue={form.html_content}
        onUpdateModelValue={v => onChange({ html_content: v })}
        label={t('profile.sigContentLabel')}
        rows={4}
        mono
        placeholder={`<p>${t('settings.mail.signatureSampleName')}<br>${t('settings.mail.signatureSampleCompany')}</p>`}
      />
      <UiCheckbox modelValue={form.is_default} onUpdateModelValue={v => onChange({ is_default: v })} label={t('profile.sigSetDefaultLabel')} />
      {error && <UiErrorTile title={error} noRetry />}
    </UiModal>
  )
}

export interface SettingsMailArchiveRowProps {
  /** 외부 계정 */
  account: MailAccountInfo
  /** 백필 진행(없으면 상태 줄) */
  progress?: { scanned: number; saved: number }
  /** 처리 중(버튼·스위치 비활성) */
  busy: boolean
  /** [지난 메일 보관] */
  onBackfill: () => void
  /** 스위치 */
  onToggle: (v: boolean) => void
}

/** 외부 계정 .eml 보관 행 */
export function SettingsMailArchiveRow({ account: a, progress, busy, onBackfill, onToggle }: SettingsMailArchiveRowProps) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-2.5 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{a.email}</div>
        <div className="text-xs text-muted-foreground">
          {progress
            ? <>{t('settings.mail.backfillRunning')} · {t('settings.mail.backfillScanned')} <span className="font-mono">{progress.scanned}</span> · {t('settings.mail.backfillSaved')} <span className="font-mono">{progress.saved}</span></>
            : <>{a.archive_enabled ? t('settings.mail.archiveOn') : t('settings.mail.archiveOff')} · {mailProtocolLabel(a)}</>}
        </div>
      </div>
      {a.archive_enabled && <UiButton variant="outline" size="xs" disabled={busy} onClick={onBackfill}>{t('settings.mail.backfill')}</UiButton>}
      <UiSwitch modelValue={!!a.archive_enabled} disabled={busy} ariaLabel={t('settings.mail.archiveToggle', { email: a.email })} onUpdateModelValue={onToggle} />
    </div>
  )
}

/** 아직 서버 API 가 없는 기능의 꺼진 스위치 행(흐린 제목 + "준비 중") */
export function SettingsMailDisabledRow({ title, ariaLabel }: {
  /** 행 제목 */
  title: string
  /** 스위치 aria-label */
  ariaLabel: string
}) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3 border-t border-border px-5 py-2.5 text-[13px] text-muted-foreground">
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-foreground/80">{title}</div>
        <div className="text-xs">{t('settings.mail.notReady')}</div>
      </div>
      <UiSwitch modelValue={false} disabled ariaLabel={ariaLabel} />
    </div>
  )
}
