/**
 * 설정 › 알림 화면 조각 — Vue pages/settings/notifications.vue 의 인라인 마크업을 이름 붙여 뺀 것.
 *  · SettingsBrowserPermissionRow — 브라우저 알림 권한 행(상태 점 + "브라우저 알림: 허용됨 · Chrome" + [허용]/[시험 알림])
 *  · SettingsDndRow — 방해 금지 일정 행(요약 + [바꾸기] + 지금 적용 중 배지 + 저장됨 + 스위치)
 *  · SettingsNotifyMatrix — 종류 × 앱 안·푸시·이메일 체크 표(머리 36 + 행 min 48, 좁으면 열 56)
 *  · SettingsDndEditModal — 요일 칩 7 + 시작·끝 시각 + 안내 + 오류 → [취소][저장](440)
 */
import { useI18n } from '~/i18n'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiBadge } from '~/components/ui/Badge'
import { UiSwitch } from '~/components/ui/Switch'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiModal } from '~/components/ui/Modal'
import { UiChip } from '~/components/ui/Chip'
import { UiInput } from '~/components/ui/Input'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiButton } from '~/components/ui/Button'
import { SettingsSavedMark } from './SettingsSavedMark'

export type BrowserPermission = NotificationPermission | 'unsupported'

export interface SettingsBrowserPermissionRowProps {
  /** 권한 상태 */
  perm: BrowserPermission
  /** 상태 문구(허용됨 · 차단됨 · 묻지 않음 · 미지원) */
  permLabel: string
  /** 브라우저 이름 */
  browserName: string
  /** 시험 알림 보내는 중 */
  testing?: boolean
  /** [허용] (perm=default) */
  onAllow?: () => void
  /** [시험 알림] (perm=granted) */
  onTest?: () => void
}

/** 브라우저 알림 권한 행 — 상태 점(허용 online · 차단 dnd · 그 외 offline) */
export function SettingsBrowserPermissionRow({ perm, permLabel, browserName, testing = false, onAllow, onTest }: SettingsBrowserPermissionRowProps) {
  const { t } = useI18n()
  const permStatus = perm === 'granted' ? 'online' : perm === 'denied' ? 'dnd' : 'offline'
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-[13px]">
      <UiStatusDot status={permStatus} size={10} label={permLabel} />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{t('settings.notifications.browserPerm', { status: permLabel })}</b>
        <span className="text-muted-foreground"> · {browserName}</span>
      </span>
      {perm === 'default'
        ? <button type="button" className="font-semibold text-primary hover:underline" onClick={onAllow}>{t('settings.notifications.allow')}</button>
        : perm === 'granted'
          ? <button type="button" className="font-semibold text-primary hover:underline disabled:opacity-50" disabled={testing} onClick={onTest}>{testing ? t('common.sending') : t('settings.notifications.sendTest')}</button>
          : null}
    </div>
  )
}

export interface SettingsDndRowProps {
  /** 일정 요약(null = 불러오기 실패) — when "평일" · time "22:00–08:00" */
  summary: { when: string; time: string } | null
  /** 켜짐 */
  enabled: boolean
  /** 지금 방해 금지 시간 안(켜짐일 때 "지금 적용 중" 배지) */
  activeNow: boolean
  /** "저장됨 ✓" 표시 */
  saved: boolean
  /** 스위치 비활성(불러오기 실패·저장 중) */
  disabled: boolean
  /** 스위치 */
  onToggle: (v: boolean) => void
  /** [바꾸기] */
  onEdit: () => void
}

/** 방해 금지 일정 행 — 스위치는 즉시 저장, 요일·시간은 [바꾸기] 모달 */
export function SettingsDndRow({ summary, enabled, activeNow, saved, disabled, onToggle, onEdit }: SettingsDndRowProps) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">
          {t('settings.notifications.dnd')}
          {enabled && activeNow && <>{' '}<UiBadge tone="warning" tint size={18} className="ml-1">{t('settings.notifications.dndNow')}</UiBadge></>}
        </div>
        <div className="text-[13px] text-muted-foreground">
          {summary
            ? (
              <>
                {summary.when} <span className="font-mono">{summary.time}</span> — {t('settings.notifications.dndDescOn')}{' '}
                <button type="button" className="relative ml-1 font-semibold text-primary hover:underline after:absolute after:-inset-x-2 after:-inset-y-3 after:content-['']" onClick={onEdit}>{t('settings.notifications.dndEdit')}</button>
              </>
            )
            : t('settings.notifications.dndLoadError')}
        </div>
      </div>
      {saved && <SettingsSavedMark />}
      <UiSwitch modelValue={enabled} disabled={disabled} ariaLabel={t('settings.notifications.dnd')} onUpdateModelValue={onToggle} />
    </div>
  )
}

export type NotifyChannel = 'in_app' | 'push' | 'email'
export type NotifyPref = Record<NotifyChannel, boolean>

export interface SettingsNotifyMatrixProps {
  /** 행(알림 종류) — name 600 + desc 12 muted */
  rows: { type: string; name: string; desc: string }[]
  /** 종류별 현재 값 */
  value: (type: string) => NotifyPref
  /** 칸 이름(체크박스 aria) */
  channelLabel: Record<NotifyChannel, string>
  /** 체크 바뀜 */
  onChange: (type: string, channel: NotifyChannel, v: boolean) => void
}

const CHANNELS: NotifyChannel[] = ['in_app', 'push', 'email']

/** 종류 × 채널 체크 표 */
export function SettingsNotifyMatrix({ rows, value, channelLabel, onChange }: SettingsNotifyMatrixProps) {
  const { t } = useI18n()
  return (
    <div role="table" className="text-[13px]">
      <div role="row" className="grid h-9 grid-cols-[1fr_56px_56px_56px] items-center border-b border-border px-4 text-[11px] sm:px-5 font-semibold tracking-[0.06em] text-muted-foreground sm:grid-cols-[1fr_96px_96px_96px]">
        <span role="columnheader">{t('settings.notifications.typeColumn')}</span>
        <span role="columnheader" className="text-center">{t('profile.notifInApp')}</span>
        <span role="columnheader" className="text-center">{t('profile.notifPush')}</span>
        <span role="columnheader" className="text-center">{t('profile.notifEmail')}</span>
      </div>
      {rows.map(r => (
        <div
          key={r.type}
          role="row"
          className="grid min-h-12 grid-cols-[1fr_56px_56px_56px] items-center border-b border-border px-4 last:border-b-0 sm:px-5 sm:grid-cols-[1fr_96px_96px_96px]"
        >
          {/* 좁은 폭에서 "메시/지"처럼 글자 단위로 끊기지 않게 keep-all */}
          <span className="py-1.5 [word-break:keep-all]"><b className="font-semibold text-foreground">{r.name}</b><br /><span className="text-xs text-muted-foreground">{r.desc}</span></span>
          {CHANNELS.map(k => (
            <span key={k} className="grid place-items-center">
              <UiCheckbox modelValue={value(r.type)[k]} ariaLabel={`${r.name} — ${channelLabel[k]}`} onUpdateModelValue={v => onChange(r.type, k, v)} />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

export interface SettingsDndEditModalProps {
  /** 고른 요일(0=월 … 6=일) */
  days: number[]
  /** 시작 HH:MM */
  start: string
  /** 끝 HH:MM */
  end: string
  /** 오류 문구 */
  error: string
  /** 저장 중 */
  busy: boolean
  /** 요일 이름 */
  dayName: (d: number) => string
  /** 요일 칩 누름 */
  onToggleDay: (d: number) => void
  /** 시작 바뀜 */
  onStart: (v: string) => void
  /** 끝 바뀜 */
  onEnd: (v: string) => void
  /** [저장] */
  onSubmit: () => void
  /** 닫기 */
  onClose: () => void
}

/** 방해 금지 일정 바꾸기 모달(시안에 화면 없음 — 기존 폼 규격) */
export function SettingsDndEditModal({ days, start, end, error, busy, dayName, onToggleDay, onStart, onEnd, onSubmit, onClose }: SettingsDndEditModalProps) {
  const { t } = useI18n()
  return (
    <UiModal
      title={t('settings.notifications.dndEditTitle')}
      size="440"
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={busy} onClick={onSubmit}>{busy ? t('settingsCard.saving') : t('common.save')}</UiButton>
        </>
      )}
    >
      <div className="flex flex-col gap-4 text-[13px]">
        <div>
          <div className="mb-1.5 text-xs font-semibold text-foreground">{t('settings.notifications.dndDays')}</div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('settings.notifications.dndDays')}>
            {[0, 1, 2, 3, 4, 5, 6].map(d => (
              <UiChip key={d} label={dayName(d)} modelValue={days.includes(d)} surface="raised" onClick={() => onToggleDay(d)} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <UiInput modelValue={start} onUpdateModelValue={onStart} type="time" label={t('settings.notifications.dndStart')} mono />
          <UiInput modelValue={end} onUpdateModelValue={onEnd} type="time" label={t('settings.notifications.dndEnd')} mono />
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.notifications.dndEditHint')}</p>
        {error && <UiErrorTile title={error} noRetry />}
      </div>
    </UiModal>
  )
}
