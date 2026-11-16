/**
 * 저장소 언어 막대("언어" + 점 8 · "Vue 58%").
 * 색은 시안 순서 primary · success · warning. 네 번째 언어부터는 하나로 묶어 "기타"(muted-foreground).
 * 0% 로 반올림되는 매우 작은 언어도 "기타"에 포함한다(막대에 보이지 않는 칸이 생기지 않도록).
 */
export type LanguageTone = 'primary' | 'success' | 'warning' | 'muted'

export interface LanguageSegment {
  name: string
  percent: number
  tone: LanguageTone
}

const TONES: LanguageTone[] = ['primary', 'success', 'warning']

export function languageSegments(langs: ReadonlyArray<{ name: string; percent: number }>, otherLabel: string): LanguageSegment[] {
  const sorted = [...langs].filter(l => l.percent > 0).sort((a, b) => b.percent - a.percent)
  const out: LanguageSegment[] = []
  let rest = 0
  sorted.forEach((l, i) => {
    if (i < TONES.length && l.percent >= 1) out.push({ name: l.name, percent: l.percent, tone: TONES[i] })
    else rest += l.percent
  })
  rest = Math.round(rest * 10) / 10
  if (rest > 0) out.push({ name: otherLabel, percent: rest, tone: 'muted' })
  return out
}
