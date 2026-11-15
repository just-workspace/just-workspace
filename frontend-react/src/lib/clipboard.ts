/**
 * 클립보드 쓰기 — navigator.clipboard 가 없거나(보안 연결이 아닌 http 접속) 거부되면
 * 숨긴 textarea + execCommand('copy') 로 한 번 더 시도한다. 둘 다 안 되면 throw —
 * 부르는 쪽 try/catch 가 그대로 실패 안내를 띄운다(예전엔 http 에서 TypeError·무음 실패).
 * @example try { await writeClipboard(url); addToast('success', …) } catch { addToast('error', t('common.copyFailed')) }
 */
export async function writeClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch { /* 폴백으로 */ }
  if (!legacyCopy(text)) throw new Error('clipboard unavailable')
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  const prev = document.activeElement as HTMLElement | null
  ta.select()
  let ok: boolean
  try { ok = typeof document.execCommand === 'function' && document.execCommand('copy') } catch { ok = false }
  ta.remove()
  prev?.focus?.()
  return ok
}
