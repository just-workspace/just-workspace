/**
 * 설정 카드.
 * 개인 설정·관리·AI·메일 설정 화면이 공동으로 사용한다(토대 공용).
 *
 * 제목 13/600 + 설명 13 muted, 본문, 푸터 [되돌리기][저장](변경이 있을 때만 활성).
 * 스위치·선택만 있는 행은 푸터 없이 즉시 저장 + "저장됨 ✓"(saved) 를 사용한다. 토스트는 사용하지 않는다.
 * mobileBar: 모바일(md 미만)에서 카드 푸터 대신 화면 하단 고정 저장 바.
 *  · 'save' — [저장] 한 칸. 변경이 없으면 흐림 처리(opacity .5).
 *  · 'full' — [되돌리기][저장 · 변경 n건].
 *  표시되는 동안 하단 탭바는 숨긴다. 한 페이지에 저장 카드가 하나인 경우에만 사용한다.
 * 루트가 둘(카드 + 하단 바)이므로 className 등 나머지 속성은 카드(section)에 적용된다.
 *
 * @example <SettingsCard title="프로필" changes={n} onSave={save} onReset={reset} mobileBar="save">…</SettingsCard>
 */
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { setSharedState } from '~/lib/state'
import { cn } from '~/lib/utils'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'

export interface SettingsCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** 카드 제목 */
  title?: string
  /** 제목 아래 설명 */
  description?: string
  /** 텍스트 필드 카드: 변경 건수. 0 이면 저장 비활성 */
  changes?: number
  /** 푸터 표시 여부(기본: changes 가 정의되어 있으면 표시) */
  footer?: boolean
  /** 저장 중(버튼 비활성 + "저장 중") */
  saving?: boolean
  /** 즉시 저장형 행의 "저장됨 ✓" 표시 */
  saved?: boolean
  /** 본문 패딩 제거(목록·표를 직접 배치하는 경우) */
  flush?: boolean
  /** 위험 구역(빨간 테두리·제목) */
  danger?: boolean
  /** 저장 버튼 문구(기본 i18n settingsCard.save) */
  saveLabel?: string
  /** 모바일 하단 고정 저장 바 — 'save' · 'full' */
  mobileBar?: 'save' | 'full'
  /** 머리 오른쪽 슬롯 */
  header?: ReactNode
  /** [저장] */
  onSave?: () => void
  /** [되돌리기] */
  onReset?: () => void
  children?: ReactNode
}

export function SettingsCard({
  title, description, changes, footer, saving = false, saved = false, flush = false, danger = false,
  saveLabel, mobileBar, header, onSave, onReset, className, children, ...rest
}: SettingsCardProps) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const saveText = saveLabel ?? t('settingsCard.save')
  const hasFooter = footer ?? changes !== undefined
  const barOn = !!mobileBar && hasFooter && isMobile

  // 하단 바가 표시되는 동안 셸 탭바를 숨긴다(MobileDetailBar 와 동일한 신호 mobile-detail-open)
  const barOnRef = useRef(barOn)
  barOnRef.current = barOn
  useEffect(() => { if (barOn) setSharedState('mobile-detail-open', true) }, [barOn])
  useEffect(() => () => { if (barOnRef.current) setSharedState('mobile-detail-open', false) }, [])

  return (
    <>
      <section
        {...rest}
        className={cn('rounded-lg border bg-card text-card-foreground', danger ? 'border-danger/45' : 'border-border', className)}
      >
        {(title || header) && (
          <div className={cn('flex items-start gap-3 px-5 pt-4', flush ? 'pb-3' : '')}>
            <div className="min-w-0 flex-1">
              <h3 className={cn('text-[13px] font-semibold tracking-[0.02em]', danger ? 'text-danger' : 'text-foreground')}>{title}</h3>
              {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
            </div>
            {saved && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-success" role="status">
                <UiIcon name="check" className="h-[13px] w-[13px]" strokeWidth={3} />{t('settingsCard.saved')}
              </span>
            )}
            {header}
          </div>
        )}
        <div className={flush ? '' : 'px-5 py-4'}>{children}</div>
        {hasFooter && !barOn && (
          <div className="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3">
            <span className="mr-auto text-xs text-muted-foreground">{changes ? t('settingsCard.changes', { n: changes }) : t('settingsCard.noChanges')}</span>
            <UiButton variant="outline" size="sm" disabled={!changes || saving} onClick={() => onReset?.()}>{t('settingsCard.reset')}</UiButton>
            <UiButton size="sm" disabled={!changes || saving} onClick={() => onSave?.()}>{saving ? t('settingsCard.saving') : saveText}</UiButton>
          </div>
        )}
      </section>

      {/* 모바일 하단 고정 저장 바 + 본문이 바에 가려지지 않도록 동일 높이의 여백 확보 */}
      {barOn && (
        <>
          <div className="h-[calc(82px+env(safe-area-inset-bottom))] shrink-0" aria-hidden="true" />
          <div
            className="fixed inset-x-0 bottom-0 z-drawer flex gap-2 border-t border-border bg-background px-4 pt-2.5"
            style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}
          >
            {mobileBar === 'full' && (
              <button
                type="button"
                className="flex h-11 items-center justify-center rounded-[12px] border border-border px-[18px] text-sm text-foreground disabled:opacity-50"
                disabled={!changes || saving}
                onClick={() => onReset?.()}
              >{t('settingsCard.reset')}</button>
            )}
            <button
              type="button"
              className="flex h-11 flex-1 items-center justify-center rounded-[12px] bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"
              disabled={!changes || saving}
              onClick={() => onSave?.()}
            >
              {saving ? t('settingsCard.saving') : (mobileBar === 'full' && changes ? t('settingsCard.saveWithChanges', { label: saveText, n: changes }) : saveText)}
            </button>
          </div>
        </>
      )}
    </>
  )
}

export default SettingsCard
