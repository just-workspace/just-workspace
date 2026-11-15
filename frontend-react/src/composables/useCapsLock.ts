/**
 * Caps Lock 감지: 비밀번호 입력의 onKeyDown/onKeyUp 에 onKey 를 붙이면 켜짐 여부를 돌려준다.
 * 포커스가 빠지면(blur) reset 으로 힌트를 내린다 — 다른 입력에서 Caps Lock 을 켜 둔 채 돌아와도 다음 키 입력에 다시 판단.
 *
 * Vue 판은 부를 때마다 새 ref 를 만드는 지역 상태라(싱글턴 아님) React 에서는 store 없이 hook 하나다.
 * React: const { capsLock, onKey, reset } = useCapsLock()   (capsLock 은 boolean — Vue 의 capsLock.value)
 */
import { useCallback, useState } from 'react'

export function useCapsLock() {
  const [capsLock, setCapsLock] = useState(false)

  /** DOM KeyboardEvent 와 React 합성 키 이벤트 둘 다 받는다 */
  const onKey = useCallback((e: { getModifierState?: (key: 'CapsLock') => boolean }) => {
    if (typeof e.getModifierState !== 'function') return
    setCapsLock(e.getModifierState('CapsLock'))
  }, [])

  const reset = useCallback(() => { setCapsLock(false) }, [])

  return { capsLock, onKey, reset }
}
