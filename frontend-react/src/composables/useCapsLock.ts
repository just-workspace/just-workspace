/**
 * Caps Lock 감지: 비밀번호 입력의 onKeyDown/onKeyUp 에 onKey 를 연결하면 활성 여부를 반환한다.
 * 포커스 이탈 시(blur) reset 으로 힌트를 해제한다 — 다른 입력에서 Caps Lock 을 활성화한 채 복귀해도 다음 키 입력에서 재판정한다.
 *
 * 싱글턴이 아니다 — 호출마다 독립된 지역 상태(store 없이 hook 하나).
 * React: const { capsLock, onKey, reset } = useCapsLock()   (capsLock 은 boolean)
 */
import { useCallback, useState } from 'react'

export function useCapsLock() {
  const [capsLock, setCapsLock] = useState(false)

  /** DOM KeyboardEvent 와 React 합성 키 이벤트를 모두 수용한다 */
  const onKey = useCallback((e: { getModifierState?: (key: 'CapsLock') => boolean }) => {
    if (typeof e.getModifierState !== 'function') return
    setCapsLock(e.getModifierState('CapsLock'))
  }, [])

  const reset = useCallback(() => { setCapsLock(false) }, [])

  return { capsLock, onKey, reset }
}
