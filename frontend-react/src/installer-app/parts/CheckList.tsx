/**
 * 점검 항목 목록 — 사전 점검과 네트워크 저장소 연결 확인이 공용하는 카드.
 * 항목마다 상태 아이콘 + 이름·값 + 상태 배지. 해결 방법(detail)이 있는 항목은 펼칠 수 있으며, 주의·실패는 초기부터 펼친 상태로 둔다.
 * 머리 오른쪽에 "통과 5 · 주의 1" 같은 합계를 표시한다.
 */
import type { ReactNode } from 'react'
import { UiBadge, type UiBadgeTone } from '~/components/ui/Badge'
import { UiCard } from '~/components/ui/Card'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiIcon } from '~/components/ui/Icon'
import { cn } from '~/lib/utils'
import { useT } from '../i18n'
import { SubHeading } from '../shell/WizardShell'

export type CheckState = 'pass' | 'warn' | 'fail' | 'checking' | 'wait' | 'skipped'

export interface CheckRow {
  id: string
  label: string
  /** 이름 아래 mono 한 줄(버전·용량·주소) */
  value?: string
  state: CheckState
  /** 펼쳤을 때 표시할 해결 방법·설명 */
  detail?: ReactNode
}

const LOOK: Record<CheckState, { icon: string; color: string; tone: UiBadgeTone; bg: string }> = {
  pass: { icon: 'check', color: 'text-success', tone: 'success', bg: '' },
  warn: { icon: 'alert-triangle', color: 'text-warning', tone: 'warning', bg: 'bg-warning/10' },
  fail: { icon: 'alert-circle', color: 'text-danger', tone: 'danger', bg: 'bg-danger/10' },
  checking: { icon: 'loader', color: 'text-muted-foreground', tone: 'neutral', bg: '' },
  wait: { icon: 'clock', color: 'text-muted-foreground', tone: 'neutral', bg: '' },
  skipped: { icon: 'minus', color: 'text-muted-foreground', tone: 'neutral', bg: '' },
}
const TALLY: CheckState[] = ['pass', 'warn', 'fail', 'checking']

export function tallyText(rows: CheckRow[], t: (key: string) => string): string {
  return TALLY
    .map(k => [k, rows.filter(r => r.state === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${t(`status.${k}`)} ${n}`)
    .join(' · ')
}

export function CheckList({ title, rows, headerExtra }: { title: string; rows: CheckRow[]; headerExtra?: ReactNode }) {
  const t = useT()
  return (
    <UiCard className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <SubHeading>{title}</SubHeading>
        <span className="flex items-center gap-3 text-[13px] text-muted-foreground">
          <span>{tallyText(rows, t)}</span>
          {headerExtra}
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {rows.map(r => {
          const look = LOOK[r.state]
          const alert = r.state === 'warn' || r.state === 'fail'
          return (
            <li key={r.id} data-state={r.state} className={cn('border-t border-border', look.bg)}>
              <UiDisclosure
                // 상태 변경 시 펼침 기본값을 재결정한다(통과 → 실패로 바뀐 항목은 펼쳐서 표시)
                key={`${r.state}:${r.detail ? 1 : 0}`}
                variant="row"
                strong={alert}
                collapsible={!!r.detail}
                defaultOpen={alert}
                title={r.label}
                description={r.value ? <span className="font-mono">{r.value}</span> : undefined}
                leading={<span className={look.color}><UiIcon name={look.icon} aria-hidden="true" strokeWidth={2.4} className={cn('size-[18px]', r.state === 'checking' && 'animate-spin motion-reduce:animate-none')} /></span>}
                trailing={<UiBadge tone={look.tone} tint size={18}>{t(`status.${r.state}`)}</UiBadge>}
              >
                <p className="m-0 pb-3.5 pl-[46px] pr-4 text-[13px] text-muted-foreground">{r.detail}</p>
              </UiDisclosure>
            </li>
          )
        })}
      </ul>
    </UiCard>
  )
}
