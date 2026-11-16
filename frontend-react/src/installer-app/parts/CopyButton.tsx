/**
 * 복사 버튼 — 클릭 시 문자열을 클립보드에 복사하고 결과를 짧게 통지한다.
 */
import { UiIconButton } from '~/components/ui/IconButton'
import { addToast } from '~/composables/useToast'
import { writeClipboard } from '~/lib/clipboard'
import { useT } from '../i18n'

export function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT()
  async function copy() {
    try {
      await writeClipboard(text)
      addToast('success', t('common.copied'))
    } catch {
      addToast('error', t('common.copyFailed'), 4000)
    }
  }
  return <UiIconButton label={label} icon="copy" onClick={() => { void copy() }} />
}
