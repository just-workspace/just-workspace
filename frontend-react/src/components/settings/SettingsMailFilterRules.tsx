/**
 * 설정 › 메일 › 필터 탭 — Vue 는 메일 모듈의 components/mail/MailFilterRules.vue 를 그대로 끼운다(@count 로 탭 숫자 갱신).
 *
 * @example <SettingsMailFilterRules onCount={setFilterCount} />
 */
import { MailFilterRules } from '~/components/mail/MailFilterRules'

export interface SettingsMailFilterRulesProps {
  /** 규칙 수가 바뀔 때(Vue emit('count', n)) */
  onCount?: (n: number) => void
}

export function SettingsMailFilterRules({ onCount }: SettingsMailFilterRulesProps) {
  return <MailFilterRules onCount={onCount} />
}

export default SettingsMailFilterRules
