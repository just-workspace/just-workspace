/**
 * 모델 피커 내용:
 *  묶음 머리(11/600 · 0.08em, 10 14 4) "워크스페이스 제공" / "내 API 키"
 *  · 옵션 min 48(이름 600 + 설명 12 muted · 선택 ✓ primary) · 선 아래 "이 대화에서 사용할 도구" + 행 40(이름 + 스위치).
 * 모델·도구 이름은 서버 응답(/api/ai/status)을 그대로 표시한다. 대화별 모델 전환은 백엔드 미지원이므로 현재 사용 중인 쪽만 선택할 수 있다.
 * 도구는 대화별 활성화/비활성화 하나뿐이므로 묶음 스위치가 함께 연동된다(백엔드 갭).
 */
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { useAiLabels } from '~/composables/useAiLabels'
import { UiIcon } from '~/components/ui/Icon'
import { UiSwitch } from '~/components/ui/Switch'
import type { AiStatus } from '~/utils/aiAssist'

export interface AiModelPickerProps {
  /** /api/ai/status 응답 */
  status: AiStatus
  /** 이 대화의 도구 활성화 여부 */
  toolsEnabled: boolean
  /** 루트에 추가할 클래스 */
  className?: string
  /** 도구 활성화/비활성화 */
  onToggleTools?: (on: boolean) => void
  /** 닫기(개인 키 설정으로 이동 시) */
  onClose?: () => void
}

export function AiModelPicker({ status, toolsEnabled, className, onToggleTools, onClose }: AiModelPickerProps) {
  const { t } = useI18n()
  const { labelledGroups } = useAiLabels()

  const personal = !!status.using_personal
  const wsName = (personal ? status.workspace_model : status.model) || t('ai.picker.workspace')
  const wsDesc = personal ? t('ai.picker.wsShared') : status.external ? t('ai.picker.wsExternal') : t('ai.picker.wsLocal')
  const toolGroups = labelledGroups(status.tools ?? [])

  function goPersonal() {
    onClose?.()
    void navigateTo('/settings/ai')
  }

  return (
    <div className={cn('text-[13px]', className)}>
      <div role="listbox" aria-label={t('ai.picker.label')}>
        <div role="group" aria-label={t('ai.picker.workspace')}>
          <div className="px-3.5 pb-1 pt-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground" aria-hidden="true">{t('ai.picker.workspace')}</div>
          <div role="option" aria-selected={!personal} aria-disabled={personal} className={cn('flex min-h-12 items-center gap-2.5 px-3.5', personal ? 'opacity-60' : '')}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-foreground">{wsName}</div>
              <div className="text-xs text-muted-foreground">{wsDesc}</div>
            </div>
            {!personal && <UiIcon name="check" className="h-[15px] w-[15px] shrink-0 text-primary" />}
          </div>
        </div>
        {status.allow_user_keys && (
          <div role="group" aria-label={t('ai.picker.personal')}>
            <div className="px-3.5 pb-1 pt-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground" aria-hidden="true">{t('ai.picker.personal')}</div>
            {personal ? (
              <div role="option" aria-selected="true" className="flex min-h-12 items-center gap-2.5 px-3.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-foreground">{status.model}</div>
                  <div className="text-xs text-muted-foreground">{t('ai.picker.personalDesc')}</div>
                </div>
                <UiIcon name="check" className="h-[15px] w-[15px] shrink-0 text-primary" />
              </div>
            ) : (
              <button type="button" role="option" aria-selected="false" className="flex min-h-12 w-full items-center gap-2.5 px-3.5 text-left hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-hidden" onClick={goPersonal}>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-foreground">{t('ai.picker.personalEmpty')}</div>
                  <div className="text-xs text-muted-foreground">{t('ai.picker.personalSetup')}</div>
                </div>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border px-3.5 pb-1 pt-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('ai.picker.tools')}</div>
      {toolGroups.map(g => (
        <div key={g.key} className="flex h-10 items-center gap-2.5 px-3.5">
          <span className="flex-1 truncate text-foreground">{g.label}</span>
          <UiSwitch modelValue={toolsEnabled} ariaLabel={g.label} className="min-h-0" onUpdateModelValue={(v: boolean) => onToggleTools?.(v)} />
        </div>
      ))}
      {!toolGroups.length && <p className="px-3.5 pb-3 pt-1 text-xs text-muted-foreground">{t('ai.picker.noTools')}</p>}
    </div>
  )
}

export default AiModelPicker
