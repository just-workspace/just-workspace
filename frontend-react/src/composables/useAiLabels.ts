// AI 화면 이름표 — 도구·도구 묶음 이름은 서버가 전달한 식별자를 번역표로 변환하고, 표에 없으면 식별자를 그대로 표시한다.
import { useMemo } from 'react'
import { useI18n } from '~/i18n'
import { aiToolGroupKey, aiToolGroups } from '~/utils/aiAssist'

export function useAiLabels() {
  const { t, te } = useI18n()
  return useMemo(() => {
    function toolLabel(name: string): string {
      const k = `ai.tools.${name}`
      return te(k) ? t(k) : name
    }

    function toolGroupLabel(key: string): string {
      const k = `ai.toolGroups.${key}`
      return te(k) ? t(k) : key
    }

    /** 도구 이름 목록 → 묶음 + 이름표 */
    function labelledGroups(names: string[]) {
      return aiToolGroups(names).map(g => ({ ...g, label: toolGroupLabel(g.key) }))
    }

    return { toolLabel, toolGroupLabel, labelledGroups, aiToolGroupKey }
  }, [t, te])
}
