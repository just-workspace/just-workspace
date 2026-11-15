/**
 * v2(React) 플러그인용 호스트 UI 키트 — window.__WS_UI__ (작성법: docs/plugin-v2.md "7. 호스트 UI 키트").
 * 플러그인 번들은 react 와 함께 이 키트를 external 로 두고(가상 모듈 '@jw/ui' → window.__WS_UI__) 호스트와 같은 부품을 쓴다.
 * 같은 React 인스턴스·같은 토큰 CSS 라 모양·동작이 호스트 화면과 똑같다.
 *
 * 들어 있는 것: Ui* 부품 전부(셸 전용 UiToast·UiDialogHost 제외 — 호스트가 이미 그린다) + useToast·toast·addToast + useDialog·confirmBox·alertBox·promptBox·choose
 * + useUiMentionList.
 * 키를 빼거나 props 를 깨는 변경은 플러그인을 깨므로 version 을 올리고 docs 에 적는다(더하기는 version 그대로).
 */
import { UiActionSheet } from '~/components/ui/ActionSheet'
import { UiAppRail } from '~/components/ui/AppRail'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCard } from '~/components/ui/Card'
import { UiCardContent } from '~/components/ui/CardContent'
import { UiCardHeader } from '~/components/ui/CardHeader'
import { UiCardTitle } from '~/components/ui/CardTitle'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiChip } from '~/components/ui/Chip'
import { UiEditorToolbar } from '~/components/ui/EditorToolbar'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiFab } from '~/components/ui/Fab'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiInput } from '~/components/ui/Input'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiMentionList, useUiMentionList } from '~/components/ui/MentionList'
import { UiMenu } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiRadio } from '~/components/ui/Radio'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSegment } from '~/components/ui/Segment'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiSplitButton } from '~/components/ui/SplitButton'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiSwitch } from '~/components/ui/Switch'
import { UiTabbar } from '~/components/ui/Tabbar'
import { UiTabs } from '~/components/ui/Tabs'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiTooltip } from '~/components/ui/Tooltip'
import { UiTopbar } from '~/components/ui/Topbar'
import { UiTrans } from '~/components/ui/Trans'
import { useToast, toast, addToast, removeToast } from '~/composables/useToast'
import { useDialog, alertBox, confirmBox, promptBox, choose } from '~/composables/useDialog'

export const wsUiKit = {
  /** 키트 계약 버전 — 키를 빼거나 props 를 깨면 올린다 */
  version: 1 as const,
  UiActionSheet, UiAppRail, UiAvatar, UiBadge, UiButton, UiCard, UiCardContent, UiCardHeader, UiCardTitle,
  UiCheckbox, UiChip, UiEditorToolbar, UiEmptyState, UiErrorTile, UiFab, UiIcon, UiIconButton, UiInput, UiKeycap,
  UiMentionList, UiMenu, UiModal, UiPasswordInput, UiRadio, UiRadioCard, UiSegment, UiSelect, UiSkeleton, UiSplitButton,
  UiStatusDot, UiSwitch, UiTabbar, UiTabs, UiTextarea, UiTooltip, UiTopbar, UiTrans,
  useUiMentionList,
  // 토스트(행동 1개형: toast({ title, description, action: { label, onClick } }) — 6초)
  useToast, toast, addToast, removeToast,
  // 확인·입력 대화상자(Promise)
  useDialog, alertBox, confirmBox, promptBox, choose,
}

export type WsUiKit = typeof wsUiKit
