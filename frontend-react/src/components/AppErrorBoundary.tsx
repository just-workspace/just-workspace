/**
 * 렌더 오류 경계.
 * 오류를 콘솔에 기록하고 토스트로 표시한다. 경계 내부 영역에는 오류 타일([다시 시도]·[홈으로])을 렌더링한다 —
 * 이전에는 영역을 비워 두기만 하여 빈 화면에 토스트 하나만 남았고, 셸에서 발생하면 메뉴도 없어 새로고침 외에 방법이 없었다.
 * 주소(경로·쿼리)가 변경되면 경계를 초기화한다 — resetKey. 원문 오류 메시지는 콘솔에만 기록한다(사용자에게는 본 프로젝트 문구 표시).
 *
 *   scope="app"    → 문구 error.unexpectedError (앱 루트)
 *   scope="layout" → 문구 error.renderError (기본 레이아웃)
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { i18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { UiErrorTile } from '~/components/ui/ErrorTile'

interface Props { scope: 'app' | 'layout'; children: ReactNode; resetKey?: string }
interface State { failed: boolean }

class Boundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(err: Error, _info: ErrorInfo) {
    if (this.props.scope === 'app') {
      console.error('[Global Error Boundary]', err)
      addToast('error', i18n.t('error.unexpectedError'))
    } else {
      console.error('[Layout Error]', err)
      addToast('error', i18n.t('error.renderError'))
    }
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  override render() {
    if (!this.state.failed) return this.props.children
    const app = this.props.scope === 'app'
    return (
      <UiErrorTile
        placement="page"
        title={i18n.t(app ? 'error.unexpectedError' : 'error.renderError')}
        onRetry={() => this.setState({ failed: false })}
        secondaryLabel={i18n.t('error.goHome')}
        // 셸 전체가 중단되었을 수 있으므로 라우터 이동이 아닌 전체 재로드를 수행한다
        onSecondary={() => { window.location.assign('/') }}
      />
    )
  }
}

export function AppErrorBoundary({ scope, children }: { scope: 'app' | 'layout'; children: ReactNode }) {
  const loc = useLocation()
  return <Boundary scope={scope} resetKey={loc.pathname + loc.search}>{children}</Boundary>
}
