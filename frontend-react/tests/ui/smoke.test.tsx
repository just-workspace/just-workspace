// UI 키트 33개 렌더 스모크 — 필수 props 만 지정하여 크래시 없이 렌더링되는지 검증
import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import { screen } from '@testing-library/react'
import { renderInRouter } from './helpers'

import { UiActionSheet } from '~/components/ui/ActionSheet'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCard } from '~/components/ui/Card'
import { UiCardContent } from '~/components/ui/CardContent'
import { UiCardHeader } from '~/components/ui/CardHeader'
import { UiCardTitle } from '~/components/ui/CardTitle'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiChip } from '~/components/ui/Chip'
import { UiDialogHost } from '~/components/ui/DialogHost'
import { UiEditorToolbar } from '~/components/ui/EditorToolbar'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiFab } from '~/components/ui/Fab'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiInput } from '~/components/ui/Input'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiMenu } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiRadio } from '~/components/ui/Radio'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSegment } from '~/components/ui/Segment'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiSwitch } from '~/components/ui/Switch'
import { UiTabs } from '~/components/ui/Tabs'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiToast } from '~/components/ui/Toast'
import { UiTooltip } from '~/components/ui/Tooltip'

const items = [{ key: 'a', label: '가' }, { key: 'b', label: '나', danger: true, separated: true }]

const CASES: Array<[string, () => ReactElement]> = [
  ['UiActionSheet', () => <UiActionSheet label="시트" title="제목" items={items} />],
  ['UiAvatar', () => <UiAvatar fallback="김" />],
  ['UiBadge', () => <UiBadge>3</UiBadge>],
  ['UiButton', () => <UiButton>버튼</UiButton>],
  ['UiCard', () => <UiCard>카드</UiCard>],
  ['UiCardContent', () => <UiCardContent>본문</UiCardContent>],
  ['UiCardHeader', () => <UiCardHeader>머리</UiCardHeader>],
  ['UiCardTitle', () => <UiCardTitle>제목</UiCardTitle>],
  ['UiCheckbox', () => <UiCheckbox label="체크" />],
  ['UiChip', () => <UiChip label="칩" count={2} removable />],
  ['UiDialogHost', () => <UiDialogHost />],
  ['UiEditorToolbar', () => <UiEditorToolbar editor={null} />],
  ['UiEmptyState', () => <UiEmptyState title="비어 있음" description="설명" actionLabel="만들기" actionTo="/x" />],
  ['UiErrorTile', () => <UiErrorTile title="실패" detail="500" />],
  ['UiFab', () => <UiFab label="새로" />],
  ['UiIcon', () => <UiIcon name="close" />],
  ['UiIconButton', () => <UiIconButton label="닫기" icon="close" />],
  ['UiInput', () => <UiInput label="이름" hint="도움말" />],
  ['UiKeycap', () => <UiKeycap>K</UiKeycap>],
  ['UiMenu', () => <UiMenu items={items} />],
  ['UiModal', () => <UiModal title="모달">본문</UiModal>],
  ['UiPasswordInput', () => <UiPasswordInput label="비밀번호" />],
  ['UiRadio', () => <UiRadio value="a" label="가" />],
  ['UiRadioCard', () => <UiRadioCard value="a" title="가" meta="32" />],
  ['UiSegment', () => <UiSegment items={[{ value: 'm', label: '월' }, { value: 'w', label: '주' }]} />],
  ['UiSelect', () => <UiSelect options={[{ value: 1, label: '하나' }]} label="선택" />],
  ['UiSkeleton', () => <UiSkeleton preset="list" />],
  ['UiStatusDot', () => <UiStatusDot status="online" />],
  ['UiSwitch', () => <UiSwitch label="알림" />],
  ['UiTabs', () => <UiTabs items={[{ key: 'a', label: '전체' }]} />],
  ['UiTextarea', () => <UiTextarea label="설명" />],
  ['UiToast', () => <UiToast />],
  ['UiTooltip', () => <UiTooltip text="팁"><button type="button">트리거</button></UiTooltip>],
]

describe('UI 키트 렌더 스모크', () => {
  it('33개 전부 있다', () => {
    expect(CASES.length).toBe(33)
  })

  it.each(CASES)('%s 가 크래시 없이 그려진다', (_name, make) => {
    expect(() => renderInRouter(make())).not.toThrow()
  })

  it('변형도 그려진다(EmptyState·ErrorTile·Skeleton·EditorToolbar 모바일)', () => {
    renderInRouter(
      <div>
        <UiEmptyState variant="panel" title="패널" />
        <UiEmptyState variant="inline" title="한 줄" actionLabel="추가" />
        <UiErrorTile placement="panel" title="패널 오류" />
        <UiErrorTile placement="page" title="페이지 오류" retryVariant="outline" secondaryLabel="상태" />
        {(['card', 'table', 'grid', 'text'] as const).map(p => <UiSkeleton key={p} preset={p} />)}
        <UiSkeleton className="h-4" />
        <UiEditorToolbar editor={null} variant="mobile" end={<span>서명</span>} />
        <UiModal confirm title="확인형" footer={<button type="button">확인</button>}>본문</UiModal>
      </div>,
    )
    expect(screen.getByText('패널 오류')).toBeTruthy()
    expect(screen.getByText('서명')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('확인형')
  })
})
