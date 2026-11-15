/**
 * 복사 버튼 — 누르면 글자를 클립보드에 넣고 결과를 짧게 알린다.
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
