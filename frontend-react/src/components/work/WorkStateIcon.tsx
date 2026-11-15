/**
 * 상태 아이콘:
 * 열림 = 원+점 · 닫힘 = 원+체크 · 병합 = 가지 · 진행 중 = 반원.
 * 색은 부모 글자색(currentColor). 이슈 행 앞 16px 아이콘도 이것을 쓴다. 그림은 공용 세트(utils/icons.ts).
 */
import type { SVGAttributes } from 'react'
import { UiIcon } from '~/components/ui/Icon'

export type WorkState = 'open' | 'closed' | 'merged' | 'progress'

const NAME = { open: 'issue-open', closed: 'issue-closed', merged: 'git-merge', progress: 'issue-draft' } as const

export interface WorkStateIconProps extends Omit<SVGAttributes<SVGSVGElement>, 'name'> {
  /** 열림 · 닫힘 · 병합 · 진행 중 */
  state: WorkState
}

/** 작업 상태 아이콘(열림·닫힘·병합·진행 중). 크기는 className 으로 */
export function WorkStateIcon({ state, ...rest }: WorkStateIconProps) {
  return <UiIcon {...rest} name={NAME[state] ?? 'issue-draft'} strokeWidth={2.5} />
}

export default WorkStateIcon
