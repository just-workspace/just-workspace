/**
 * 권한 행렬(Settings22 #role-perm · 모바일 #m-role-edit): 묶음 제목 12/600(일반·멤버·텍스트·음성) →
 * 행 = 이름 14/500 + 설명 12 muted + 스위치. 위험 권한은 warning 한 줄(스위치 aria-describedby).
 * 내가 가지지 않은 비트는 남에게 못 준다(서버 _check_grant) — 스위치 잠금 + 이유 한 줄.
 * 모바일: 행 56 이상 · 이름 16 · 설명 13(위험이면 경고 문구가 설명 자리) · 스위치.
 */
import { useId } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiSwitch } from '~/components/ui/Switch'
import { hasBit, withBit, type PermName } from '~/composables/useChatRoles'
import { canGrantBit, type PermGroup } from './settingsLogic'

export interface PermissionMatrixProps {
  groups: PermGroup[]
  value: number
  onChange: (bits: number) => void
  /** 화면 전체 잠금(계층·관리 권한 없음) */
  locked?: boolean
  /** 내 워크스페이스 비트(부여 제한) */
  myBits: number
  isGlobalAdmin: boolean
  mobile?: boolean
}

/** 권한 이름·설명·경고 문구(i18n chat.settings.perms.<NAME>) */
export function usePermText() {
  const { t, te } = useI18n()
  const has = (k: string) => te(k)
  return {
    name: (n: PermName) => (has(`chat.settings.perms.${n}.n`) ? t(`chat.settings.perms.${n}.n`) : n),
    desc: (n: PermName) => (has(`chat.settings.perms.${n}.d`) ? t(`chat.settings.perms.${n}.d`) : ''),
    warn: (n: PermName) => (has(`chat.settings.perms.${n}.w`) ? t(`chat.settings.perms.${n}.w`) : ''),
    group: (k: string) => t(`chat.settings.permGroups.${k}`),
  }
}

export function PermissionMatrix({ groups, value, onChange, locked = false, myBits, isGlobalAdmin, mobile = false }: PermissionMatrixProps) {
  const { t } = useI18n()
  const pt = usePermText()
  const uid = useId()
  return (
    <div className="flex flex-col">
      {groups.map(g => (
        <section key={g.key} aria-labelledby={`${uid}-${g.key}`}>
          <h3 id={`${uid}-${g.key}`} className={cn('font-semibold text-muted-foreground', mobile ? 'px-1 pb-1 pt-4 text-[13px]' : 'pb-1 pt-3 text-[12px]')}>
            {pt.group(g.key)}
          </h3>
          {g.rows.map(r => {
            const on = hasBit(value, r.bit)
            const grantable = canGrantBit(myBits, r.bit, isGlobalAdmin)
            const warn = r.dangerous ? pt.warn(r.name) : ''
            const warnId = `${uid}-w-${r.name}`
            const lockId = `${uid}-l-${r.name}`
            const described = [warn ? warnId : '', !grantable && !locked ? lockId : ''].filter(Boolean).join(' ') || undefined
            const desc = pt.desc(r.name)
            return (
              <div
                key={r.name}
                data-perm={r.name}
                className={cn('flex gap-4 border-b border-border', mobile ? 'min-h-14 items-center px-1 py-1.5' : 'items-start py-2.5')}
              >
                <div className="min-w-0 flex-1">
                  <p className={mobile ? 'text-[16px]' : 'text-[14px] font-medium'}>{pt.name(r.name)}</p>
                  {mobile
                    ? (warn || desc) && <p id={warn ? warnId : undefined} className={cn('text-[13px]', warn ? 'text-warning' : 'text-muted-foreground')}>{warn || desc}</p>
                    : (
                      <>
                        {desc && <p className="text-[12px] text-muted-foreground">{desc}</p>}
                        {warn && (
                          <p id={warnId} className="mt-0.5 flex items-center gap-1 text-[12px] text-warning">
                            <UiIcon name="alert-triangle" className="h-3.5 w-3.5 shrink-0" />{warn}
                          </p>
                        )}
                      </>
                    )}
                  {!grantable && !locked && (
                    <p id={lockId} className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground">
                      <UiIcon name="lock" className="h-3.5 w-3.5 shrink-0" />{t('chat.settings.matrix.cantGrant')}
                    </p>
                  )}
                </div>
                <UiSwitch
                  ariaLabel={pt.name(r.name)}
                  aria-describedby={described}
                  modelValue={on}
                  disabled={locked || !grantable}
                  onUpdateModelValue={v => onChange(withBit(value, r.bit, v))}
                />
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

export default PermissionMatrix
