/**
 * 렌더 오류 경계 — Vue 판 app.vue / layouts/default.vue 의 onErrorCaptured 대응.
 * 오류를 콘솔에 남기고 토스트로 알린다. 경계 안쪽 자리에는 오류 타일([다시 시도]·[홈으로])을 그린다 —
 * 예전에는 비워 두기만 해서 빈 화면에 토스트 하나만 남았고, 셸에서 나면 메뉴도 없어 새로고침뿐이었다.
 * 주소(경로·쿼리)가 바뀌면 경계를 다시 연다 — resetKey. 원문 오류 메시지는 콘솔에만(사용자에겐 우리 문구).
 *
 *   scope="app"    → 문구 error.unexpectedError (app.vue)
 *   scope="layout" → 문구 error.renderError (layouts/default.vue)
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
        // 셸째 죽었을 수 있다 — 라우터 이동이 아니라 새로 불러온다
        onSecondary={() => { window.location.assign('/') }}
      />
    )
  }
}

export function AppErrorBoundary({ scope, children }: { scope: 'app' | 'layout'; children: ReactNode }) {
  const loc = useLocation()
  return <Boundary scope={scope} resetKey={loc.pathname + loc.search}>{children}</Boundary>
}
